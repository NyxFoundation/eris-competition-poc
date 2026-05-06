import test from "node:test";
import assert from "node:assert/strict";
import { parseAction, validateAction } from "../src/action.js";
import type { AgentObservation, BalanceSnapshot } from "../src/types.js";

const observation: AgentObservation = {
  kind: "observation",
  runId: "test",
  round: 1,
  blockNumber: "1",
  pool: { pair: "WETH/USDC", fee: 500, priceUsdcPerWeth: 3000, tick: 0, tickSpacing: 10 },
  positions: [
    {
      tokenId: "1",
      tickLower: -10,
      tickUpper: 10,
      liquidity: "100",
      tokensOwedWethWei: "0",
      tokensOwedUsdcUnits: "0",
      amountWethWei: "0",
      amountUsdcUnits: "0",
      valueUsdc: 0
    }
  ],
  fairPriceUsdcPerWeth: 3000,
  balances: { ethWei: "1", wethWei: "100", usdcUnits: "100" },
  inventory: { valueUsdc: 0, weth: 0, usdc: 0, eth: 0 },
  history: [],
  limits: {
    maxWethInWei: "100",
    maxUsdcInUnits: "100",
    defaultPriorityFeePerGasWei: "10",
    maxPriorityFeePerGasWei: "20",
    defaultSlippageBps: 50,
    maxBundleActions: 5,
    maxLpWethWei: "100",
    maxLpUsdcUnits: "100",
    maxOpenPositions: 5
  }
};
const balances: BalanceSnapshot = { ethWei: 1n, wethWei: 100n, usdcUnits: 100n };

test("parseAction accepts swap actions", () => {
  assert.deepEqual(parseAction({ type: "swap", tokenIn: "WETH", amountIn: "10" }), {
    type: "swap",
    tokenIn: "WETH",
    amountIn: "10"
  });
});

test("validateAction rejects excessive priority fee", () => {
  const action = parseAction({ type: "swap", tokenIn: "WETH", amountIn: "10", maxPriorityFeePerGasWei: "21" });
  assert.deepEqual(validateAction(action, observation, balances), { ok: false, reason: "priority fee exceeds configured max" });
});

test("parseAction accepts LP actions and bundle actions", () => {
  assert.deepEqual(parseAction({ type: "mintLiquidity", tickLower: -10, tickUpper: 10, amountWethDesired: "1", amountUsdcDesired: "2" }), {
    type: "mintLiquidity",
    tickLower: -10,
    tickUpper: 10,
    amountWethDesired: "1",
    amountUsdcDesired: "2"
  });
  const parsed = parseAction({
    type: "bundle",
    actions: [
      { type: "removeLiquidity", tokenId: "1", liquidity: "10" },
      { type: "collectFees", tokenId: "1" }
    ]
  });
  assert.equal(parsed.type, "bundle");
});

test("validateAction rejects invalid LP ticks and foreign token ids", () => {
  assert.deepEqual(
    validateAction(parseAction({ type: "mintLiquidity", tickLower: -11, tickUpper: 10, amountWethDesired: "1", amountUsdcDesired: "1" }), observation, balances),
    { ok: false, reason: "ticks must align to pool tick spacing" }
  );
  assert.deepEqual(validateAction(parseAction({ type: "collectFees", tokenId: "99" }), observation, balances), { ok: false, reason: "tokenId is not owned by agent" });
});

test("validateAction expands bundle intents in order", () => {
  const result = validateAction(
    parseAction({
      type: "bundle",
      maxPriorityFeePerGasWei: "12",
      actions: [
        { type: "removeLiquidity", tokenId: "1", liquidity: "10" },
        { type: "collectFees", tokenId: "1" }
      ]
    }),
    observation,
    balances
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.intents.length, 2);
  assert.equal(result.intents[0].bundleIndex, 0);
  assert.equal(result.intents[1].bundleIndex, 1);
  assert.equal(result.intents[0].priorityFeeWei, 12n);
});

test("parseAction rejects nested bundle and validateAction rejects oversized bundle", () => {
  assert.throws(() => parseAction({ type: "bundle", actions: [{ type: "bundle", actions: [] }] }), /nested bundle/);
  assert.deepEqual(
    validateAction(
      parseAction({
        type: "bundle",
        actions: [
          { type: "collectFees", tokenId: "1" },
          { type: "collectFees", tokenId: "1" },
          { type: "collectFees", tokenId: "1" },
          { type: "collectFees", tokenId: "1" },
          { type: "collectFees", tokenId: "1" },
          { type: "collectFees", tokenId: "1" }
        ]
      }),
      observation,
      balances
    ),
    { ok: false, reason: "bundle action count exceeds configured max" }
  );
});
