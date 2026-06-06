import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_STRATEGY_IDS,
  getBaseStrategy,
} from "../src/llm/baseStrategies.js";
import {
  DEFAULT_ADDRESSES,
  checkExecutorSyntax,
  runExecutor,
} from "../src/llm/strategy.js";
import { createState, seedStrategy } from "../src/llm/claudeAgent.js";
import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import type { AgentObservation } from "../src/types.js";

const helpers = {
  parseUnits,
  formatUnits,
  encodeFunctionData,
  ADDRESSES: DEFAULT_ADDRESSES,
};

// executor が読むフィールドを満たす最小の観測。
function syntheticObs(
  overrides: Partial<AgentObservation> = {},
): AgentObservation {
  return {
    kind: "observation",
    runId: "test",
    round: 1,
    blockNumber: "1",
    agentAddress: "0x0000000000000000000000000000000000000001",
    fairPriceUsdcPerWeth: 1700,
    oraclePrices: { wethUsd: 1700, usdcUsd: 1 },
    enabledProtocols: ["uniswap"],
    balances: {
      ethWei: "1000000000000000000",
      wethWei: "5000000000000000000",
      usdcUnits: "10000000000",
    },
    inventory: { valueUsdc: 18500, weth: 5, usdc: 10000, eth: 1 },
    history: [],
    limits: {
      maxWethInWei: "1000000000000000000",
      maxUsdcInUnits: "5000000000",
      defaultPriorityFeePerGasWei: "100000000",
      maxPriorityFeePerGasWei: "5000000000",
      defaultSlippageBps: 75,
      maxBundleActions: 5,
      maxLpWethWei: "1000000000000000000",
      maxLpUsdcUnits: "5000000000",
      maxOpenPositions: 10,
      maxGmxSizeUsd: "0",
      maxAaveSupplyWethWei: "0",
      maxAaveBorrowUsdcUnits: "0",
    },
    protocols: {
      uniswap: {
        pool: {
          pair: "WETH/USDC",
          fee: 500,
          priceUsdcPerWeth: 1690, // fair 1700 vs pool 1690 → gap ~59bps
          tick: 200_000,
          tickSpacing: 10,
        },
        positions: [],
      },
    },
    ...overrides,
  } as AgentObservation;
}

test("ベース戦略は全 id が構文 OK でコンパイルできる", () => {
  for (const id of BASE_STRATEGY_IDS) {
    const s = getBaseStrategy(id);
    assert.ok(s, `getBaseStrategy(${id}) returns a strategy`);
    assert.equal(s.version, 1);
    assert.equal(checkExecutorSyntax(s.executorTs).ok, true, `${id} compiles`);
  }
});

test("arb ベース: gap があれば過小評価側へ swap し fee を入札", () => {
  const s = getBaseStrategy("arb");
  assert.ok(s);
  const r = runExecutor(s, syntheticObs(), helpers);
  assert.equal(r.ok, true);
  if (r.ok) {
    // fair(1700) > pool(1690) → USDC で WETH を買う
    assert.equal(r.action.type, "swap");
    if (r.action.type === "swap") {
      assert.equal(r.action.tokenIn, "USDC");
      assert.ok(BigInt(r.action.amountIn) > 0n);
      assert.ok(BigInt(r.action.maxPriorityFeePerGasWei ?? "0") > 0n);
    }
  }
});

test("arb ベース: gap が小さければ noop", () => {
  const s = getBaseStrategy("arb");
  assert.ok(s);
  const obs = syntheticObs();
  obs.protocols.uniswap!.pool.priceUsdcPerWeth = 1700; // gap 0
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.action.type, "noop");
});

test("lp ベース: ポジションが無ければ tick 整列したレンジを mint", () => {
  const s = getBaseStrategy("lp");
  assert.ok(s);
  const r = runExecutor(s, syntheticObs(), helpers);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.action.type, "mintLiquidity");
    if (r.action.type === "mintLiquidity") {
      assert.equal(r.action.tickLower % 10, 0);
      assert.equal(r.action.tickUpper % 10, 0);
      assert.ok(r.action.tickLower < r.action.tickUpper);
    }
  }
});

test("lp ベース: 既にポジションがあれば hold(noop)", () => {
  const s = getBaseStrategy("lp");
  assert.ok(s);
  const obs = syntheticObs();
  obs.protocols.uniswap!.positions = [
    {
      tokenId: "1",
      tickLower: 199990,
      tickUpper: 200010,
      liquidity: "1",
      tokensOwedWethWei: "0",
      tokensOwedUsdcUnits: "0",
      amountWethWei: "0",
      amountUsdcUnits: "0",
      valueUsdc: 100,
    },
  ];
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.action.type, "noop");
});

test("venue ベース: 最も乖離した venue で fair に寄せる swap", () => {
  const s = getBaseStrategy("venue");
  assert.ok(s);
  const obs = syntheticObs();
  obs.protocols.uniswap!.pool.priceUsdcPerWeth = 1695; // gap ~29bps
  obs.protocols.balancer = { priceUsdcPerWeth: 1650 }; // gap ~294bps（最大）
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.action.type, "balancerSwap"); // balancer が最大乖離
    if (r.action.type === "balancerSwap") {
      assert.equal(r.action.tokenIn, "USDC"); // pool<fair → WETH 割安 → USDC in
      assert.ok(BigInt(r.action.amountIn) > 0n);
    }
  }
});

test("venue ベース: どの venue も乖離が小さければ noop", () => {
  const s = getBaseStrategy("venue");
  assert.ok(s);
  const obs = syntheticObs();
  obs.protocols.uniswap!.pool.priceUsdcPerWeth = 1700; // gap 0
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.action.type, "noop");
});

test("aave ベース: 担保未供給なら WETH を supply", () => {
  const s = getBaseStrategy("aave");
  assert.ok(s);
  const obs = syntheticObs();
  obs.limits.maxAaveSupplyWethWei = "5000000000000000000";
  obs.limits.maxAaveBorrowUsdcUnits = "5000000000";
  obs.protocols.aave = {
    healthFactor: "0",
    totalCollateralBase: "0",
    totalDebtBase: "0",
    availableBorrowsBase: "0",
    supplied: {},
    borrowed: {},
  };
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.action.type, "aaveSupply");
    if (r.action.type === "aaveSupply") {
      assert.equal(r.action.asset, "WETH");
      assert.ok(BigInt(r.action.amount) > 0n);
    }
  }
});

test("aave ベース: 担保あり借入無しなら USDC を borrow", () => {
  const s = getBaseStrategy("aave");
  assert.ok(s);
  const obs = syntheticObs();
  obs.limits.maxAaveBorrowUsdcUnits = "5000000000";
  obs.protocols.aave = {
    healthFactor: "0",
    totalCollateralBase: "0",
    totalDebtBase: "0",
    availableBorrowsBase: "0",
    supplied: { WETH: "2500000000000000000" },
    borrowed: {},
  };
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.action.type, "aaveBorrow");
    if (r.action.type === "aaveBorrow") assert.equal(r.action.asset, "USDC");
  }
});

test("statarb ベース: 窓が貯まり |z| が大きければ swap、burn-in 中は noop", () => {
  const s = getBaseStrategy("statarb");
  assert.ok(s);
  // 履歴不足 → burn-in noop
  const cold = syntheticObs();
  cold.history = [];
  const r0 = runExecutor(s, cold, helpers);
  assert.equal(r0.ok, true);
  if (r0.ok) assert.equal(r0.action.type, "noop");

  // 12 点の小ノイズ履歴(平均~0, std>0)+ 現在 pool=1600(gap +6.25% → |z| 大)
  const hot = syntheticObs();
  hot.history = Array.from({ length: 12 }, (_, i) => ({
    round: i + 1,
    poolPriceUsdcPerWeth: i % 2 === 0 ? 1699 : 1701,
    fairPriceUsdcPerWeth: 1700,
  }));
  hot.protocols.uniswap!.pool.priceUsdcPerWeth = 1600;
  const r = runExecutor(s, hot, helpers);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.action.type, "swap");
    if (r.action.type === "swap") assert.equal(r.action.tokenIn, "USDC");
  }
});

test("getBaseStrategy: 未知 id / undefined は null", () => {
  assert.equal(getBaseStrategy("nope"), null);
  assert.equal(getBaseStrategy(undefined), null);
});

test("seedStrategy: ERIS_BASE_STRATEGY で v1 を決定論シード(LLM 不要)", () => {
  const prev = process.env.ERIS_BASE_STRATEGY;
  try {
    process.env.ERIS_BASE_STRATEGY = "arb";
    const state = createState("arb-evolver");
    assert.equal(seedStrategy(state), true);
    assert.equal(state.strategy?.version, 1);
    assert.ok(state.strategy?.executorTs.includes("gap"));
    // 既にあれば二重シードしない
    assert.equal(seedStrategy(state), false);

    // 未設定ならフォールバック(false)
    process.env.ERIS_BASE_STRATEGY = "";
    assert.equal(seedStrategy(createState("x")), false);
  } finally {
    if (prev === undefined) delete process.env.ERIS_BASE_STRATEGY;
    else process.env.ERIS_BASE_STRATEGY = prev;
  }
});
