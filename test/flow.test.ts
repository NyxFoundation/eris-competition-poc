import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng } from "../src/rng.js";
import { buildFlowOrders, type FlowContextWire } from "../src/flow/logic.js";

function ctx(round: number): FlowContextWire {
  return {
    round,
    fairPriceUsdcPerWeth: 2000,
    // 本番の順序: config.ALL_PROTOCOLS = [uniswap, balancer, curve, gmx, aave]
    // （gmx が aave より前）。coordinator は enabledIds をこの順で渡すため、テストも揃える。
    protocols: ["uniswap", "balancer", "curve", "gmx", "aave"],
    poolPrices: { uniswap: 1990, balancer: 2010, curve: 2000 },
    aaveReserves: { wethSupplied: "0", usdcBorrowed: "0" },
    limits: {
      uninformedFlowMaxWethWei: "1000000000000000000",
      informedFlowMaxWethWei: "2000000000000000000",
      balancerFlowMaxWethWei: "1000000000000000000",
      curveFlowMaxWethWei: "1000000000000000000",
      gmxFlowMaxSizeUsd: (20_000n * 10n ** 30n).toString(),
      aaveFlowMaxWethWei: "2000000000000000000",
      maxAaveBorrowUsdcUnits: "5000000000",
      defaultPriorityFeeWei: "100000000",
    },
  };
}

test("buildFlowOrders is reproducible for a fixed seed (固定市場の根拠)", () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let round = 1; round <= 5; round++) {
    assert.deepEqual(
      buildFlowOrders(a, ctx(round)),
      buildFlowOrders(b, ctx(round)),
    );
  }
});

test("buildFlowOrders は protocols を渡された順(本番=enabledAdapters順)でタグ付けする", () => {
  const orders = buildFlowOrders(new Rng(7), ctx(1));
  const idx = (p: string) => orders.findIndex((o) => o.protocol === p);
  // AMM と aave は常に出力される。本番順 uniswap<balancer<curve<(gmx)<aave。
  assert.ok(idx("uniswap") >= 0 && idx("aave") >= 0);
  assert.ok(idx("uniswap") < idx("balancer"));
  assert.ok(idx("balancer") < idx("curve"));
  assert.ok(idx("curve") < idx("aave"));
  // gmx は出力されたラウンドのみ存在し、curve と aave の間に入る。
  if (idx("gmx") >= 0) {
    assert.ok(idx("curve") < idx("gmx"));
    assert.ok(idx("gmx") < idx("aave"));
  }
  // AMM は uninformed+informed の 2 本ずつ
  assert.equal(orders.filter((o) => o.protocol === "uniswap").length, 2);
});

test("informed AMM flow は pool を fair に寄せる (pool<fair → USDC で WETH 買い)", () => {
  const orders = buildFlowOrders(new Rng(1), ctx(1));
  const uniInformed = orders.find(
    (o) => o.protocol === "uniswap" && o.kind === "informed",
  );
  assert.ok(uniInformed);
  assert.equal(
    (uniInformed!.action as { tokenIn: string }).tokenIn,
    "USDC", // poolPrice 1990 < fair 2000
  );
});

test("aave flow は supplied===0 のとき aaveSupply を出す", () => {
  const orders = buildFlowOrders(new Rng(3), ctx(1));
  const aave = orders.find((o) => o.protocol === "aave");
  assert.ok(aave);
  assert.equal((aave!.action as { type: string }).type, "aaveSupply");
});

test("異なる seed は異なる flow を生む", () => {
  const o1 = buildFlowOrders(new Rng(1), ctx(1));
  const o2 = buildFlowOrders(new Rng(999), ctx(1));
  assert.notDeepEqual(
    o1.map((o) => o.priorityFeeWei.toString()),
    o2.map((o) => o.priorityFeeWei.toString()),
  );
});
