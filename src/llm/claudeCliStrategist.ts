// サブスク(Claude Code OAuth)で動く strategist。Agent SDK の query() ではなく
// `claude -p`(print モード)を直接 spawn する。
//
// なぜ SDK でなく CLI か: Agent SDK の query() は Claude Code セッションの中(別ターミナル
// でも)で stream-json 制御モードの nested 検出に引っかかり無限ハングする。一方 `claude -p`
// は同じ環境でも普通に動く(実測)。CLI には set_strategy MCP ツールが無いので、戦略は
// 生 JSON で出力させ、parseStrategyFromToolInput で検証する。API key 不要。
import { spawn } from "node:child_process";
import type { AgentObservation } from "../types.js";
import type { RoundRecord } from "./history.js";
import {
  buildInitMessage,
  buildReviseMessage,
  SIM_RULES,
  SYSTEM_PROMPT,
  type Phase,
  type ReviseReason,
} from "./prompts.js";
import { parseStrategyFromToolInput, type Strategy } from "./strategy.js";
import type {
  ClaudeCallMeta,
  Strategist,
  StrategyResult,
} from "./claudeStrategist.js";

const DEFAULT_MODEL = "sonnet"; // alias → claude-sonnet-4-6

// 戦略生成は ~60-90s かかる(コード生成のため)。背景実行なので余裕を持たせる。
const CALL_TIMEOUT_MS = (() => {
  const v = Number(process.env.ERIS_LLM_CALL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 180_000;
})();

// CLI モードには set_strategy ツールが無いので、生 JSON 出力を指示する追加 system。
const CLI_OUTPUT_CONTRACT = `

## Output (CLI mode — IMPORTANT)
There is NO set_strategy tool available here. Respond with ONLY a single JSON object —
no markdown code fences, no commentary before or after — of exactly this shape:
{"notes": "<markdown rationale>", "params": { <numeric/boolean params> }, "executor_ts": "<function body that returns an AgentAction>",
 "change_type": "params_only" | "executor_logic", "hypothesis": "<expected improvement, grounded in attribution>",
 "rollback_condition": "<evidence that would mean this change failed>", "why_executor_change": "<required only if executor_logic: cite the concrete failure in the round log>"}
Default change_type to "params_only" (the previous executor is kept; only your params apply). Set "executor_logic"
ONLY when the round log shows a concrete failure that forces a rewrite. This is the simulator's expected,
legitimate strategist output. The executor_ts body runs in a sandboxed vm (no network, no filesystem).`;

// Claude Code 組み込みツールは戦略生成に不要。print モードでツール使用待ちのハングを避けるため無効化。
const DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Read",
  "Write",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "SlashCommand",
  "TodoWrite",
  "BashOutput",
  "KillShell",
  "NotebookEdit",
];

// 入れ子 Claude Code セッションのマーカー(claudeSubscriptionStrategist と同じ意図)。
function isNestedSessionMarker(key: string): boolean {
  return (
    key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE" || key === "AI_AGENT"
  );
}

// テスト用に spawn を差し替えられるよう最小インターフェースで型付け。
export type ChildLike = {
  stdout: { on(ev: "data", cb: (chunk: unknown) => void): void };
  stderr: { on(ev: "data", cb: (chunk: unknown) => void): void };
  on(ev: "close", cb: (code: number | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  kill(signal?: string): void;
};
export type SpawnLike = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
) => ChildLike;

const REAL_SPAWN: SpawnLike = (command, args, options) =>
  spawn(command, args, options) as unknown as ChildLike;

// モデル応答テキストから最初の balanced な JSON オブジェクトを取り出す。
// executor_ts はコード(中括弧・クォート入り)なので、文字列/エスケープを尊重して走査する。
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export class ClaudeCliStrategist implements Strategist {
  private model: string;
  private bin: string;
  private spawnFn: SpawnLike;

  constructor(
    opts: { model?: string; bin?: string; spawnFn?: SpawnLike } = {},
  ) {
    this.model = opts.model ?? process.env.ERIS_LLM_MODEL ?? DEFAULT_MODEL;
    this.bin = opts.bin ?? process.env.ERIS_CLAUDE_BIN ?? "claude";
    this.spawnFn = opts.spawnFn ?? REAL_SPAWN;
  }

  async init(obs: AgentObservation, version: number): Promise<StrategyResult> {
    return this.call("init", buildInitMessage(obs), version);
  }

  async revise(
    prev: Strategy,
    history: RoundRecord[],
    reason: ReviseReason,
    initialUsd: number,
    currentUsd: number,
    version: number,
  ): Promise<StrategyResult> {
    return this.call(
      "revise",
      buildReviseMessage(prev, history, reason, initialUsd, currentUsd),
      version,
      prev,
    );
  }

  private call(
    phase: Phase,
    userMessage: string,
    version: number,
    prev?: Strategy,
  ): Promise<StrategyResult> {
    const started = Date.now();
    const meta = (): ClaudeCallMeta => ({
      phase,
      latencyMs: Date.now() - started,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (isNestedSessionMarker(key)) delete env[key];
    }

    const system = `${SYSTEM_PROMPT}\n\n${SIM_RULES}${CLI_OUTPUT_CONTRACT}`;
    const args = [
      "-p",
      userMessage,
      "--model",
      this.model,
      "--permission-mode",
      "bypassPermissions",
      "--append-system-prompt",
      system,
      "--disallowed-tools",
      ...DISALLOWED_TOOLS,
    ];

    return new Promise<StrategyResult>((resolve) => {
      let out = "";
      let err = "";
      let done = false;
      const finish = (r: StrategyResult): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };

      const child = this.spawnFn(this.bin, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => {
        out += String(d);
      });
      child.stderr.on("data", (d) => {
        err += String(d);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          ok: false,
          reason: `claude -p timed out after ${CALL_TIMEOUT_MS}ms`,
          meta: meta(),
        });
      }, CALL_TIMEOUT_MS);
      timer.unref?.();

      child.on("error", (e: Error) =>
        finish({
          ok: false,
          reason: `spawn failed: ${e.message}`,
          meta: meta(),
        }),
      );
      child.on("close", (code: number | null) => {
        if (code !== 0) {
          return finish({
            ok: false,
            reason: `claude -p exited ${code}: ${err.slice(0, 200)}`,
            meta: meta(),
          });
        }
        const json = extractJsonObject(out);
        if (json === null) {
          return finish({
            ok: false,
            reason: `no JSON object in claude output: ${out.slice(0, 200)}`,
            meta: meta(),
          });
        }
        const parsed = parseStrategyFromToolInput(json, version, prev);
        if (!parsed.ok) {
          return finish({ ok: false, reason: parsed.reason, meta: meta() });
        }
        finish({ ok: true, strategy: parsed.strategy, meta: meta() });
      });
    });
  }
}
