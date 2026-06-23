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
import { extractJsonObject } from "./claudeCliStrategist.js";
import type {
  ClaudeCallMeta,
  Strategist,
  StrategyResult,
} from "./claudeStrategist.js";

const DEFAULT_BASE_URL = "https://ollama.com/api";
const DEFAULT_MODEL = "gpt-oss:120b";

const CALL_TIMEOUT_MS = (() => {
  const v = Number(process.env.ERIS_LLM_CALL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 180_000;
})();

const MAX_RETRIES = (() => {
  const v = Number(process.env.ERIS_OLLAMA_MAX_RETRIES);
  return Number.isInteger(v) && v > 0 ? v : 3;
})();

const OLLAMA_OUTPUT_CONTRACT = `

## Output (Ollama Cloud API mode - IMPORTANT)
Respond with ONLY a single JSON object - no markdown code fences, no commentary before or after - of exactly this shape:
{"notes": "<markdown rationale>", "params": { <numeric/boolean params> }, "executor_ts": "<function body that returns an AgentAction>",
 "change_type": "params_only" | "executor_logic", "hypothesis": "<expected improvement, grounded in attribution>",
 "rollback_condition": "<evidence that would mean this change failed>", "why_executor_change": "<required only if executor_logic: cite the concrete failure in the round log>"}
Default change_type to "params_only" (the previous executor is kept; only your params apply). Set "executor_logic"
ONLY when the round log shows a concrete failure that forces a rewrite. This is the simulator's expected,
legitimate strategist output. The executor_ts body runs in a sandboxed vm (no network, no filesystem).`;

export type OllamaFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type SleepFn = (ms: number) => Promise<void>;

type OllamaChatResponse = {
  message?: { role?: string; content?: string };
  done?: boolean;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

function defaultFetch(): OllamaFetch {
  if (typeof fetch !== "function") {
    throw new Error("global fetch is unavailable; use Node.js 18+");
  }
  return fetch;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OllamaStrategist implements Strategist {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private fetchFn: OllamaFetch;
  private sleepFn: SleepFn;
  private maxRetries: number;

  constructor(
    opts: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      fetchFn?: OllamaFetch;
      sleepFn?: SleepFn;
      maxRetries?: number;
    } = {},
  ) {
    this.apiKey =
      opts.apiKey ??
      process.env.ERIS_OLLAMA_API_KEY ??
      process.env.OLLAMA_API_KEY ??
      "";
    this.baseUrl = normalizeBaseUrl(
      opts.baseUrl ?? process.env.ERIS_OLLAMA_BASE_URL ?? DEFAULT_BASE_URL,
    );
    this.model =
      opts.model ??
      process.env.ERIS_OLLAMA_MODEL ??
      process.env.ERIS_LLM_MODEL ??
      DEFAULT_MODEL;
    this.fetchFn = opts.fetchFn ?? defaultFetch();
    this.sleepFn = opts.sleepFn ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? MAX_RETRIES;
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
    let meta: ClaudeCallMeta | undefined;
    if (!this.apiKey) {
      return {
        ok: false,
        reason: "OLLAMA_API_KEY is required for Ollama Cloud API",
        meta: zeroMeta(phase, started),
      };
    }

    const body = {
      model: this.model,
      messages: [
        {
          role: "system",
          content: `${SYSTEM_PROMPT}\n\n${SIM_RULES}${OLLAMA_OUTPUT_CONTRACT}`,
        },
        { role: "user", content: userMessage },
      ],
      stream: false,
      format: "json",
    };

    try {
      const response = await this.postChat(body);
      meta = {
        phase,
        latencyMs: Date.now() - started,
        inputTokens: response.prompt_eval_count ?? 0,
        outputTokens: response.eval_count ?? 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
      const content = response.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        return { ok: false, reason: "ollama response missing message.content", meta };
      }
      const json = extractJsonObject(content);
      if (json === null) {
        return {
          ok: false,
          reason: `no JSON object in ollama output: ${content.slice(0, 200)}`,
          meta,
        };
      }
      const parsed = parseStrategyFromToolInput(json, version, prev);
      if (!parsed.ok) return { ok: false, reason: parsed.reason, meta };
      return { ok: true, strategy: parsed.strategy, meta };
    } catch (error) {
      return {
        ok: false,
        reason: `ollama call failed: ${error instanceof Error ? error.message : String(error)}`,
        meta: meta ?? zeroMeta(phase, started),
      };
    }
  }

  private async postChat(body: unknown): Promise<OllamaChatResponse> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
      timer.unref?.();
      try {
        const response = await this.fetchFn(`${this.baseUrl}/chat`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.ok) {
          const json = (await response.json()) as OllamaChatResponse;
          if (typeof json.error === "string" && json.error.trim() !== "") {
            throw new Error(json.error);
          }
          return json;
        }
        const text = await response.text();
        const reason = `HTTP ${response.status}: ${text.slice(0, 300)}`;
        if (!isRetryableStatus(response.status) || attempt === this.maxRetries - 1) {
          throw new Error(reason);
        }
        lastError = new Error(reason);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (attempt === this.maxRetries - 1 || !isRetryableError(err)) {
          throw err;
        }
        lastError = err;
      } finally {
        clearTimeout(timer);
      }
      await this.sleepFn(1000 * (attempt + 1));
    }
    throw lastError ?? new Error("request failed");
  }
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableError(error: Error): boolean {
  return error.name === "AbortError" || /network|fetch|timeout|terminated/i.test(error.message);
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
