import test from "node:test";
import assert from "node:assert/strict";
import { Rng, nextFairPrice } from "../src/rng.js";

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
