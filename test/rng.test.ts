import test from "node:test";
import assert from "node:assert/strict";
import { Rng, nextFairPrice } from "../src/rng.js";
import { sampleSimParams } from "../src/simParams.js";

test("rng and fair price are reproducible for a fixed seed", () => {
  const a = new Rng(42);
  const b = new Rng(42);
  const sigma = 0.001;
  const pricesA = [nextFairPrice(3000, a, sigma), nextFairPrice(3000, a, sigma), nextFairPrice(3000, a, sigma)];
  const pricesB = [nextFairPrice(3000, b, sigma), nextFairPrice(3000, b, sigma), nextFairPrice(3000, b, sigma)];
  assert.deepEqual(pricesA, pricesB);
});

test("nextFairPrice produces strictly positive values via GBM", () => {
  const rng = new Rng(7);
  let s = 3000;
  for (let i = 0; i < 1000; i++) {
    s = nextFairPrice(s, rng, 0.001);
    assert.ok(s > 0, `step ${i} produced non-positive price ${s}`);
  }
});

test("gaussian has empirical mean ~0 and variance ~1", () => {
  const rng = new Rng(123);
  const n = 20000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const z = rng.gaussian();
    sum += z;
    sumSq += z * z;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  assert.ok(Math.abs(mean) < 0.05, `gaussian mean ${mean} not close to 0`);
  assert.ok(Math.abs(variance - 1) < 0.05, `gaussian variance ${variance} not close to 1`);
});

test("poisson has empirical mean close to lambda", () => {
  const rng = new Rng(99);
  const lambda = 0.8;
  const n = 20000;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += rng.poisson(lambda);
  const mean = sum / n;
  assert.ok(Math.abs(mean - lambda) < 0.05, `poisson mean ${mean} not close to ${lambda}`);
});

test("lognormal has empirical mean close to E[X]", () => {
  const rng = new Rng(2024);
  const meanX = 20;
  const sigma = 1.2;
  const n = 50000;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += rng.lognormal(meanX, sigma);
  const mean = sum / n;
  assert.ok(Math.abs(mean - meanX) / meanX < 0.05, `lognormal mean ${mean} not close to ${meanX}`);
});

test("sampleSimParams draws within spec ranges and is reproducible", () => {
  const a = sampleSimParams(new Rng(1));
  const b = sampleSimParams(new Rng(1));
  assert.deepEqual(a, b);
  assert.ok(a.sigmaPerStep >= 0.00088 && a.sigmaPerStep <= 0.00101);
  assert.ok(a.poissonLambda >= 0.6 && a.poissonLambda <= 1.0);
  assert.ok(a.lognormalMeanY >= 19 && a.lognormalMeanY <= 21);
  assert.equal(a.lognormalSigma, 1.2);
});
