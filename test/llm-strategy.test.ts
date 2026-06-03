import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import {
  DEFAULT_ADDRESSES,
  checkExecutorSyntax,
  parseStrategyFromToolInput,
  runExecutor,
  type ExecutorHelpers,
  type Strategy,
} from "../src/llm/strategy.js";
import type { AgentObservation } from "../src/types.js";

const helpersBase: Omit<ExecutorHelpers, "log"> = {
  parseUnits,
  formatUnits,
  encodeFunctionData,
  ADDRESSES: DEFAULT_ADDRESSES,
};

const obs: AgentObservation = {
  kind: "observation",
  runId: "test-run",
  round: 1,
  blockNumber: "1",
  agentAddress: "0x0000000000000000000000000000000000000001",
  fairPriceUsdcPerWeth: 3030, // +1% gap
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
  inventory: { valueUsdc: 55000, weth: 10, usdc: 25000, eth: 1 },
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

test("parseStrategyFromToolInput accepts a valid payload", () => {
  const result = parseStrategyFromToolInput(
    {
      notes: "Spread arb threshold strategy",
      params: { minGapBps: 15 },
      executor_ts: `return { type: "noop", reason: "n/a" };`,
    },
    1,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.strategy.version, 1);
    assert.equal(result.strategy.params.minGapBps, 15);
  }
});

test("parseStrategyFromToolInput rejects empty notes", () => {
  const result = parseStrategyFromToolInput(
    { notes: "", params: {}, executor_ts: 'return { type: "noop" };' },
    1,
  );
  assert.equal(result.ok, false);
});

test("parseStrategyFromToolInput rejects non-object params", () => {
  const result = parseStrategyFromToolInput(
    { notes: "x", params: [1, 2], executor_ts: 'return { type: "noop" };' },
    1,
  );
  assert.equal(result.ok, false);
});

test("checkExecutorSyntax catches syntax errors", () => {
  const bad = checkExecutorSyntax("return { type: 'noop' "); // unclosed brace
  assert.equal(bad.ok, false);
  const good = checkExecutorSyntax("return { type: 'noop' };");
  assert.equal(good.ok, true);
});

test("runExecutor returns a valid swap AgentAction", () => {
  const strategy: Strategy = {
    version: 1,
    notes: "swap on positive gap",
    params: { minGapBps: 50, sizeBps: 1000 },
    executorTs: `
      const gap = obs.fairPriceUsdcPerWeth / obs.protocols.uniswap.pool.priceUsdcPerWeth - 1;
      if (Math.abs(gap) < params.minGapBps / 10000) return { type: "noop", reason: "tight" };
      const tokenIn = gap > 0 ? "USDC" : "WETH";
      const cap = BigInt(tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits);
      const amountIn = (cap * BigInt(params.sizeBps)) / 10000n;
      helpers.log("placed swap");
      return { type: "swap", tokenIn, amountIn: amountIn.toString(), slippageBps: 50 };
    `,
  };
  const result = runExecutor(strategy, obs, helpersBase);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action.type, "swap");
    if (result.action.type === "swap") {
      assert.equal(result.action.tokenIn, "USDC");
      assert.ok(BigInt(result.action.amountIn) > 0n);
    }
    assert.deepEqual(result.logs, ["placed swap"]);
  }
});

test("runExecutor surfaces a noop fallback when executor throws", () => {
  const strategy: Strategy = {
    version: 1,
    notes: "buggy",
    params: {},
    executorTs: `throw new Error("boom");`,
  };
  const result = runExecutor(strategy, obs, helpersBase);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /executor threw/);
});

test("runExecutor rejects invalid AgentAction returned by executor", () => {
  const strategy: Strategy = {
    version: 1,
    notes: "wrong",
    params: {},
    executorTs: `return { type: "swap", tokenIn: "FOO", amountIn: "1" };`,
  };
  const result = runExecutor(strategy, obs, helpersBase);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /tokenIn/);
});

test("runExecutor rejects undefined return", () => {
  const strategy: Strategy = {
    version: 1,
    notes: "no return",
    params: {},
    executorTs: `helpers.log("no return");`,
  };
  const result = runExecutor(strategy, obs, helpersBase);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /undefined/);
});

test("runExecutor enforces timeout on infinite loop", () => {
  const strategy: Strategy = {
    version: 1,
    notes: "spinner",
    params: {},
    executorTs: `while (true) {}`,
  };
  const result = runExecutor(strategy, obs, helpersBase, 50);
  assert.equal(result.ok, false);
});

test("runExecutor sandbox does not expose process or require", () => {
  const strategy: Strategy = {
    version: 1,
    notes: "probe",
    params: {},
    executorTs: `
      const hasProcess = typeof process !== "undefined";
      const hasRequire = typeof require !== "undefined";
      return { type: "noop", reason: "process=" + hasProcess + " require=" + hasRequire };
    `,
  };
  const result = runExecutor(strategy, obs, helpersBase);
  assert.equal(result.ok, true);
  if (result.ok && result.action.type === "noop") {
    assert.equal(result.action.reason, "process=false require=false");
  }
});
