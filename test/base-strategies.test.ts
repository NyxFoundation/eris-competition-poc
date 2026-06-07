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

test("cvbal ベース: balancer↔curve のスプレッド超で両建て bundle", () => {
  const s = getBaseStrategy("cvbal");
  assert.ok(s);
  const obs = syntheticObs();
  obs.protocols.balancer = { priceUsdcPerWeth: 1650 }; // 割安
  obs.protocols.curve = { priceUsdcPerWeth: 1700 }; // 割高 → spread ~3%
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.action.type, "bundle");
    if (r.action.type === "bundle") {
      assert.equal(r.action.actions.length, 2);
      assert.equal(r.action.actions[0].type, "balancerSwap"); // 割安側で買い
      assert.equal(r.action.actions[1].type, "curveSwap"); // 割高側で売り
    }
  }
});

test("cvbal ベース: スプレッドが小さければ noop", () => {
  const s = getBaseStrategy("cvbal");
  assert.ok(s);
  const obs = syntheticObs();
  obs.protocols.balancer = { priceUsdcPerWeth: 1700 };
  obs.protocols.curve = { priceUsdcPerWeth: 1700 };
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.action.type, "noop");
});

test("dnlp ベース: LP 無→mint、LP 有/short 無→GMX short ヘッジ", () => {
  const s = getBaseStrategy("dnlp");
  assert.ok(s);
  // State A: LP 無し → mint
  const a = syntheticObs();
  a.protocols.gmx = { marketPriceUsd: 1700 };
  const ra = runExecutor(s, a, helpers);
  assert.equal(ra.ok, true);
  if (ra.ok) assert.equal(ra.action.type, "mintLiquidity");

  // State B: LP 有り(WETH エクスポージャ)/ short 無し → gmxIncrease short
  const b = syntheticObs();
  b.limits.maxGmxSizeUsd = "100000000000000000000000000000000000"; // 1e35
  b.protocols.gmx = { marketPriceUsd: 1700 };
  b.protocols.uniswap!.positions = [
    {
      tokenId: "1",
      tickLower: 199900,
      tickUpper: 200100,
      liquidity: "1000",
      tokensOwedWethWei: "0",
      tokensOwedUsdcUnits: "0",
      amountWethWei: "1000000000000000000", // 1 WETH エクスポージャ
      amountUsdcUnits: "0",
      valueUsdc: 1700,
    },
  ];
  const rb = runExecutor(s, b, helpers);
  assert.equal(rb.ok, true);
  if (rb.ok) {
    assert.equal(rb.action.type, "gmxIncrease");
    if (rb.action.type === "gmxIncrease") assert.equal(rb.action.isLong, false);
  }
});

test("gmxperp ベース: ポジション無しなら ETH long を open", () => {
  const s = getBaseStrategy("gmxperp");
  assert.ok(s);
  const obs = syntheticObs();
  obs.limits.maxGmxSizeUsd = "100000000000000000000000000000000000"; // 1e35
  obs.protocols.gmx = { marketPriceUsd: 1700 };
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.action.type, "gmxIncrease");
    if (r.action.type === "gmxIncrease") assert.equal(r.action.isLong, true);
  }
});

test("gmxrev ベース: 価格が MA より高ければ short を open", () => {
  const s = getBaseStrategy("gmxrev");
  assert.ok(s);
  const obs = syntheticObs();
  obs.limits.maxGmxSizeUsd = "100000000000000000000000000000000000";
  obs.protocols.gmx = { marketPriceUsd: 1700 };
  obs.fairPriceUsdcPerWeth = 1700;
  obs.history = Array.from({ length: 12 }, (_, i) => ({
    round: i + 1,
    poolPriceUsdcPerWeth: 1690,
    fairPriceUsdcPerWeth: 1690, // MA=1690 < price 1700 → dev +0.59% > 40bps
  }));
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.action.type, "gmxIncrease");
    if (r.action.type === "gmxIncrease") assert.equal(r.action.isLong, false); // 割高→short
  }
});

test("gmxtrend ベース: 上昇トレンドなら long を open", () => {
  const s = getBaseStrategy("gmxtrend");
  assert.ok(s);
  const obs = syntheticObs();
  obs.limits.maxGmxSizeUsd = "100000000000000000000000000000000000";
  obs.protocols.gmx = { marketPriceUsd: 1700 };
  obs.history = Array.from({ length: 8 }, (_, i) => ({
    round: i + 1,
    poolPriceUsdcPerWeth: 1680 + i * 8,
    fairPriceUsdcPerWeth: 1680 + i * 8, // 単調増加 → up-trend
  }));
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.action.type, "gmxIncrease");
    if (r.action.type === "gmxIncrease") assert.equal(r.action.isLong, true);
  }
});

test("fairmm ベース: ポジション無しなら fair 含意 tick 中心に mint", () => {
  const s = getBaseStrategy("fairmm");
  assert.ok(s);
  const r = runExecutor(s, syntheticObs(), helpers); // pool 1690 < fair 1700
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

test("jitlp ベース: 高ボラで mint、低ボラ/履歴不足で noop", () => {
  const s = getBaseStrategy("jitlp");
  assert.ok(s);
  const flat = syntheticObs();
  flat.history = Array.from({ length: 14 }, (_, i) => ({
    round: i + 1,
    poolPriceUsdcPerWeth: 1700,
    fairPriceUsdcPerWeth: 1700, // vol 0
  }));
  const r0 = runExecutor(s, flat, helpers);
  assert.equal(r0.ok, true);
  if (r0.ok) assert.equal(r0.action.type, "noop");

  const vol = syntheticObs();
  vol.history = Array.from({ length: 14 }, (_, i) => ({
    round: i + 1,
    poolPriceUsdcPerWeth: i % 2 === 0 ? 1700 : 1785,
    fairPriceUsdcPerWeth: i % 2 === 0 ? 1700 : 1785, // ~5% スイング
  }));
  const r1 = runExecutor(s, vol, helpers);
  assert.equal(r1.ok, true);
  if (r1.ok) assert.equal(r1.action.type, "mintLiquidity");
});

test("ladder ベース: 空なら次段を mint、満杯なら noop", () => {
  const s = getBaseStrategy("ladder");
  assert.ok(s);
  const empty = runExecutor(s, syntheticObs(), helpers);
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal(empty.action.type, "mintLiquidity");

  const full = syntheticObs();
  full.protocols.uniswap!.positions = [1, 2, 3].map((id) => ({
    tokenId: String(id),
    tickLower: 199900,
    tickUpper: 200100,
    liquidity: "1000",
    tokensOwedWethWei: "0",
    tokensOwedUsdcUnits: "0",
    amountWethWei: "0",
    amountUsdcUnits: "0",
    valueUsdc: 1,
  }));
  const rf = runExecutor(s, full, helpers); // steps 既定 3 → 満杯
  assert.equal(rf.ok, true);
  if (rf.ok) assert.equal(rf.action.type, "noop");
});

function emptyAave() {
  return {
    healthFactor: "0",
    totalCollateralBase: "0",
    totalDebtBase: "0",
    availableBorrowsBase: "0",
    supplied: {} as Record<string, string>,
    borrowed: {} as Record<string, string>,
  };
}

test("aaveloop ベース: 担保未供給・遊休USDC無しなら WETH を supply", () => {
  const s = getBaseStrategy("aaveloop");
  assert.ok(s);
  const obs = syntheticObs();
  obs.balances.usdcUnits = "0";
  obs.limits.maxAaveSupplyWethWei = "5000000000000000000";
  obs.limits.maxAaveBorrowUsdcUnits = "5000000000";
  obs.protocols.aave = emptyAave();
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.action.type, "aaveSupply");
    if (r.action.type === "aaveSupply") assert.equal(r.action.asset, "WETH");
  }
});

test("aaveloop ベース: 担保あり・LTV 未達・借入余力ありなら USDC を borrow", () => {
  const s = getBaseStrategy("aaveloop");
  assert.ok(s);
  const obs = syntheticObs();
  obs.balances.usdcUnits = "0";
  obs.balances.wethWei = "0";
  obs.limits.maxAaveBorrowUsdcUnits = "5000000000";
  obs.protocols.aave = {
    ...emptyAave(),
    totalCollateralBase: String(5000n * 10n ** 8n), // $5000
    availableBorrowsBase: String(3000n * 10n ** 8n), // $3000
    supplied: { WETH: "3000000000000000000" },
  };
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.action.type, "aaveBorrow");
    if (r.action.type === "aaveBorrow") assert.equal(r.action.asset, "USDC");
  }
});

test("crossvenue ベース: 最安 venue で買い最高 venue で売る 2-leg bundle", () => {
  const s = getBaseStrategy("crossvenue");
  assert.ok(s);
  const obs = syntheticObs();
  obs.protocols.uniswap!.pool.priceUsdcPerWeth = 1700;
  obs.protocols.balancer = { priceUsdcPerWeth: 1650 }; // 最安
  obs.protocols.curve = { priceUsdcPerWeth: 1720 }; // 最高
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.action.type, "bundle");
    if (r.action.type === "bundle") {
      assert.equal(r.action.actions[0].type, "balancerSwap"); // 最安で買い
      assert.equal(r.action.actions[1].type, "curveSwap"); // 最高で売り
    }
  }
});

test("crossvenue ベース: venue が 2 未満なら noop", () => {
  const s = getBaseStrategy("crossvenue");
  assert.ok(s);
  const obs = syntheticObs(); // uniswap のみ
  const r = runExecutor(s, obs, helpers);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.action.type, "noop");
});

test("lpyield ベース: LP 無→mint、LP 有+遊休USDC→Aave supply", () => {
  const s = getBaseStrategy("lpyield");
  assert.ok(s);
  // LP 無し → mint
  const a = syntheticObs();
  a.protocols.aave = emptyAave();
  const ra = runExecutor(s, a, helpers);
  assert.equal(ra.ok, true);
  if (ra.ok) assert.equal(ra.action.type, "mintLiquidity");

  // LP 有り + 遊休 USDC → Aave へ park
  const b = syntheticObs();
  b.protocols.aave = emptyAave();
  b.balances.usdcUnits = "10000000000"; // 10000 USDC
  b.protocols.uniswap!.positions = [
    {
      tokenId: "1",
      tickLower: 199900,
      tickUpper: 200100,
      liquidity: "1000",
      tokensOwedWethWei: "0",
      tokensOwedUsdcUnits: "0",
      amountWethWei: "0",
      amountUsdcUnits: "0",
      valueUsdc: 1,
    },
  ];
  const rb = runExecutor(s, b, helpers);
  assert.equal(rb.ok, true);
  if (rb.ok) {
    assert.equal(rb.action.type, "aaveSupply");
    if (rb.action.type === "aaveSupply") assert.equal(rb.action.asset, "USDC");
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
