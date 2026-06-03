import test from "node:test";
import assert from "node:assert/strict";
import { parseAction, validateAction } from "../src/action.js";
import type { AgentObservation, BalanceSnapshot } from "../src/types.js";

const observation: AgentObservation = {
  kind: "observation",
  runId: "test",
  round: 1,
  blockNumber: "1",
  agentAddress: "0x1234567890abcdef1234567890abcdef12345678",
  fairPriceUsdcPerWeth: 3000,
  oraclePrices: { wethUsd: 3000, usdcUsd: 1 },
  enabledProtocols: ["uniswap"],
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
    maxOpenPositions: 5,
    maxGmxSizeUsd: "0",
    maxAaveSupplyWethWei: "0",
    maxAaveBorrowUsdcUnits: "0",
  },
  protocols: {
    uniswap: {
      pool: {
        pair: "WETH/USDC",
        fee: 500,
        priceUsdcPerWeth: 3000,
        tick: 0,
        tickSpacing: 10,
      },
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
          valueUsdc: 0,
        },
      ],
    },
  },
};
const balances: BalanceSnapshot = {
  ethWei: 1n,
  wethWei: 100n,
  usdcUnits: 100n,
};

test("parseAction accepts swap actions", () => {
  assert.deepEqual(
    parseAction({ type: "swap", tokenIn: "WETH", amountIn: "10" }),
    {
      type: "swap",
      tokenIn: "WETH",
      amountIn: "10",
    },
  );
});

test("validateAction rejects excessive priority fee", () => {
  const action = parseAction({
    type: "swap",
    tokenIn: "WETH",
    amountIn: "10",
    maxPriorityFeePerGasWei: "21",
  });
  assert.deepEqual(validateAction(action, observation, balances), {
    ok: false,
    reason: "priority fee exceeds configured max",
  });
});

test("parseAction accepts LP actions and bundle actions", () => {
  assert.deepEqual(
    parseAction({
      type: "mintLiquidity",
      tickLower: -10,
      tickUpper: 10,
      amountWethDesired: "1",
      amountUsdcDesired: "2",
    }),
    {
      type: "mintLiquidity",
      tickLower: -10,
      tickUpper: 10,
      amountWethDesired: "1",
      amountUsdcDesired: "2",
    },
  );
  const parsed = parseAction({
    type: "bundle",
    actions: [
      { type: "removeLiquidity", tokenId: "1", liquidity: "10" },
      { type: "collectFees", tokenId: "1" },
    ],
  });
  assert.equal(parsed.type, "bundle");
});

test("validateAction rejects invalid LP ticks and foreign token ids", () => {
  assert.deepEqual(
    validateAction(
      parseAction({
        type: "mintLiquidity",
        tickLower: -11,
        tickUpper: 10,
        amountWethDesired: "1",
        amountUsdcDesired: "1",
      }),
      observation,
      balances,
    ),
    { ok: false, reason: "ticks must align to pool tick spacing" },
  );
  assert.deepEqual(
    validateAction(
      parseAction({ type: "collectFees", tokenId: "99" }),
      observation,
      balances,
    ),
    { ok: false, reason: "tokenId is not owned by agent" },
  );
});

test("validateAction expands bundle intents in order", () => {
  const result = validateAction(
    parseAction({
      type: "bundle",
      maxPriorityFeePerGasWei: "12",
      actions: [
        { type: "removeLiquidity", tokenId: "1", liquidity: "10" },
        { type: "collectFees", tokenId: "1" },
      ],
    }),
    observation,
    balances,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.intents.length, 2);
  assert.equal(result.intents[0].bundleIndex, 0);
  assert.equal(result.intents[1].bundleIndex, 1);
  assert.equal(result.intents[0].priorityFeeWei, 12n);
});

test("parseAction rejects nested bundle and validateAction rejects oversized bundle", () => {
  assert.throws(
    () =>
      parseAction({
        type: "bundle",
        actions: [{ type: "bundle", actions: [] }],
      }),
    /nested bundle/,
  );
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
          { type: "collectFees", tokenId: "1" },
        ],
      }),
      observation,
      balances,
    ),
    { ok: false, reason: "bundle action count exceeds configured max" },
  );
});

test("parseAction accepts rawTx", () => {
  assert.deepEqual(
    parseAction({ type: "rawTx", tx: { to: "0xdead", data: "0x1234" } }),
    {
      type: "rawTx",
      tx: { to: "0xdead", data: "0x1234" },
    },
  );
});

test("parseAction accepts rawTx with value and priority fee", () => {
  assert.deepEqual(
    parseAction({
      type: "rawTx",
      tx: { to: "0xdead", data: "0x1234", value: "1000" },
      maxPriorityFeePerGasWei: "15",
    }),
    {
      type: "rawTx",
      tx: { to: "0xdead", data: "0x1234", value: "1000" },
      maxPriorityFeePerGasWei: "15",
    },
  );
});

test("parseAction rejects rawTx with non-hex to or data", () => {
  assert.throws(
    () => parseAction({ type: "rawTx", tx: { to: "not-hex", data: "0x1234" } }),
    /raw tx to must be a hex string/,
  );
  assert.throws(
    () => parseAction({ type: "rawTx", tx: { to: "0xdead", data: "not-hex" } }),
    /raw tx data must be a hex string/,
  );
});

test("parseAction rejects rawTx without tx object", () => {
  assert.throws(
    () => parseAction({ type: "rawTx" }),
    /rawTx must have a tx object/,
  );
});

test("parseAction accepts rawBundle", () => {
  const parsed = parseAction({
    type: "rawBundle",
    txs: [
      { to: "0xdead", data: "0x1234" },
      { to: "0xbeef", data: "0x5678", value: "100" },
    ],
  });
  assert.equal(parsed.type, "rawBundle");
  if (parsed.type !== "rawBundle") return;
  assert.equal(parsed.txs.length, 2);
  assert.equal(parsed.txs[1].value, "100");
});

test("parseAction rejects empty rawBundle", () => {
  assert.throws(
    () => parseAction({ type: "rawBundle", txs: [] }),
    /rawBundle txs must not be empty/,
  );
});

test("validateAction passes rawTx without balance checks", () => {
  const action = parseAction({
    type: "rawTx",
    tx: { to: "0xdead", data: "0x1234" },
  });
  const result = validateAction(action, observation, balances);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.intents.length, 0);
  assert.equal(result.rawIntents.length, 1);
  assert.deepEqual(result.rawIntents[0].tx, { to: "0xdead", data: "0x1234" });
  assert.equal(result.rawIntents[0].priorityFeeWei, 10n);
});

test("validateAction rejects rawTx with excessive priority fee", () => {
  const action = parseAction({
    type: "rawTx",
    tx: { to: "0xdead", data: "0x1234" },
    maxPriorityFeePerGasWei: "21",
  });
  assert.deepEqual(validateAction(action, observation, balances), {
    ok: false,
    reason: "priority fee exceeds configured max",
  });
});

test("validateAction rejects oversized rawBundle", () => {
  const txs = Array.from({ length: 6 }, () => ({
    to: "0xdead",
    data: "0x1234",
  }));
  const action = parseAction({ type: "rawBundle", txs });
  assert.deepEqual(validateAction(action, observation, balances), {
    ok: false,
    reason: "rawBundle tx count exceeds configured max",
  });
});

test("parseAction accepts balancer and curve swaps", () => {
  assert.deepEqual(
    parseAction({ type: "balancerSwap", tokenIn: "WETH", amountIn: "10" }),
    { type: "balancerSwap", tokenIn: "WETH", amountIn: "10" },
  );
  assert.deepEqual(
    parseAction({ type: "curveSwap", tokenIn: "USDC", amountIn: "10" }),
    { type: "curveSwap", tokenIn: "USDC", amountIn: "10" },
  );
});

test("parseAction accepts aave actions including max sentinel", () => {
  assert.deepEqual(
    parseAction({ type: "aaveSupply", asset: "WETH", amount: "5" }),
    { type: "aaveSupply", asset: "WETH", amount: "5" },
  );
  assert.deepEqual(
    parseAction({ type: "aaveRepay", asset: "USDC", amount: "max" }),
    { type: "aaveRepay", asset: "USDC", amount: "max" },
  );
});

test("parseAction rejects max for aaveSupply (only withdraw/repay allow max)", () => {
  assert.throws(
    () => parseAction({ type: "aaveSupply", asset: "WETH", amount: "max" }),
    /decimal integer string/,
  );
});

test("parseAction accepts gmxIncrease and rejects it inside bundle", () => {
  assert.deepEqual(
    parseAction({
      type: "gmxIncrease",
      isLong: true,
      collateral: "WETH",
      collateralAmount: "1",
      sizeDeltaUsd: "100",
    }),
    {
      type: "gmxIncrease",
      isLong: true,
      collateral: "WETH",
      collateralAmount: "1",
      sizeDeltaUsd: "100",
    },
  );
  assert.throws(
    () =>
      parseAction({
        type: "bundle",
        actions: [
          {
            type: "gmxIncrease",
            isLong: true,
            collateral: "WETH",
            collateralAmount: "1",
            sizeDeltaUsd: "100",
          },
        ],
      }),
    /cannot be bundled/,
  );
});

test("validateAction rejects gmx size over configured max", () => {
  const action = parseAction({
    type: "gmxIncrease",
    isLong: true,
    collateral: "WETH",
    collateralAmount: "1",
    sizeDeltaUsd: "100",
  });
  assert.deepEqual(validateAction(action, observation, balances), {
    ok: false,
    reason: "sizeDeltaUsd exceeds configured max",
  });
});

test("validateAction enforces cumulative balance across a bundle of LP mints", () => {
  // balances.wethWei = 100。各 mint が 100 WETH を要求する 2 件 bundle は、
  // 累積で残高を超えるため 2 件目で拒否されるべき（単発なら各々は通る）。
  const action = parseAction({
    type: "bundle",
    actions: [
      {
        type: "mintLiquidity",
        tickLower: -10,
        tickUpper: 10,
        amountWethDesired: "100",
        amountUsdcDesired: "10",
      },
      {
        type: "mintLiquidity",
        tickLower: -10,
        tickUpper: 10,
        amountWethDesired: "100",
        amountUsdcDesired: "10",
      },
    ],
  });
  assert.deepEqual(validateAction(action, observation, balances), {
    ok: false,
    reason: "LP desired amounts exceed balance",
  });
});

test("validateAction routes balancer swap intent with protocol tag", () => {
  const result = validateAction(
    parseAction({ type: "balancerSwap", tokenIn: "WETH", amountIn: "10" }),
    observation,
    balances,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.intents[0].protocol, "balancer");
});

test("validateAction expands rawBundle intents with bundleId", () => {
  const action = parseAction({
    type: "rawBundle",
    txs: [
      { to: "0xdead", data: "0x1234" },
      { to: "0xbeef", data: "0x5678" },
    ],
  });
  const result = validateAction(action, observation, balances);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rawIntents.length, 2);
  assert.equal(result.rawIntents[0].bundleIndex, 0);
  assert.equal(result.rawIntents[1].bundleIndex, 1);
  assert.ok(result.rawIntents[0].bundleId);
  assert.equal(result.rawIntents[0].bundleId, result.rawIntents[1].bundleId);
});
