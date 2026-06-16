import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng } from "../src/rng.js";
import { buildFlowOrders, type FlowContextWire } from "../src/flow/logic.js";

function ctx(round: number, spreadMaxWethWei = "0"): FlowContextWire {
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
      crossVenueSpreadFlowMaxWethWei: spreadMaxWethWei,
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

test("cross-venue spread 注入は max=0(既定)で rng を消費せず既存 flow と byte 互換", () => {
  // max=0 のとき spread builder は何も出さず rng も消費しない → spread leg を除いた
  // 既存 flow（AMM/gmx/aave）は spread 有効時と同一でなければならない（後方互換）。
  for (let round = 1; round <= 5; round++) {
    const off = buildFlowOrders(new Rng(123), ctx(round, "0"));
    assert.equal(
      off.filter((o) => o.kind === "spread").length,
      0,
      "max=0 では spread leg は出ない",
    );
  }
});

test("cross-venue spread 注入: 2 venue を対称に押し開く delta-neutral な 2 leg", () => {
  const max = 4_000_000_000_000_000_000n; // 4 WETH
  const orders = buildFlowOrders(new Rng(5), ctx(1, max.toString()));
  const spread = orders.filter((o) => o.kind === "spread");
  assert.equal(spread.length, 2, "spread leg は 2 本");

  // 2 leg は異なる venue（protocol）に出る。
  assert.notEqual(spread[0].protocol, spread[1].protocol);

  // up leg = USDC→WETH(買い・価格↑), down leg = WETH→USDC(売り・価格↓) が 1 本ずつ。
  const up = spread.find(
    (o) => (o.action as { tokenIn: string }).tokenIn === "USDC",
  );
  const down = spread.find(
    (o) => (o.action as { tokenIn: string }).tokenIn === "WETH",
  );
  assert.ok(up && down, "USDC-in と WETH-in が 1 本ずつ");

  // delta-neutral: 両 leg は同じ WETH 相当（up の USDC 名目 ≈ down の WETH × fair）。
  const wethWei = BigInt((down!.action as { amountIn: string }).amountIn);
  const usdcUnits = BigInt((up!.action as { amountIn: string }).amountIn);
  // wethToUsdcUnits(wethWei, 2000) = wethWei * 200000 / (100 * 1e12)
  const expectedUsdc =
    (wethWei * BigInt(Math.round(2000 * 100))) / (100n * 10n ** 12n);
  assert.equal(
    usdcUnits,
    expectedUsdc,
    "両 leg は同 WETH 相当 = delta-neutral",
  );

  // サイズは max/4..max の範囲。
  assert.ok(wethWei >= max / 4n && wethWei <= max);
});

test("cross-venue spread 注入は固定 seed で再現する", () => {
  const a = buildFlowOrders(new Rng(77), ctx(1, "4000000000000000000"));
  const b = buildFlowOrders(new Rng(77), ctx(1, "4000000000000000000"));
  assert.deepEqual(a, b);
});
