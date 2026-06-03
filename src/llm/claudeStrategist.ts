import Anthropic from "@anthropic-ai/sdk";
import type { AgentObservation } from "../types.js";
import type { RoundRecord } from "./history.js";
import { buildInitMessage, buildReviseMessage, SIM_RULES, SYSTEM_PROMPT, type Phase, type ReviseReason } from "./prompts.js";
import { parseStrategyFromToolInput, type Strategy, type StrategyParseResult } from "./strategy.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

export type ClaudeCallMeta = {
  phase: Phase;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

export type StrategyResult =
  | { ok: true; strategy: Strategy; meta: ClaudeCallMeta }
  | { ok: false; reason: string; meta?: ClaudeCallMeta };

export interface Strategist {
  init(obs: AgentObservation, version: number): Promise<StrategyResult>;
  revise(prev: Strategy, history: RoundRecord[], reason: ReviseReason, initialUsd: number, currentUsd: number, version: number): Promise<StrategyResult>;
}

const SET_STRATEGY_TOOL = {
  name: "set_strategy",
  description: "Define or revise the trading strategy for upcoming rounds.",
  input_schema: {
    type: "object" as const,
    properties: {
      notes: {
        type: "string",
        description: "Markdown rationale: thesis, edge, risks, what would make you revise."
      },
      params: {
        type: "object",
        description: "JSON object of numeric/boolean parameters the executor reads at runtime."
      },
      executor_ts: {
        type: "string",
        description:
          "TypeScript function body (no signature). Receives (obs, params, helpers) and must return an AgentAction. See SIM_RULES for the contract."
      }
    },
    required: ["notes", "params", "executor_ts"]
  }
};

export class ClaudeStrategist implements Strategist {
  private client: Anthropic;
  private model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
    this.model = opts.model ?? process.env.ERIS_LLM_MODEL ?? DEFAULT_MODEL;
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
    version: number
  ): Promise<StrategyResult> {
    return this.call("revise", buildReviseMessage(prev, history, reason, initialUsd, currentUsd), version);
  }

  private async call(phase: Phase, userMessage: string, version: number): Promise<StrategyResult> {
    const started = Date.now();
    let meta: ClaudeCallMeta | undefined;
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 8192,
        system: [
          { type: "text", text: SYSTEM_PROMPT },
          { type: "text", text: SIM_RULES, cache_control: { type: "ephemeral" } }
        ],
        messages: [{ role: "user", content: userMessage }],
        tools: [SET_STRATEGY_TOOL],
        tool_choice: { type: "tool", name: "set_strategy" }
      });
      const latencyMs = Date.now() - started;
      const usage = response.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      meta = {
        phase,
        latencyMs,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0
      };
      const toolBlock = response.content.find((block) => block.type === "tool_use" && block.name === "set_strategy");
      if (!toolBlock || toolBlock.type !== "tool_use") {
        return { ok: false, reason: "model did not call set_strategy", meta };
      }
      const parsed: StrategyParseResult = parseStrategyFromToolInput(toolBlock.input, version);
      if (!parsed.ok) return { ok: false, reason: parsed.reason, meta };
      return { ok: true, strategy: parsed.strategy, meta };
    } catch (error) {
      return {
        ok: false,
        reason: `claude call failed: ${error instanceof Error ? error.message : String(error)}`,
        meta
      };
    }
  }
}

/**
 * Test/offline strategist. Returns a hard-coded spread-arb strategy.
 * Activated by ERIS_LLM_MOCK=1.
 */
export class MockStrategist implements Strategist {
  async init(_obs: AgentObservation, version: number): Promise<StrategyResult> {
    return { ok: true, strategy: defaultMockStrategy(version), meta: mockMeta("init") };
  }
  async revise(_prev: Strategy, _h: RoundRecord[], _r: ReviseReason, _i: number, _c: number, version: number): Promise<StrategyResult> {
    return { ok: true, strategy: defaultMockStrategy(version), meta: mockMeta("revise") };
  }
}

function mockMeta(phase: Phase): ClaudeCallMeta {
  return { phase, latencyMs: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

function defaultMockStrategy(version: number): Strategy {
  return {
    version,
    notes: "Mock strategy: noop always. Replace with real ANTHROPIC_API_KEY.",
    params: { minGapBps: 15 },
    executorTs: `return { type: "noop", reason: "mock strategy v${version}" };`
  };
}
