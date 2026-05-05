import test from "node:test";
import assert from "node:assert/strict";
import { parseAction, validateAction } from "../src/action.js";
import type { AgentObservation, BalanceSnapshot } from "../src/types.js";

const observation: AgentObservation = {
  kind: "observation",
  runId: "test",
  round: 1,
  blockNumber: "1",
  pool: { pair: "WETH/USDC", fee: 500, priceUsdcPerWeth: 3000 },
  fairPriceUsdcPerWeth: 3000,
  balances: { ethWei: "1", wethWei: "100", usdcUnits: "100" },
  inventory: { valueUsdc: 0, weth: 0, usdc: 0, eth: 0 },
  history: [],
  limits: {
    maxWethInWei: "100",
    maxUsdcInUnits: "100",
    defaultPriorityFeePerGasWei: "10",
    maxPriorityFeePerGasWei: "20",
    defaultSlippageBps: 50
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
