import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  encodeFunctionData,
  encodeAbiParameters,
  parseUnits,
  formatUnits,
} from "viem";
import type { AgentAction, AgentObservation } from "../types.js";
import { History, buildRoundRecord } from "./history.js";
import { getBaseStrategy } from "./baseStrategies.js";
import {
  DEFAULT_ADDRESSES,
  runExecutor,
  type ExecutorHelpers,
  type Strategy,
} from "./strategy.js";
import { FLASH_ARB_ADDRESS } from "../flashArbDemo.js";
import {
  ClaudeStrategist,
  MockStrategist,
  type ClaudeCallMeta,
  type Strategist,
  type StrategyResult,
} from "./claudeStrategist.js";
import { ClaudeSubscriptionStrategist } from "./claudeSubscriptionStrategist.js";
import { ClaudeCliStrategist } from "./claudeCliStrategist.js";
import { CodexCliStrategist } from "./codexCliStrategist.js";
import type { ReviseReason } from "./prompts.js";

const REVIEW_EVERY_N_ROUNDS = intEnv("ERIS_LLM_REVIEW_EVERY", 10);
// revise ウィンドウの位相オフセット(ブロック)。多数の自己改善 agent を並列で回すとき、
// 全員が同じ round で同時に revise すると LLM API のピーク並走が agent 数になり競合する
// (各 revise が遅くなり runway 内に終わらない)。agent ごとに別オフセットを与えて revise を
// ずらす(stagger)と同時刻の revise が数体に減り、同じ API プールで多数の agent を収容できる。
// 既定 0 = 従来どおり(全員同位相)。ロスターで agent 別に設定する。
const REVIEW_OFFSET = intEnv("ERIS_LLM_REVIEW_OFFSET", 0);
const DRAWDOWN_TRIGGER_RATIO = floatEnv("ERIS_LLM_DRAWDOWN_RATIO", 0.05);
const HISTORY_CAPACITY = intEnv("ERIS_LLM_HISTORY_CAPACITY", 30);
const EXECUTOR_TIMEOUT_MS = intEnv("ERIS_LLM_EXECUTOR_TIMEOUT_MS", 200);
// 改訂凍結フラグ。1 なら init/seed 後に revise を一切行わない(決定論・ベース保護)。
const FREEZE_STRATEGY = process.env.ERIS_FREEZE_STRATEGY === "1";
// live sanity ゲート(ADR 0002 A-3)。直近 N 観測で revise 候補が前版より実行時エラーを
// 増やすなら採用しない。ERIS_LLM_SANITY_GATE=0 で無効化(決定論測定など)。
const SANITY_OBS_WINDOW = intEnv("ERIS_LLM_SANITY_WINDOW", 8);
const SANITY_GATE_ENABLED = process.env.ERIS_LLM_SANITY_GATE !== "0";
// live PnL ロールバック(ADR 0002 の rollback_condition を機構化)。revise 採用後に実現 PnL を
// 監視し、(a)採用時評価額から ROLLBACK_DROP 以上下落(急落ガード)、または (b)新版の α レートが
// 前版より明確に劣る(A/B 劣化ガード)とき前版へ自動で巻き戻す(事後・反応的ガード)。
// sanity ゲート(実行時エラーのみ)では捕えられない「正気だが致命的」な改悪を打ち切る。
//
// α レートで比較する理由: 総資産の per-round 変化は市場 β(価格変動)のノイズが戦略 edge(α)を
// 桁違いに飲み込むため、総額の前版比較では「サイズ減でゆっくり鈍る」緩やかな劣化を検出できない。
// 在庫を固定価格(採用時 fair price)で評価して β を除き、トレード由来の α だけのレートで比較する。
// ERIS_LLM_ROLLBACK=0 で無効化。
const ROLLBACK_ENABLED = process.env.ERIS_LLM_ROLLBACK !== "0";
const ROLLBACK_WINDOW = intEnv("ERIS_LLM_ROLLBACK_WINDOW", 5); // 急落判定までの最小経過ラウンド
const ROLLBACK_DROP = floatEnv("ERIS_LLM_ROLLBACK_DROP", 0.04); // 急落: 採用時比の下落率しきい値
const ROLLBACK_AB_WINDOW = intEnv("ERIS_LLM_ROLLBACK_AB_WINDOW", 20); // A/B 劣化判定までの最小経過ラウンド
// A/B 劣化: 前版が明確にプラスの α レートを持っていたのに新版がその ROLLBACK_KEEP_FRACTION 未満
// しか維持できなければ巻き戻す(edge を大きく削った改悪を相対比で検出。edge が小さくても効く)。
// 基準(前版 α レート)が小さすぎる=ノイズのときは A/B 判定しない。
const ROLLBACK_KEEP_FRACTION = floatEnv("ERIS_LLM_ROLLBACK_KEEP_FRACTION", 0.5);
const ROLLBACK_MIN_RATE_FRAC = floatEnv(
  "ERIS_LLM_ROLLBACK_MIN_RATE_FRAC",
  0.000005,
);
const ROLLBACK_GRADUATE = intEnv("ERIS_LLM_ROLLBACK_GRADUATE", 40); // 監視を打ち切る経過ラウンド

// 在庫を固定価格で評価した「α(トレード由来 PnL)」: usdc + (weth+eth)×refPrice。
// 価格変動による在庫の再評価(β)を除くので、戦略の取り分だけが残る。
function alphaValueUsd(
  inv: { usdc: number; weth: number; eth: number },
  refPrice: number,
): number {
  return inv.usdc + (inv.weth + inv.eth) * refPrice;
}

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
  rollbacksPath: string | null;
  // sanity ゲート用の直近観測リング(最大 SANITY_OBS_WINDOW)。
  recentObs: AgentObservation[];
  // PnL ロールバック用: 採用直前の版・採用時評価額・採用ラウンド。
  prevStrategy: Strategy | null;
  adoptUsd: number | null;
  adoptRound: number;
  pendingAdoption: boolean;
  // A/B 劣化判定用: 採用時の α 評価額・固定評価価格・前版の α レート(per round)。
  adoptAlpha: number | null;
  refPrice: number;
  prevAlphaRate: number | null;
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
    rollbacksPath: null,
    recentObs: [],
    prevStrategy: null,
    adoptUsd: null,
    adoptRound: -1,
    pendingAdoption: false,
    adoptAlpha: null,
    refPrice: 0,
    prevAlphaRate: null,
  };
}

const helpersBase: Omit<ExecutorHelpers, "log"> = {
  parseUnits,
  formatUnits,
  encodeFunctionData,
  encodeAbiParameters,
  // FlashArb は ERIS_FLASH_ARB=1(coordinator が FlashArb をデプロイする run)のときだけアドレスを
  // 注入する。未設定なら flasharb base は self-guard で noop になり、未デプロイ環境で revert tx を
  // 浪費しない(aave base が obs.protocols.aave で self-guard するのと同じ発想の env 版)。
  ADDRESSES:
    process.env.ERIS_FLASH_ARB === "1"
      ? { ...DEFAULT_ADDRESSES, FLASH_ARB: FLASH_ARB_ADDRESS }
      : DEFAULT_ADDRESSES,
};

/**
 * Pick a Strategist based on env. `ERIS_LLM_AUTH` (or legacy `ERIS_LLM_MOCK=1`)
 * controls the choice:
 *   mock          – offline, no network. Default when nothing else is available.
 *   apikey        – ClaudeStrategist using ANTHROPIC_API_KEY.
 *   cli           – ClaudeCliStrategist via `claude -p` (Claude Code OAuth/サブスク).
 *                   推奨のサブスク経路。SDK と違い nested でもハングしない。
 *   codex         – CodexCliStrategist via `codex exec` (別 API プール)。claude -p と競合しない
 *                   ので混成ロスターで自己改善の並走上限を上げられる。`ERIS_CODEX_MODEL` で model 上書き。
 *   subscription  – ClaudeSubscriptionStrategist via Agent SDK query()。注意: Claude Code
 *                   セッション内(別ターミナル含む)では nested 検出でハングしうる。
 *   auto (default)– cli if `claude` is reachable, else apikey if a key is set, else mock.
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
  if (auth === "cli") {
    emitStderr("[claude-llm] strategist=cli (claude -p, Claude Code OAuth)\n");
    return new ClaudeCliStrategist();
  }
  if (auth === "codex") {
    emitStderr("[claude-llm] strategist=codex (codex exec, 別 API プール)\n");
    return new CodexCliStrategist();
  }
  if (auth === "subscription") {
    emitStderr("[claude-llm] strategist=subscription (Agent SDK query)\n");
    return new ClaudeSubscriptionStrategist();
  }
  // auto: 信頼できるサブスク経路(cli)を優先。SDK query は nested でハングするため使わない。
  if (canUseSubscription()) {
    emitStderr("[claude-llm] strategist=cli (auto-detected claude binary)\n");
    return new ClaudeCliStrategist();
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
  state.recentObs.push(obs);
  if (state.recentObs.length > SANITY_OBS_WINDOW) state.recentObs.shift();

  // PnL ロールバック: 新版採用直後の評価額を基準化し、悪化していれば前版へ巻き戻す。
  if (ROLLBACK_ENABLED) maybeRollback(state, obs);

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
  reviewEvery: number = REVIEW_EVERY_N_ROUNDS,
  offset: number = REVIEW_OFFSET,
): ReviseReason | null {
  if (
    round > offset &&
    round !== lastReviseRound &&
    (round - offset) % reviewEvery === 0
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
    const gate = SANITY_GATE_ENABLED
      ? passesSanityGate(result.strategy, state.strategy, state.recentObs)
      : null;
    if (!gate || gate.ok) {
      // ロールバック用に直前の良い版を退避し、採用を handleLine で基準化する。
      state.prevStrategy = state.strategy;
      state.pendingAdoption = true;
      state.strategy = result.strategy;
      persistStrategy(state, result.strategy);
      emitStderr(
        `[claude-llm] strategy v${result.strategy.version} adopted (reason=${reason}, pnl=${currentUsd.toFixed(2)}/${initialUsd.toFixed(2)})\n`,
      );
    } else {
      emitStderr(
        `[claude-llm] revise v${result.strategy.version} rejected by sanity gate: ${gate.reason} — keeping v${state.strategy.version}\n`,
      );
    }
  } else {
    emitStderr(
      `[claude-llm] revise failed: ${result.reason} — keeping v${state.strategy.version}\n`,
    );
  }
  state.pendingPhase = null;
  state.pending = null;
  void obs;
}

/**
 * live sanity ゲート(ADR 0002 A-3): revise 候補を直近観測で実行し、前版より実行時エラーを
 * 増やす場合のみ却下する。noop は valid なので「正気だが弱い」変更は通す(真の PnL ゲートは
 * offline /strategy-evolve の責務)。観測が無ければ常に通過。
 */
export function passesSanityGate(
  candidate: Strategy,
  prev: Strategy | null,
  recentObs: AgentObservation[],
): { ok: true } | { ok: false; reason: string } {
  if (recentObs.length === 0) return { ok: true };
  let candErr = 0;
  let prevErr = 0;
  for (const obs of recentObs) {
    if (!runExecutor(candidate, obs, helpersBase, EXECUTOR_TIMEOUT_MS).ok)
      candErr++;
    if (prev && !runExecutor(prev, obs, helpersBase, EXECUTOR_TIMEOUT_MS).ok)
      prevErr++;
  }
  if (candErr > prevErr) {
    return {
      ok: false,
      reason: `candidate errors on ${candErr}/${recentObs.length} recent obs (prev ${prevErr})`,
    };
  }
  return { ok: true };
}

/**
 * live PnL ロールバック(ADR 0002 の rollback_condition を機構化)。
 * 採用直後に基準(総額・α 評価額・前版の α レート)を取り、(a)総額が ROLLBACK_DROP 以上急落、
 * または (b)新版の α レートが前版より ROLLBACK_UNDERPERFORM 以上劣る とき前版へ巻き戻す。
 * ROLLBACK_GRADUATE ラウンド生き延びたら「合格」として監視を解除する。
 * α(β 除去)で比較するのは、総額のノイズに緩やかな劣化が埋もれるのを避けるため(冒頭コメント参照)。
 */
export function maybeRollback(state: State, obs: AgentObservation): void {
  // 新版が live になった最初のラウンドで基準を取る。
  if (state.pendingAdoption) {
    const refPrice = obs.fairPriceUsdcPerWeth;
    state.refPrice = refPrice;
    state.adoptUsd = obs.inventory.valueUsdc;
    state.adoptAlpha = alphaValueUsd(obs.inventory, refPrice);
    state.adoptRound = obs.round;
    // 前版の α レート(per round)を直近 ROLLBACK_AB_WINDOW ラウンドの履歴から推定。
    const recs = state.history.recent();
    if (recs.length >= 2) {
      const k = Math.min(ROLLBACK_AB_WINDOW, recs.length);
      const start = recs[recs.length - k];
      const span = Math.max(1, obs.round - start.round);
      const startAlpha = alphaValueUsd(start, refPrice);
      state.prevAlphaRate = (state.adoptAlpha - startAlpha) / span;
    } else {
      state.prevAlphaRate = null; // 前版 track 不足 → 急落判定のみ
    }
    state.pendingAdoption = false;
    return;
  }
  if (!state.prevStrategy || state.adoptUsd === null || state.adoptUsd <= 0) {
    return;
  }
  const elapsed = obs.round - state.adoptRound;
  const revert = (reason: string): void => {
    const from = state.strategy?.version;
    const to = state.prevStrategy!.version;
    state.strategy = state.prevStrategy;
    logRollback(state, obs.round, from ?? null, to, reason);
    emitStderr(
      `[claude-llm] rollback v${from}→v${to} (${reason} over ${elapsed}r) — reverted to last good version\n`,
    );
    state.prevStrategy = null;
    state.adoptUsd = null;
    state.adoptAlpha = null;
    state.prevAlphaRate = null;
    state.lastReviseRound = obs.round; // 直後の連続 revise を抑制(cooldown)
  };

  // (a) 急落ガード(総額)
  if (elapsed >= ROLLBACK_WINDOW) {
    const drop = (state.adoptUsd - obs.inventory.valueUsdc) / state.adoptUsd;
    if (drop >= ROLLBACK_DROP) {
      revert(`drop=${(drop * 100).toFixed(1)}%`);
      return;
    }
  }
  // (b) A/B 劣化ガード(新版の α レートが前版の一定割合未満)
  if (
    elapsed >= ROLLBACK_AB_WINDOW &&
    state.prevAlphaRate !== null &&
    state.adoptAlpha !== null
  ) {
    const minRate = state.adoptUsd * ROLLBACK_MIN_RATE_FRAC;
    // 前版が明確にプラスの edge を持っていたときだけ比較する(基準が無いと判定不能)。
    if (state.prevAlphaRate > minRate) {
      const newAlphaRate =
        (alphaValueUsd(obs.inventory, state.refPrice) - state.adoptAlpha) /
        elapsed;
      if (newAlphaRate < state.prevAlphaRate * ROLLBACK_KEEP_FRACTION) {
        revert(
          `αrate ${newAlphaRate.toFixed(1)}<${(ROLLBACK_KEEP_FRACTION * 100).toFixed(0)}% of prev ${state.prevAlphaRate.toFixed(1)}/r`,
        );
        return;
      }
    }
  }
  // 一定期間崩れなければ合格として監視解除。
  if (elapsed >= ROLLBACK_GRADUATE) {
    state.prevStrategy = null;
    state.adoptUsd = null;
    state.adoptAlpha = null;
    state.prevAlphaRate = null;
  }
}

function logRollback(
  state: State,
  round: number,
  fromVersion: number | null,
  toVersion: number,
  reason: string,
): void {
  if (!state.rollbacksPath) return;
  appendFileSync(
    state.rollbacksPath,
    `${JSON.stringify({ ts: new Date().toISOString(), round, fromVersion, toVersion, reason })}\n`,
  );
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
  state.rollbacksPath = join(state.agentDir, "rollbacks.jsonl");
  writeFileSync(state.decisionsPath, "");
  writeFileSync(state.callsPath, "");
  writeFileSync(state.rollbacksPath, "");
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
