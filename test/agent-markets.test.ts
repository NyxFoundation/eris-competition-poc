import test from "node:test";
import assert from "node:assert/strict";
import { marketViews } from "../examples/agents/lib/markets.js";
import type { AgentObservation } from "../src/types.js";

// marketViews は registry に依存しない純粋関数なので、observation を手で組んで全 base 経路を検証できる。
function baseObs(): AgentObservation {
  return {
    kind: "observation",
    runId: "t",
    round: 1,
    blockNumber: "1",
    agentAddress: "0x0000000000000000000000000000000000000001",
    fairPriceUsdcPerWeth: 3000,
    oraclePrices: { wethUsd: 3000, usdcUsd: 1 },
    enabledProtocols: ["uniswap", "balancer", "curve"],
    balances: { ethWei: "1", wethWei: "5", usdcUnits: "100" },
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
          priceUsdcPerWeth: 2990,
          tick: 0,
          tickSpacing: 10,
        },
        positions: [],
      },
      balancer: { priceUsdcPerWeth: 3010 },
      curve: { priceUsdcPerWeth: 3000 },
    },
  };
}

test("marketViews: WETH-only observation は 1 view・base 無し・全 venue 価格を返す", () => {
  const views = marketViews(baseObs());
  assert.equal(views.length, 1);
  const w = views[0];
  assert.equal(w.base, "WETH");
  assert.equal(w.fair, 3000);
  assert.equal(w.baseBalanceWei, "5"); // balances.wethWei
  assert.deepEqual(
    w.venues.map((v) => [v.protocol, v.swapType, v.price]),
    [
      ["uniswap", "swap", 2990],
      ["balancer", "balancerSwap", 3010],
      ["curve", "curveSwap", 3000],
    ],
  );
});

test("marketViews: WBTC を含む observation は WETH 先頭で 2 view を返す（base 非依存抽出）", () => {
  const obs = baseObs();
  obs.fairPricesUsd = { WBTC: 60000, WETH: 3000 }; // 順序逆でも WETH を先頭に正規化
  obs.baseBalances = { WETH: "5", WBTC: "100000000" }; // 1 WBTC (8 桁)
  obs.protocols.uniswap!.markets = {
    "WBTC/USDC": {
      pair: "WBTC/USDC",
      fee: 500,
      priceUsdcPerWeth: 59500,
      tick: 0,
      tickSpacing: 10,
    },
  };
  obs.protocols.balancer!.markets = {
    "WBTC/USDC": { priceUsdcPerWeth: 60500 },
  };
  // curve には WBTC market を載せない → WBTC の venue は uniswap/balancer の 2 つ。

  const views = marketViews(obs);
  assert.equal(views.length, 2);
  assert.equal(views[0].base, "WETH"); // 先頭固定
  const wbtc = views[1];
  assert.equal(wbtc.base, "WBTC");
  assert.equal(wbtc.fair, 60000);
  assert.equal(wbtc.baseBalanceWei, "100000000");
  assert.deepEqual(
    wbtc.venues.map((v) => [v.protocol, v.price]),
    [
      ["uniswap", 59500],
      ["balancer", 60500],
    ],
  );
});

test("marketViews: venue 価格が無い base は除外する", () => {
  const obs = baseObs();
  obs.fairPricesUsd = { WETH: 3000, WBTC: 60000 }; // WBTC の venue 価格は protocols に無い
  const views = marketViews(obs);
  assert.deepEqual(
    views.map((v) => v.base),
    ["WETH"],
  );
});
