import test from "node:test";
import assert from "node:assert/strict";
import { Rng, nextFairPrice } from "../src/rng.js";

test("rng and fair price are reproducible for a fixed seed", () => {
  const a = new Rng(42);
  const b = new Rng(42);
  const pricesA = [nextFairPrice(3000, a), nextFairPrice(3000, a), nextFairPrice(3000, a)];
  const pricesB = [nextFairPrice(3000, b), nextFairPrice(3000, b), nextFairPrice(3000, b)];
  assert.deepEqual(pricesA, pricesB);
});
