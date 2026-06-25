import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createState,
  handleLine,
  maybeRollback,
  passesSanityGate,
  whichReviseReason,
} from "../src/llm/claudeAgent.js";
import type {
  Strategist,
  StrategyResult,
} from "../src/llm/claudeStrategist.js";
import type { Strategy } from "../src/llm/strategy.js";
import type { AgentObservation } from "../src/types.js";
import type { ReviseReason } from "../src/llm/prompts.js";
import type { RoundRecord } from "../src/llm/history.js";

function makeObs(
  round: number,
  valueUsdc = 100,
  runId = `test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): AgentObservation {
  return {
    kind: "observation",
    runId,
    round,
    blockNumber: String(round + 1),
    agentAddress: "0x0000000000000000000000000000000000000001",
    fairPriceUsdcPerWeth: 3030,
    oraclePrices: { wethUsd: 3000, usdcUsd: 1 },
    enabledProtocols: ["uniswap"],
    protocols: {
      uniswap: {
        pool: {
          pair: "WETH/USDC",
          fee: 500,
          priceUsdcPerWeth: 3000,
          tick: 0,
          tickSpacing: 10,
        },
        positions: [],
      },
    },
    balances: {
      ethWei: "1000000000000000000",
      wethWei: "10000000000000000000",
      usdcUnits: "25000000000",
    },
    inventory: { valueUsdc, weth: 10, usdc: 25000, eth: 1 },
    history: [],
    limits: {
      maxWethInWei: "1000000000000000000",
      maxUsdcInUnits: "5000000000",
      defaultPriorityFeePerGasWei: "100000000",
      maxPriorityFeePerGasWei: "5000000000",
      defaultSlippageBps: 50,
      maxBundleActions: 5,
      maxLpWethWei: "1000000000000000000",
      maxLpUsdcUnits: "5000000000",
      maxOpenPositions: 10,
      maxGmxSizeUsd: "0",
      maxAaveSupplyWethWei: "0",
      maxAaveBorrowUsdcUnits: "0",
    },
  };
}

/**
 * Strategist stub that can either resolve immediately or defer until the test
 * calls .release(). Deferral lets the test observe state.pendingPhase mid-flight.
 */
class StubStrategist implements Strategist {
  initCount = 0;
  reviseCount = 0;
  lastReviseReason: ReviseReason | null = null;
  fail = false;
  defer = false;
  private queue: Array<{
    resolve: (r: StrategyResult) => void;
    phase: "init" | "revise";
    version: number;
    reason?: ReviseReason;
  }> = [];
  constructor(
    private executorTs = `return { type: "noop", reason: "stub v" + params.v };`,
  ) {}

  init(_obs: AgentObservation, version: number): Promise<StrategyResult> {
    this.initCount++;
    return this.build("init", version);
  }
  revise(
    _p: Strategy,
    _h: RoundRecord[],
    reason: ReviseReason,
    _i: number,
    _c: number,
    version: number,
  ): Promise<StrategyResult> {
    this.reviseCount++;
    this.lastReviseReason = reason;
    return this.build("revise", version, reason);
  }
  private build(
    phase: "init" | "revise",
    version: number,
    reason?: ReviseReason,
  ): Promise<StrategyResult> {
    const make = (): StrategyResult =>
      this.fail
        ? { ok: false, reason: "stub failure" }
        : {
            ok: true,
            strategy: {
              version,
              notes: `stub ${phase}${reason ? ` (${reason})` : ""}`,
              params: { v: version },
              executorTs: this.executorTs,
            },
            meta: {
              phase,
              latencyMs: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          };
    if (!this.defer) return Promise.resolve(make());
    return new Promise<StrategyResult>((resolve) => {
      this.queue.push({
        resolve: () => resolve(make()),
        phase,
        version,
        reason,
      });
    });
  }
  release(): void {
    const items = this.queue;
    this.queue = [];
    for (const item of items)
      item.resolve(undefined as unknown as StrategyResult);
  }
}

function withTmpReportDir<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.REPORT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "eris-llm-test-"));
  process.env.REPORT_DIR = dir;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.REPORT_DIR;
    else process.env.REPORT_DIR = prev;
  });
}

test("first observation returns noop and init runs in the background", async () => {
  await withTmpReportDir(async () => {
    const state = createState("test-agent");
    const strategist = new StubStrategist();
    strategist.defer = true;
    const action = await handleLine(
      JSON.stringify(makeObs(0)),
      state,
      strategist,
    );
    assert.equal(action.type, "noop");
    if (action.type === "noop")
      assert.match(action.reason ?? "", /strategy init pending/);
    // While deferred, pendingPhase is still "init" and strategy is unset.
    assert.equal(state.pendingPhase, "init");
    assert.equal(state.strategy === null, true);
    strategist.release();
    await state.pending;
    assert.equal(state.strategy?.version, 1);
    assert.equal(state.pendingPhase, null);
  });
});

test("after init, executor produces real actions on subsequent rounds", async () => {
  await withTmpReportDir(async () => {
    const state = createState("test-agent");
    const strategist = new StubStrategist(
      `return { type: "swap", tokenIn: "WETH", amountIn: "1000000000" };`,
    );
    await handleLine(JSON.stringify(makeObs(0)), state, strategist);
    await state.pending;
    const action = await handleLine(
      JSON.stringify(makeObs(1)),
      state,
      strategist,
    );
    assert.equal(action.type, "swap");
  });
});

test("strategy revision fires on the scheduled round and bumps version", async () => {
  await withTmpReportDir(async () => {
    const state = createState("test-agent");
    const strategist = new StubStrategist();
    await handleLine(JSON.stringify(makeObs(0)), state, strategist);
    await state.pending;
    assert.equal(state.strategy?.version, 1);

    for (let r = 1; r < 60; r++) {
      await handleLine(JSON.stringify(makeObs(r)), state, strategist);
    }
    strategist.defer = true;
    await handleLine(JSON.stringify(makeObs(60)), state, strategist);
    assert.equal(state.pendingPhase, "revise");
    strategist.release();
    await state.pending;
    assert.equal(state.strategy?.version, 2);
    assert.equal(strategist.lastReviseReason, "scheduled");
  });
});

test("strategy revision fires on PnL drop", async () => {
  await withTmpReportDir(async () => {
    const state = createState("test-agent");
    const strategist = new StubStrategist();
    await handleLine(JSON.stringify(makeObs(0, 100)), state, strategist);
    await state.pending;
    strategist.defer = true;
    await handleLine(JSON.stringify(makeObs(3, 90)), state, strategist);
    assert.equal(state.pendingPhase, "revise");
    strategist.release();
    await state.pending;
    assert.equal(strategist.lastReviseReason, "pnl_drop");
    assert.equal(state.strategy?.version, 2);
  });
});

test("failed init leaves no strategy and retries on next round", async () => {
  await withTmpReportDir(async () => {
    const state = createState("test-agent");
    const strategist = new StubStrategist();
    strategist.fail = true;
    await handleLine(JSON.stringify(makeObs(0)), state, strategist);
    await state.pending;
    assert.equal(state.strategy, null);
    assert.equal(state.pendingPhase, null);
    assert.equal(strategist.initCount, 1);

    await handleLine(JSON.stringify(makeObs(1)), state, strategist);
    await state.pending;
    assert.equal(strategist.initCount, 2, "second round retries init");
  });
});

test("failed revise keeps the previous strategy", async () => {
  await withTmpReportDir(async () => {
    const state = createState("test-agent");
    const strategist = new StubStrategist();
    await handleLine(JSON.stringify(makeObs(0)), state, strategist);
    await state.pending;
    assert.equal(state.strategy?.version, 1);
    for (let r = 1; r < 60; r++) {
      await handleLine(JSON.stringify(makeObs(r)), state, strategist);
    }
    strategist.fail = true;
    await handleLine(JSON.stringify(makeObs(60)), state, strategist);
    await state.pending;
    assert.equal(
      state.strategy?.version,
      1,
      "old strategy retained when revise fails",
    );
    assert.equal(strategist.reviseCount, 1);
  });
});

test("strategy + decisions + claude-calls files land under REPORT_DIR/runId/agent-<id>", async () => {
  await withTmpReportDir(async () => {
    const state = createState("persist-agent");
    const strategist = new StubStrategist();
    const obs = makeObs(0);
    await handleLine(JSON.stringify(obs), state, strategist);
    await state.pending;
    const dir = join(process.env.REPORT_DIR!, obs.runId, "agent-persist-agent");
    assert.ok(existsSync(dir), `expected dir ${dir}`);
    const files = readdirSync(dir);
    assert.ok(files.includes("strategy-v1.md"));
    assert.ok(files.includes("strategy-v1.params.json"));
    assert.ok(files.includes("strategy-v1.executor.ts"));
    assert.ok(files.includes("decisions.jsonl"));
    assert.ok(files.includes("claude-calls.jsonl"));
    const md = readFileSync(join(dir, "strategy-v1.md"), "utf8");
    assert.match(md, /Strategy v1/);
    const calls = readFileSync(join(dir, "claude-calls.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(calls.length, 1);
    const callRow = JSON.parse(calls[0]);
    assert.equal(callRow.phase, "init");
    assert.equal(callRow.ok, true);
    assert.equal(callRow.strategyVersion, 1);
  });
});

test("decisions.jsonl records noop.reason from a successful executor", async () => {
  await withTmpReportDir(async () => {
    const runId = `reason-test-${process.pid}`;
    const state = createState("reason-agent");
    const strategist = new StubStrategist(
      `return { type: "noop", reason: "edge below threshold" };`,
    );
    await handleLine(JSON.stringify(makeObs(0, 100, runId)), state, strategist);
    await state.pending;
    await handleLine(JSON.stringify(makeObs(1, 100, runId)), state, strategist);

    const decisionsPath = join(
      process.env.REPORT_DIR!,
      runId,
      "agent-reason-agent",
      "decisions.jsonl",
    );
    const rows = readFileSync(decisionsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const last = rows.at(-1);
    assert.equal(last.actionType, "noop");
    assert.equal(last.ok, true);
    assert.equal(last.reason, "edge below threshold");
  });
});

test("シード付き: ベース戦略を v1 にし、改訂で v2 へ磨く(LLM init は呼ばない)", async () => {
  const prev = process.env.ERIS_BASE_STRATEGY;
  process.env.ERIS_BASE_STRATEGY = "arb";
  try {
    await withTmpReportDir(async () => {
      const state = createState("seeded-agent");
      const strategist = new StubStrategist(
        `return { type: "noop", reason: "revised v" + params.v };`,
      );
      // round 0: ベース arb を v1 として決定論シード。strategist.init は呼ばれない。
      await handleLine(JSON.stringify(makeObs(0)), state, strategist);
      await state.pending;
      assert.equal(state.strategy?.version, 1);
      assert.equal(
        strategist.initCount,
        0,
        "seeded のとき LLM init はスキップ",
      );
      assert.ok(
        state.strategy?.executorTs.includes("gap"),
        "v1 は arb ベースの executor",
      );

      for (let r = 1; r < 60; r++) {
        await handleLine(JSON.stringify(makeObs(r)), state, strategist);
      }
      // round 60: スケジュール改訂 → stub が v2 を返し、ベースが磨かれる。
      strategist.defer = true;
      await handleLine(JSON.stringify(makeObs(60)), state, strategist);
      assert.equal(state.pendingPhase, "revise");
      strategist.release();
      await state.pending;
      assert.equal(state.strategy?.version, 2, "ベースが v2 に改訂される");
      assert.equal(strategist.reviseCount, 1);
      assert.equal(strategist.lastReviseReason, "scheduled");
    });
  } finally {
    if (prev === undefined) delete process.env.ERIS_BASE_STRATEGY;
    else process.env.ERIS_BASE_STRATEGY = prev;
  }
});

test("whichReviseReason cadence and drawdown logic", () => {
  // Cadence: round % 60 == 0 and round > 0
  assert.equal(whichReviseReason(0, -1, 100, 100), null);
  assert.equal(whichReviseReason(60, -1, 100, 100), "scheduled");
  assert.equal(
    whichReviseReason(60, 60, 100, 100),
    null,
    "no double-fire on the same round",
  );
  // Drawdown -5%
  assert.equal(
    whichReviseReason(3, -1, 95, 100),
    null,
    "boundary: -5% exactly is not triggered",
  );
  assert.equal(whichReviseReason(3, -1, 94.9, 100), "pnl_drop");
  // Initial 0 → never trigger drawdown
  assert.equal(whichReviseReason(3, -1, -10, 0), null);
});

test("whichReviseReason: revise オフセットで stagger できる(多数並列の競合緩和)", () => {
  // reviewEvery=60, offset=0: 60,120,... で発火、20 では非発火
  assert.equal(whichReviseReason(60, -1, 100, 100, 60, 0), "scheduled");
  assert.equal(whichReviseReason(20, -1, 100, 100, 60, 0), null);
  // offset=20: (round-20)%60==0 → 20,80,140 で発火、60 では非発火（位相がずれる）
  assert.equal(whichReviseReason(80, -1, 100, 100, 60, 20), "scheduled");
  assert.equal(whichReviseReason(60, -1, 100, 100, 60, 20), null);
  // offset 直前/未満は発火しない(round<=offset)
  assert.equal(
    whichReviseReason(20, -1, 100, 100, 60, 20),
    null,
    "round==offset は発火しない",
  );
  // 異なる offset の agent は別 round で発火 → 同時刻の revise が分散する
  const a = whichReviseReason(120, -1, 100, 100, 60, 0); // agent A: 発火
  const b = whichReviseReason(120, -1, 100, 100, 60, 20); // agent B: 非発火(140 で発火)
  assert.equal(a, "scheduled");
  assert.equal(b, null);
});

function gateStrat(executorTs: string): Strategy {
  return { version: 1, notes: "t", params: {}, executorTs };
}
const GATE_CLEAN = gateStrat(`return { type: "noop", reason: "ok" };`);
const GATE_BROKEN = gateStrat(`throw new Error("boom");`);

test("passesSanityGate: 観測が無ければ常に通過", () => {
  assert.equal(passesSanityGate(GATE_BROKEN, GATE_CLEAN, []).ok, true);
});

test("passesSanityGate: 候補が前版よりエラーを増やすなら却下", () => {
  const obs = [makeObs(1), makeObs(2)];
  const r = passesSanityGate(GATE_BROKEN, GATE_CLEAN, obs);
  assert.equal(r.ok, false);
});

test("passesSanityGate: 候補がクリーンなら前版が壊れていても通過", () => {
  const obs = [makeObs(1)];
  assert.equal(passesSanityGate(GATE_CLEAN, GATE_BROKEN, obs).ok, true);
  assert.equal(passesSanityGate(GATE_CLEAN, GATE_CLEAN, obs).ok, true);
});

test("passesSanityGate: 候補が取引頻度を過剰に増やすなら却下", () => {
  const aggressive = gateStrat(
    `return { type: "swap", tokenIn: "WETH", amountIn: "1000000000" };`,
  );
  const obs = Array.from({ length: 6 }, (_, i) => makeObs(i + 1));
  const r = passesSanityGate(aggressive, GATE_CLEAN, obs);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /too aggressive/);
});

test("passesSanityGate: 候補が priority fee 予算を過剰に増やすなら却下", () => {
  const prev = gateStrat(
    `return { type: "swap", tokenIn: "WETH", amountIn: "1000000000", maxPriorityFeePerGasWei: "100000000" };`,
  );
  const candidate = gateStrat(
    `return { type: "swap", tokenIn: "WETH", amountIn: "1000000000", maxPriorityFeePerGasWei: "300000000" };`,
  );
  const obs = [makeObs(1), makeObs(2)];
  const r = passesSanityGate(candidate, prev, obs);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /priority-fee budget/);
});

function rbStrat(v: number): Strategy {
  return {
    version: v,
    notes: "t",
    params: {},
    executorTs: `return { type: "noop" };`,
  };
}

test("maybeRollback: 採用後の下落で前版へ巻き戻す(window 経過後)", () => {
  const s = createState("rb");
  s.strategy = rbStrat(2);
  s.prevStrategy = rbStrat(1);
  s.adoptUsd = 100;
  s.adoptRound = 10;
  s.pendingAdoption = false;
  // window(3)未満 → 戻さない
  maybeRollback(s, makeObs(12, 90));
  assert.equal(s.strategy?.version, 2);
  // window 経過 & drop 5% >= 2.5% → 前版へ
  maybeRollback(s, makeObs(15, 95));
  assert.equal(s.strategy?.version, 1);
  assert.equal(s.prevStrategy, null);
});

test("maybeRollback: 採用後の高 revert 率で前版へ巻き戻す", () => {
  const s = createState("rbrev");
  s.strategy = rbStrat(2);
  s.prevStrategy = rbStrat(1);
  s.adoptUsd = 100;
  s.adoptRound = 10;
  s.pendingAdoption = false;
  const obs = makeObs(13, 101);
  obs.competition = {
    maxCompetitorPriorityFeeWei: "100000000",
    maxBlockPriorityFeeWei: "100000000",
    lastTxIndex: 3,
    recentRevertRate: 0.4,
    recentSampleSize: 5,
  };
  maybeRollback(s, obs);
  assert.equal(s.strategy?.version, 1);
  assert.equal(s.prevStrategy, null);
});

test("maybeRollback: pendingAdoption で基準化、軽微下落は維持し graduate で監視解除", () => {
  const s = createState("rb");
  s.strategy = rbStrat(2);
  s.prevStrategy = rbStrat(1);
  s.pendingAdoption = true;
  maybeRollback(s, makeObs(10, 100)); // 基準化
  assert.equal(s.adoptUsd, 100);
  assert.equal(s.adoptRound, 10);
  // 下落 2% < 2.5% → 維持(graduate 前は監視継続)
  maybeRollback(s, makeObs(20, 98));
  assert.equal(s.strategy?.version, 2);
  assert.notEqual(s.prevStrategy, null);
  // graduate(30)経過 & 健全 → 監視解除
  maybeRollback(s, makeObs(55, 101));
  assert.equal(s.prevStrategy, null);
});

test("maybeRollback: 新版の α レートが前版の 75% 未満なら A/B で巻き戻す", () => {
  const s = createState("rbab");
  s.strategy = rbStrat(2);
  s.prevStrategy = rbStrat(1);
  // 前版の履歴: 純 USDC を +10/round で増やす(alpha rate ≈ 10/round)。
  for (let r = 0; r <= 20; r++) {
    s.history.push({
      round: r,
      poolPrice: 3000,
      fairPrice: 3030,
      inventoryUsd: 1000 + r * 10,
      weth: 0,
      usdc: 1000 + r * 10,
      eth: 0,
      openPositions: 0,
      action: { type: "noop" },
      executorLogs: [],
      executorOk: true,
    });
  }
  // 純 USDC 観測(weth=eth=0 → alpha=usdc)で alpha を直接制御する。
  const obsAlpha = (round: number, usdc: number): AgentObservation => {
    const o = makeObs(round, usdc);
    o.inventory = { valueUsdc: usdc, weth: 0, usdc, eth: 0 };
    return o;
  };
  s.pendingAdoption = true;
  maybeRollback(s, obsAlpha(20, 1200)); // 採用: prevAlphaRate ≈ 10/round
  // 新版は alpha がほぼ伸びない(25 round で +30 = 1.2/round < 75% of 10) → 巻き戻し
  maybeRollback(s, obsAlpha(45, 1230));
  assert.equal(s.strategy?.version, 1);
  assert.equal(s.prevStrategy, null);
});

test("maybeRollback: 新版が前版の α レートを概ね維持すれば A/B では戻さない", () => {
  const s = createState("rbab2");
  s.strategy = rbStrat(2);
  s.prevStrategy = rbStrat(1);
  for (let r = 0; r <= 20; r++) {
    s.history.push({
      round: r,
      poolPrice: 3000,
      fairPrice: 3030,
      inventoryUsd: 1000 + r * 10,
      weth: 0,
      usdc: 1000 + r * 10,
      eth: 0,
      openPositions: 0,
      action: { type: "noop" },
      executorLogs: [],
      executorOk: true,
    });
  }
  const obsAlpha = (round: number, usdc: number): AgentObservation => {
    const o = makeObs(round, usdc);
    o.inventory = { valueUsdc: usdc, weth: 0, usdc, eth: 0 };
    return o;
  };
  s.pendingAdoption = true;
  maybeRollback(s, obsAlpha(20, 1200));
  // 新版も ~9/round 維持(25 round で +225) → 75% 超なので維持
  maybeRollback(s, obsAlpha(45, 1425));
  assert.equal(s.strategy?.version, 2);
});
