// Codex CLI(`codex exec`)で動く strategist。ClaudeCliStrategist の codex 版。
//
// なぜ codex も用意するか: codex は Claude とは別の API プールなので、claude -p のレート/並走と
// 競合しない。Claude 自己改善 agent と Codex 自己改善 agent を混成すると、自己改善の並走上限を
// 実質引き上げられ、かつ「どの LLM が自己改善で強いか」を同一市場で測れる。
//
// 実測(PoC): `codex exec - -s read-only` は stdout に純粋な JSON のみを返し(前置き/フェンス無し)、
// レイテンシ ~64s(claude -p より速い)。出力契約と parse は claude CLI 版と共通化する。
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
import {
  extractJsonObject,
  type ChildLike,
  type SpawnLike,
} from "./claudeCliStrategist.js";
import type {
  ClaudeCallMeta,
  Strategist,
  StrategyResult,
} from "./claudeStrategist.js";

// codex の応答待ち。コード生成のため余裕を持たせる(claude 版と同じ env を共有)。
const CALL_TIMEOUT_MS = (() => {
  const v = Number(process.env.ERIS_LLM_CALL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 180_000;
})();

// codex には set_strategy ツールも --append-system-prompt も無い。system をプロンプト先頭に畳み、
// 生 JSON だけを返させる(claude CLI 版と同一契約)。
const CLI_OUTPUT_CONTRACT = `

## Output (codex exec mode — IMPORTANT)
Respond with ONLY a single JSON object — no markdown code fences, no commentary before or after — of exactly this shape:
{"notes": "<markdown rationale>", "params": { <numeric/boolean params> }, "executor_ts": "<function body that returns an AgentAction>",
 "change_type": "params_only" | "executor_logic", "hypothesis": "<expected improvement, grounded in attribution>",
 "rollback_condition": "<evidence that would mean this change failed>", "why_executor_change": "<required only if executor_logic: cite the concrete failure in the round log>"}
Default change_type to "params_only" (the previous executor is kept; only your params apply). Set "executor_logic"
ONLY when the round log shows a concrete failure that forces a rewrite. Do NOT use any tools, do NOT read or write files —
just emit the JSON object. The executor_ts body runs in a sandboxed vm (no network, no filesystem).`;

const REAL_SPAWN: SpawnLike = (command, args, options) =>
  spawn(command, args, options) as unknown as ChildLike;

export class CodexCliStrategist implements Strategist {
  private model: string | undefined;
  private bin: string;
  private spawnFn: SpawnLike;

  constructor(
    opts: { model?: string; bin?: string; spawnFn?: SpawnLike } = {},
  ) {
    // 既定はモデル未指定 = codex の config.toml の既定モデルに従う(環境差で壊れないため)。
    this.model =
      opts.model ?? process.env.ERIS_CODEX_MODEL ?? process.env.ERIS_LLM_MODEL;
    this.bin = opts.bin ?? process.env.ERIS_CODEX_BIN ?? "codex";
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

    // codex は --append-system-prompt が無いので system + 契約 + user を 1 プロンプトに畳む。
    const prompt = `${SYSTEM_PROMPT}\n\n${SIM_RULES}${CLI_OUTPUT_CONTRACT}\n\n---\n\n${userMessage}`;
    const args = [
      "exec",
      prompt,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      ...(this.model ? ["--model", this.model] : []),
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
        env: { ...process.env },
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
          reason: `codex exec timed out after ${CALL_TIMEOUT_MS}ms`,
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
            reason: `codex exec exited ${code}: ${err.slice(0, 200)}`,
            meta: meta(),
          });
        }
        const json = extractJsonObject(out);
        if (json === null) {
          return finish({
            ok: false,
            reason: `no JSON object in codex output: ${out.slice(0, 200)}`,
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
