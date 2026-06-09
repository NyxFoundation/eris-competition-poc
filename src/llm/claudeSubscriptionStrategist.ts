import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
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

// SDK query のハード上限。入れ子検出などで無限ハングしても fail-fast し、次サイクルで再試行できる。
const CALL_TIMEOUT_MS = (() => {
  const v = Number(process.env.ERIS_LLM_CALL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 90_000;
})();

// 入れ子 Claude Code セッションのマーカー。残ると SDK が spawn する claude バイナリが
// 「入れ子セッション」を検出して無限ハングする(CLAUDE_CODE_* だけでなく、アンダースコア無しの
// CLAUDECODE と AI_AGENT も該当)。これらを env から除去すると独立した headless OAuth 呼び出しになる。
function isNestedSessionMarker(key: string): boolean {
  return (
    key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE" || key === "AI_AGENT"
  );
}

/**
 * The set of built-in Claude Code tools we don't want the model to use during
 * a strategy call. The model is supposed to only call our MCP set_strategy tool.
 */
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

/**
 * Slim version of the SDK surface we depend on. Tests substitute a fake that
 * captures the tool handler and returns scripted SDK messages.
 */
export type SdkLike = {
  query: typeof query;
  tool: typeof tool;
  createSdkMcpServer: typeof createSdkMcpServer;
};

const REAL_SDK: SdkLike = { query, tool, createSdkMcpServer };

/**
 * Strategist that authenticates via the user's Claude Code OAuth/Keychain
 * credentials (Pro/Max subscription). No ANTHROPIC_API_KEY required.
 *
 * Internally the SDK spawns the `claude` binary as a subprocess; cold start is
 * ~1s on top of API latency. Per-call subprocess is fine for our cadence
 * (~13 calls per 128-round run).
 */
export class ClaudeSubscriptionStrategist implements Strategist {
  private model: string;
  private sdk: SdkLike;

  constructor(opts: { model?: string; sdk?: SdkLike } = {}) {
    this.model = opts.model ?? process.env.ERIS_LLM_MODEL ?? DEFAULT_MODEL;
    this.sdk = opts.sdk ?? REAL_SDK;
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

  private async call(
    phase: Phase,
    userMessage: string,
    version: number,
    prev?: Strategy,
  ): Promise<StrategyResult> {
    const started = Date.now();
    let captured: unknown;
    let meta: ClaudeCallMeta | undefined;

    const strategyServer = this.sdk.createSdkMcpServer({
      name: "strategy",
      alwaysLoad: true,
      tools: [
        this.sdk.tool(
          "set_strategy",
          "Define or revise the trading strategy for upcoming rounds.",
          {
            notes: z
              .string()
              .describe(
                "Markdown rationale: thesis, edge, risks, what would make you revise.",
              ),
            params: z
              .record(z.string(), z.any())
              .describe(
                "JSON object of numeric/boolean parameters the executor reads.",
              ),
            executor_ts: z
              .string()
              .describe(
                "TypeScript function body (no signature). Receives (obs, params, helpers) and must return an AgentAction.",
              ),
            change_type: z
              .enum(["params_only", "executor_logic"])
              .optional()
              .describe(
                "Default 'params_only' (previous executor kept; only params apply). Use 'executor_logic' ONLY with cited evidence.",
              ),
            hypothesis: z
              .string()
              .optional()
              .describe(
                "Expected improvement, grounded in the PnL attribution.",
              ),
            rollback_condition: z
              .string()
              .optional()
              .describe("Evidence that would mean this change failed."),
            why_executor_change: z
              .string()
              .optional()
              .describe(
                "Required only if change_type is 'executor_logic': quote the concrete failure in the round log.",
              ),
          },
          async (args) => {
            captured = args;
            return { content: [{ type: "text", text: "ok" }] };
          },
        ),
      ],
    });

    const cleanEnv: Record<string, string | undefined> = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (isNestedSessionMarker(key)) delete cleanEnv[key];
    }

    const options: Options = {
      model: this.model,
      systemPrompt: `${SYSTEM_PROMPT}\n\n${SIM_RULES}`,
      mcpServers: { strategy: strategyServer },
      allowedTools: ["mcp__strategy__set_strategy"],
      disallowedTools: DISALLOWED_TOOLS,
      permissionMode: "bypassPermissions",
      maxTurns: 2,
      env: cleanEnv,
      // Isolation mode — do not inherit user/project skills, plugins, MCP
      // servers, hooks, or settings.json. The agent only needs OAuth credentials
      // from disk; loading 70+ user skills per call adds seconds and pollutes
      // the system prompt context budget.
      settingSources: [],
      ...(process.env.ERIS_CLAUDE_BIN
        ? { pathToClaudeCodeExecutable: process.env.ERIS_CLAUDE_BIN }
        : {}),
    };

    let resultSubtype: string | null = null;
    try {
      await Promise.race([
        (async () => {
          for await (const msg of this.sdk.query({
            prompt: userMessage,
            options,
          })) {
            if (msg.type === "result") {
              meta = readUsage(phase, started, msg);
              resultSubtype = msg.subtype;
            }
          }
        })(),
        new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(new Error(`query timed out after ${CALL_TIMEOUT_MS}ms`)),
            CALL_TIMEOUT_MS,
          ).unref();
        }),
      ]);
    } catch (error) {
      return {
        ok: false,
        reason: `claude call failed: ${error instanceof Error ? error.message : String(error)}`,
        meta,
      };
    }
    if (resultSubtype !== null && resultSubtype !== "success") {
      return { ok: false, reason: `claude returned ${resultSubtype}`, meta };
    }

    if (!captured)
      return { ok: false, reason: "model did not call set_strategy", meta };
    const parsed = parseStrategyFromToolInput(captured, version, prev);
    if (!parsed.ok) return { ok: false, reason: parsed.reason, meta };
    return {
      ok: true,
      strategy: parsed.strategy,
      meta: meta ?? zeroMeta(phase, started),
    };
  }
}

function zeroMeta(phase: Phase, started: number): ClaudeCallMeta {
  return {
    phase,
    latencyMs: Date.now() - started,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

type ResultLike = {
  type: "result";
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

function readUsage(
  phase: Phase,
  started: number,
  msg: ResultLike,
): ClaudeCallMeta {
  const usage = msg.usage ?? {};
  return {
    phase,
    latencyMs: msg.duration_ms ?? Date.now() - started,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}
