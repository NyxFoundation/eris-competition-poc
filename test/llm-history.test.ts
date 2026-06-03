import test from "node:test";
import assert from "node:assert/strict";
import {
  History,
  summarizeAction,
  buildRoundRecord,
} from "../src/llm/history.js";
import type { AgentAction, AgentObservation } from "../src/types.js";

const baseObs: AgentObservation = {
  kind: "observation",
  runId: "r",
  round: 0,
  blockNumber: "1",
  agentAddress: "0x0000000000000000000000000000000000000001",
  fairPriceUsdcPerWeth: 3000,
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
  balances: { ethWei: "0", wethWei: "0", usdcUnits: "0" },
  inventory: { valueUsdc: 100, weth: 0, usdc: 0, eth: 0 },
  history: [],
  limits: {
    maxWethInWei: "0",
    maxUsdcInUnits: "0",
    defaultPriorityFeePerGasWei: "0",
    maxPriorityFeePerGasWei: "0",
    defaultSlippageBps: 0,
    maxBundleActions: 5,
    maxLpWethWei: "0",
    maxLpUsdcUnits: "0",
    maxOpenPositions: 0,
    maxGmxSizeUsd: "0",
    maxAaveSupplyWethWei: "0",
    maxAaveBorrowUsdcUnits: "0",
  },
};

test("History keeps initial USD once set", () => {
  const h = new History(5);
  h.setInitialUsd(100);
  h.setInitialUsd(200); // ignored
  assert.equal(h.getInitialUsd(), 100);
});

test("History ring buffer caps at capacity", () => {
  const h = new History(3);
  for (let i = 0; i < 5; i++) {
    h.push(
      buildRoundRecord(
        { ...baseObs, round: i },
        { type: "noop" },
        true,
        undefined,
        [],
      ),
    );
  }
  const recent = h.recent();
  assert.equal(recent.length, 3);
  assert.deepEqual(
    recent.map((r) => r.round),
    [2, 3, 4],
  );
});

test("summarizeAction collapses each AgentAction shape", () => {
  const cases: Array<[AgentAction, string]> = [
    [{ type: "noop", reason: "x" }, "noop"],
    [{ type: "swap", tokenIn: "WETH", amountIn: "1" }, "swap"],
    [
      {
        type: "mintLiquidity",
        tickLower: -10,
        tickUpper: 10,
        amountWethDesired: "1",
        amountUsdcDesired: "1",
      },
      "mintLiquidity",
    ],
    [
      { type: "removeLiquidity", tokenId: "1", liquidity: "1" },
      "removeLiquidity",
    ],
    [{ type: "collectFees", tokenId: "1" }, "collectFees"],
    [
      {
        type: "bundle",
        actions: [{ type: "swap", tokenIn: "WETH", amountIn: "1" }],
      },
      "bundle",
    ],
    [{ type: "rawTx", tx: { to: "0xabc", data: "0x" } }, "rawTx"],
    [{ type: "rawBundle", txs: [{ to: "0xabc", data: "0x" }] }, "rawBundle"],
  ];
  for (const [action, expected] of cases) {
    assert.equal(summarizeAction(action).type, expected);
  }
});

test("buildRoundRecord captures executor failure", () => {
  const record = buildRoundRecord(
    baseObs,
    { type: "noop", reason: "executor error: boom" },
    false,
    "boom",
    ["log line"],
  );
  assert.equal(record.executorOk, false);
  assert.equal(record.executorReason, "boom");
  assert.deepEqual(record.executorLogs, ["log line"]);
});
