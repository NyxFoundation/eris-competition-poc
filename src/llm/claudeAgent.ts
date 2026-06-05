import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { encodeFunctionData, parseUnits, formatUnits } from "viem";
import type { AgentAction, AgentObservation } from "../types.js";
import { History, buildRoundRecord } from "./history.js";
import { getBaseStrategy } from "./baseStrategies.js";
import {
  DEFAULT_ADDRESSES,
  runExecutor,
  type ExecutorHelpers,
  type Strategy,
} from "./strategy.js";
import {
  ClaudeStrategist,
  MockStrategist,
  type ClaudeCallMeta,
  type Strategist,
  type StrategyResult,
} from "./claudeStrategist.js";
import { ClaudeSubscriptionStrategist } from "./claudeSubscriptionStrategist.js";
import type { ReviseReason } from "./prompts.js";

const REVIEW_EVERY_N_ROUNDS = intEnv("ERIS_LLM_REVIEW_EVERY", 10);
const DRAWDOWN_TRIGGER_RATIO = floatEnv("ERIS_LLM_DRAWDOWN_RATIO", 0.05);
const HISTORY_CAPACITY = intEnv("ERIS_LLM_HISTORY_CAPACITY", 30);
const EXECUTOR_TIMEOUT_MS = intEnv("ERIS_LLM_EXECUTOR_TIMEOUT_MS", 200);
// 改訂凍結フラグ。1 なら init/seed 後に revise を一切行わない(決定論・ベース保護)。
const FREEZE_STRATEGY = process.env.ERIS_FREEZE_STRATEGY === "1";

function reportDirRoot(): string {
  return process.env.REPORT_DIR ?? "./runs";
}

export type State = {
  strategy: Strategy | null;
  pendingPhase: "init" | "revise" | null;
  pending: Promise<void> | null;
  history: History;
  lastReviseRound: number;
  agentId: string;
  agentDir: string | null;
  decisionsPath: string | null;
  callsPath: string | null;
};

export function createState(
  agentId: string,
  historyCapacity = HISTORY_CAPACITY,
): State {
  return {
    strategy: null,
    pendingPhase: null,
    pending: null,
    history: new History(historyCapacity),
    lastReviseRound: -1,
    agentId,
    agentDir: null,
    decisionsPath: null,
    callsPath: null,
  };
}

const helpersBase: Omit<ExecutorHelpers, "log"> = {
  parseUnits,
  formatUnits,
  encodeFunctionData,
  ADDRESSES: DEFAULT_ADDRESSES,
};

/**
 * Pick a Strategist based on env. `ERIS_LLM_AUTH` (or legacy `ERIS_LLM_MOCK=1`)
 * controls the choice:
 *   mock          – offline, no network. Default when nothing else is available.
 *   apikey        – ClaudeStrategist using ANTHROPIC_API_KEY.
 *   subscription  – ClaudeSubscriptionStrategist via Claude Code OAuth (Pro/Max).
 *   auto (default)– subscription if `claude` is reachable, else apikey if a key
 *                   is set, else mock. Never throws on unavailability.
 */
export function selectStrategist(): Strategist {
  const auth = (process.env.ERIS_LLM_AUTH ?? "auto").toLowerCase();
  if (process.env.ERIS_LLM_MOCK === "1" || auth === "mock") {
    emitStderr(
      "[claude-llm] strategist=mock (ERIS_LLM_MOCK=1 or ERIS_LLM_AUTH=mock)\n",
    );
    return new MockStrategist();
  }
  if (auth === "apikey") {
    if (!process.env.ANTHROPIC_API_KEY) {
      emitStderr(
        "[claude-llm] strategist=mock (ERIS_LLM_AUTH=apikey but ANTHROPIC_API_KEY unset)\n",
      );
      return new MockStrategist();
    }
    emitStderr("[claude-llm] strategist=apikey\n");
    return new ClaudeStrategist();
  }
  if (auth === "subscription") {
    emitStderr("[claude-llm] strategist=subscription (Claude Code OAuth)\n");
    return new ClaudeSubscriptionStrategist();
  }
  // auto
  if (canUseSubscription()) {
    emitStderr(
      "[claude-llm] strategist=subscription (auto-detected Claude Code OAuth)\n",
    );
    return new ClaudeSubscriptionStrategist();
  }
  if (process.env.ANTHROPIC_API_KEY) {
    emitStderr(
      "[claude-llm] strategist=apikey (auto: no claude binary, ANTHROPIC_API_KEY present)\n",
    );
    return new ClaudeStrategist();
  }
  emitStderr(
    "[claude-llm] strategist=mock (auto: no claude binary, no ANTHROPIC_API_KEY)\n",
  );
  return new MockStrategist();
}

/**
 * Probe whether the `claude` CLI binary is reachable from PATH. If yes, we
 * assume Claude Agent SDK will be able to use OAuth via the bundled binary.
 * Cheap and synchronous so selectStrategist stays predictable.
 */
function canUseSubscription(): boolean {
  try {
    // Cross-platform "is `claude` on PATH?" probe. spawnSync's shell:true
    // honors PATH and is cheap (~1ms).
    const result = spawnSync("command -v claude", {
      shell: true,
      stdio: "ignore",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Entry point. Spawned by AgentProcess; reads observations on stdin, writes actions on stdout.
 * The strategist is consulted asynchronously and never blocks the per-round response.
 */
export async function run(strategist?: Strategist): Promise<void> {
  const agentId = process.env.ERIS_AGENT_ID ?? "claude-llm";
  const s = strategist ?? selectStrategist();
  const state = createState(agentId);

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    handleLine(line, state, s).catch((error) => {
      emitStderr(
        `unhandled error: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      emitAction({ type: "noop", reason: "unhandled internal error" });
    });
  });
}

export async function handleLine(
  line: string,
  state: State,
  strategist: Strategist,
): Promise<AgentAction> {
  let obs: AgentObservation;
  try {
    obs = JSON.parse(line) as AgentObservation;
  } catch (error) {
    const fallback: AgentAction = {
      type: "noop",
      reason: `bad observation json: ${msg(error)}`,
    };
    emitAction(fallback);
    return fallback;
  }

  ensureRunDirs(state, obs);
  state.history.setInitialUsd(obs.inventory.valueUsdc);

  // Kick off background strategy calls if needed. These do not block the response.
  scheduleStrategyWorkIfNeeded(state, strategist, obs);

  const decision = decideAction(state, obs);
  state.history.push(
    buildRoundRecord(
      obs,
      decision.action,
      decision.ok,
      decision.reason,
      decision.logs,
    ),
  );
  appendDecision(state, obs, decision);
  emitAction(decision.action);
  return decision.action;
}

type DecisionResult = {
  action: AgentAction;
  ok: boolean;
  reason?: string;
  logs: string[];
  strategyVersion: number | null;
};

function decideAction(state: State, obs: AgentObservation): DecisionResult {
  if (!state.strategy) {
    const reason =
      state.pendingPhase === "init"
        ? "strategy init pending"
        : "no strategy yet";
    return {
      action: { type: "noop", reason },
      ok: false,
      reason,
      logs: [],
      strategyVersion: null,
    };
  }
  const result = runExecutor(
    state.strategy,
    obs,
    helpersBase,
    EXECUTOR_TIMEOUT_MS,
  );
  if (!result.ok) {
    return {
      action: { type: "noop", reason: `executor error: ${result.reason}` },
      ok: false,
      reason: result.reason,
      logs: result.logs,
      strategyVersion: state.strategy.version,
    };
  }
  return {
    action: result.action,
    ok: true,
    logs: result.logs,
    strategyVersion: state.strategy.version,
  };
}

// ERIS_BASE_STRATEGY が指すベース戦略を v1 として state にシードする(決定論・LLM 不要)。
// 成功で true。未設定/未知 id は false(= 通常の LLM init にフォールバック)。
export function seedStrategy(state: State): boolean {
  if (state.strategy) return false;
  const seed = getBaseStrategy(process.env.ERIS_BASE_STRATEGY);
  if (!seed) return false;
  state.strategy = seed;
  return true;
}

function scheduleStrategyWorkIfNeeded(
  state: State,
  strategist: Strategist,
  obs: AgentObservation,
): void {
  if (state.pendingPhase !== null) return;
  if (!state.strategy) {
    // シード付き: ベース戦略を v1 にする(最初から即戦力・再現可能)。LLM は以降の revise でのみ働く。
    if (seedStrategy(state) && state.strategy) {
      persistStrategy(state, state.strategy);
      emitStderr(
        `[claude-llm] seeded from base "${process.env.ERIS_BASE_STRATEGY}" as v1\n`,
      );
      return;
    }
    state.pendingPhase = "init";
    state.pending = runStrategistInit(state, strategist, obs);
    return;
  }
  // 改訂凍結: シードした v1(または現戦略)を固定し LLM を呼ばない。
  // 決定論を保つ測定走行(P3 のゲート)や、API 無し/mock 環境でベースを保護したいときに使う。
  if (FREEZE_STRATEGY) return;
  const initialUsd = state.history.getInitialUsd() ?? obs.inventory.valueUsdc;
  const currentUsd = obs.inventory.valueUsdc;
  const reason = whichReviseReason(
    obs.round,
    state.lastReviseRound,
    currentUsd,
    initialUsd,
  );
  if (reason) {
    state.pendingPhase = "revise";
    state.lastReviseRound = obs.round;
    state.pending = runStrategistRevise(
      state,
      strategist,
      obs,
      reason,
      initialUsd,
      currentUsd,
    );
  }
}

export function whichReviseReason(
  round: number,
  lastReviseRound: number,
  currentUsd: number,
  initialUsd: number,
): ReviseReason | null {
  if (
    round > 0 &&
    round !== lastReviseRound &&
    round % REVIEW_EVERY_N_ROUNDS === 0
  )
    return "scheduled";
  if (
    initialUsd > 0 &&
    currentUsd < initialUsd * (1 - DRAWDOWN_TRIGGER_RATIO) &&
    round !== lastReviseRound
  ) {
    return "pnl_drop";
  }
  return null;
}

async function runStrategistInit(
  state: State,
  strategist: Strategist,
  obs: AgentObservation,
): Promise<void> {
  const version = nextVersion(state);
  const result = await strategist.init(obs, version);
  logClaudeCall(state, result, "init");
  if (result.ok) {
    state.strategy = result.strategy;
    persistStrategy(state, result.strategy);
    emitStderr(
      `[claude-llm] strategy v${result.strategy.version} initialized\n`,
    );
  } else {
    emitStderr(`[claude-llm] init failed: ${result.reason}\n`);
  }
  state.pendingPhase = null;
  state.pending = null;
}

async function runStrategistRevise(
  state: State,
  strategist: Strategist,
  obs: AgentObservation,
  reason: ReviseReason,
  initialUsd: number,
  currentUsd: number,
): Promise<void> {
  if (!state.strategy) {
    state.pendingPhase = null;
    return;
  }
  const version = nextVersion(state);
  const result = await strategist.revise(
    state.strategy,
    state.history.recent(),
    reason,
    initialUsd,
    currentUsd,
    version,
  );
  logClaudeCall(state, result, "revise");
  if (result.ok) {
    state.strategy = result.strategy;
    persistStrategy(state, result.strategy);
    emitStderr(
      `[claude-llm] strategy v${result.strategy.version} adopted (reason=${reason}, pnl=${currentUsd.toFixed(2)}/${initialUsd.toFixed(2)})\n`,
    );
  } else {
    emitStderr(
      `[claude-llm] revise failed: ${result.reason} — keeping v${state.strategy.version}\n`,
    );
  }
  state.pendingPhase = null;
  state.pending = null;
  void obs;
}

function nextVersion(state: State): number {
  return state.strategy ? state.strategy.version + 1 : 1;
}

function ensureRunDirs(state: State, obs: AgentObservation): void {
  if (state.agentDir) return;
  state.agentDir = join(reportDirRoot(), obs.runId, `agent-${state.agentId}`);
  if (!existsSync(state.agentDir))
    mkdirSync(state.agentDir, { recursive: true });
  state.decisionsPath = join(state.agentDir, "decisions.jsonl");
  state.callsPath = join(state.agentDir, "claude-calls.jsonl");
  writeFileSync(state.decisionsPath, "");
  writeFileSync(state.callsPath, "");
}

function persistStrategy(state: State, strategy: Strategy): void {
  if (!state.agentDir) return;
  const base = join(state.agentDir, `strategy-v${strategy.version}`);
  writeFileSync(
    `${base}.md`,
    `# Strategy v${strategy.version}\n\n${strategy.notes}\n`,
  );
  writeFileSync(
    `${base}.params.json`,
    `${JSON.stringify(strategy.params, null, 2)}\n`,
  );
  writeFileSync(
    `${base}.executor.ts`,
    `// Body of (obs, params, helpers) => AgentAction\n${strategy.executorTs}\n`,
  );
}

function appendDecision(
  state: State,
  obs: AgentObservation,
  decision: DecisionResult,
): void {
  if (!state.decisionsPath) return;
  const row = {
    ts: new Date().toISOString(),
    round: obs.round,
    strategyVersion: decision.strategyVersion,
    actionType: decision.action.type,
    ok: decision.ok,
    reason: decision.reason,
    logs: decision.logs,
    pendingPhase: state.pendingPhase,
  };
  appendFileSync(state.decisionsPath, `${JSON.stringify(row)}\n`);
}

function logClaudeCall(
  state: State,
  result: StrategyResult,
  phase: "init" | "revise",
): void {
  if (!state.callsPath) return;
  const meta: Partial<ClaudeCallMeta> = result.meta ?? { phase };
  const row = {
    ts: new Date().toISOString(),
    phase,
    ok: result.ok,
    reason: result.ok ? undefined : result.reason,
    strategyVersion: result.ok ? result.strategy.version : undefined,
    ...meta,
  };
  appendFileSync(state.callsPath, `${JSON.stringify(row)}\n`);
}

function emitAction(action: AgentAction): void {
  process.stdout.write(`${JSON.stringify(action)}\n`);
}

function emitStderr(text: string): void {
  process.stderr.write(text);
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isInteger(n) ? n : fallback;
}

function floatEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
