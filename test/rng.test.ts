import test from "node:test";
import assert from "node:assert/strict";
import {
  Rng,
  nextFairPrice,
  nextFairPrices,
  priceRngForAsset,
} from "../src/rng.js";

test("rng and fair price are reproducible for a fixed seed", () => {
  const a = new Rng(42);
  const b = new Rng(42);
  const pricesA = [
    nextFairPrice(3000, a, 3000),
    nextFairPrice(3000, a, 3000),
    nextFairPrice(3000, a, 3000),
  ];
  const pricesB = [
    nextFairPrice(3000, b, 3000),
    nextFairPrice(3000, b, 3000),
    nextFairPrice(3000, b, 3000),
  ];
  assert.deepEqual(pricesA, pricesB);
});

test("fair price mean-reverts toward the anchor", () => {
  // anchor より十分高い current は引き戻され(下降寄り)、十分低い current は引き上げられる。
  // 多数ステップの平均ドリフト方向が anchor 方向を向くことを確認する（ショックは平均0）。
  const anchor = 3000;
  const stepsFrom = (start: number): number => {
    const rng = new Rng(7);
    let p = start;
    for (let i = 0; i < 200; i++) p = nextFairPrice(p, rng, anchor);
    return p;
  };
  const fromHigh = stepsFrom(3600); // anchor より +20%
  const fromLow = stepsFrom(2400); // anchor より −20%
  // どちらも anchor 近傍(±10%)へ回帰している
  assert.ok(Math.abs(fromHigh - anchor) < anchor * 0.1, `fromHigh=${fromHigh}`);
  assert.ok(Math.abs(fromLow - anchor) < anchor * 0.1, `fromLow=${fromLow}`);
});

test("priceRngForAsset(seed,'WETH') equals Rng(seed) — WETH byte compatibility", () => {
  // WETH の価格 Rng は派生 salt 0 なので Rng(seed) と完全一致（既存 run のパスを保つ）。
  const seed = 12345;
  const direct = new Rng(seed);
  const viaWeth = priceRngForAsset(seed, "WETH");
  for (let i = 0; i < 5; i++) assert.equal(viaWeth.next(), direct.next());
});

test("adding WBTC leaves the WETH price path byte-identical (independent per-asset Rng)", () => {
  const seed = 99;
  // 従来: WETH 単独を Rng(seed) で 4 ステップ進める。
  const solo = new Rng(seed);
  const wethSolo: number[] = [];
  let p = 3000;
  for (let i = 0; i < 4; i++) {
    p = nextFairPrice(p, solo, 3000);
    wethSolo.push(p);
  }
  // 複数: WETH+WBTC を asset ごとの独立 Rng で 4 ステップ進める。
  const rngBy = {
    WETH: priceRngForAsset(seed, "WETH"),
    WBTC: priceRngForAsset(seed, "WBTC"),
  };
  let cur: Record<string, number> = { WETH: 3000, WBTC: 60000 };
  const anchors = { WETH: 3000, WBTC: 60000 };
  const wethMulti: number[] = [];
  for (let i = 0; i < 4; i++) {
    cur = nextFairPrices(cur, rngBy, anchors, ["WETH", "WBTC"]);
    wethMulti.push(cur.WETH);
  }
  // WBTC を足しても WETH の価格列は単独版と完全一致（独立 Rng の効果）。
  assert.deepEqual(wethMulti, wethSolo);
  // WBTC は独立に進む。
  assert.notEqual(cur.WBTC, 60000);
});
