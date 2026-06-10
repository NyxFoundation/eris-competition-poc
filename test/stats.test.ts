import test from "node:test";
import assert from "node:assert/strict";
import {
  bootstrapMeanDiffCI,
  evaluateUnpairedGate,
  mannWhitney,
  welchT,
} from "../src/stats.js";

test("bootstrapMeanDiffCI: 明確に分離した分布は CI 下限 > 0", () => {
  const ci = bootstrapMeanDiffCI([10, 12, 11, 13, 12], [1, 2, 1.5, 2.5, 2]);
  assert.ok(ci !== null);
  assert.ok(ci.low > 0, `low=${ci.low}`);
  assert.ok(ci.high > ci.low);
  assert.ok(Math.abs(ci.meanDiff - 9.8) < 1e-9);
});

test("bootstrapMeanDiffCI: 同一分布は CI が 0 を跨ぐ", () => {
  const ci = bootstrapMeanDiffCI([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
  assert.ok(ci !== null);
  assert.ok(ci.low <= 0 && 0 <= ci.high, `[${ci.low}, ${ci.high}]`);
});

test("bootstrapMeanDiffCI: 決定論（同 seed・同入力 = 同結果）/ サンプル不足は null", () => {
  const a = bootstrapMeanDiffCI([3, 5, 4], [1, 2, 1], { seed: 7 });
  const b = bootstrapMeanDiffCI([3, 5, 4], [1, 2, 1], { seed: 7 });
  assert.deepEqual(a, b);
  assert.equal(bootstrapMeanDiffCI([1], [1, 2]), null);
  assert.equal(bootstrapMeanDiffCI([1, 2], [1]), null);
});

test("welchT: 既知値（scipy 一致）と退化ケース", () => {
  // t=-1, df=8 → 両側 p=0.34659（scipy.stats.ttest_ind equal_var=False）
  const r = welchT([1, 2, 3, 4, 5], [2, 3, 4, 5, 6]);
  assert.ok(r !== null);
  assert.ok(Math.abs(r.t - -1) < 1e-12);
  assert.ok(Math.abs(r.df - 8) < 1e-9);
  assert.ok(Math.abs(r.p - 0.34659) < 1e-3, `p=${r.p}`);
  // 大きく分離 → p ほぼ 0
  const sep = welchT([0, 1, 2, 3, 4], [10, 11, 12, 13, 14]);
  assert.ok(sep !== null && sep.p < 1e-4);
  // 同一定数列 → t=0, p=1
  const same = welchT([5, 5, 5], [5, 5, 5]);
  assert.ok(same !== null && same.t === 0 && same.p === 1);
  // 分散 0 で平均が違う → p=0
  const det = welchT([6, 6, 6], [5, 5, 5]);
  assert.ok(det !== null && det.p === 0);
  // サンプル不足
  assert.equal(welchT([1], [1, 2]), null);
});

test("mannWhitney: pGreater は P(X>Y)（完全分離=1, 同一=0.5）", () => {
  const sep = mannWhitney([3, 4, 5], [1, 2, 2.5]);
  assert.ok(sep !== null);
  assert.equal(sep.pGreater, 1);
  assert.ok(sep.p < 0.06);
  const same = mannWhitney([1, 2], [1, 2]);
  assert.ok(same !== null);
  assert.equal(same.pGreater, 0.5);
  assert.ok(same.p > 0.9);
});

test("evaluateUnpairedGate improve: 有意な改善のみ PASS", () => {
  // 明確な改善 → PASS
  const pass = evaluateUnpairedGate([0, 1, -1, 0.5, 0], [10, 11, 9, 10.5, 10]);
  assert.equal(pass.mode, "improve");
  assert.equal(pass.pass, true);
  assert.ok(pass.ci !== null && pass.ci.low > 0);
  assert.equal(pass.winRate, 1);
  // mean は改善(+36)だが高分散で CI が 0 を跨ぐ → FAIL（「運で median を超えた」を弾く）
  const noisy = evaluateUnpairedGate(
    [0, 0, 0, 0, 0],
    [200, -180, 150, -160, 170],
  );
  assert.equal(noisy.pass, false);
  assert.ok(noisy.meanDiff > 0);
  assert.ok(noisy.ci !== null && noisy.ci.low <= 0);
  // 劣化 → FAIL
  const worse = evaluateUnpairedGate([10, 11, 9, 10, 10], [0, 1, -1, 0, 0]);
  assert.equal(worse.pass, false);
});

test("evaluateUnpairedGate noninferior: holdout の劣化閾値チェック", () => {
  // わずかな劣化（margin 内）→ PASS
  const ok = evaluateUnpairedGate([10, 10, 10, 10], [9, 9, 9, 9], {
    mode: "noninferior",
    margin: 2,
  });
  assert.equal(ok.pass, true);
  // 大きく有意に劣化（CI 上限 < −margin）→ FAIL
  const bad = evaluateUnpairedGate([10, 10, 10, 10], [0, 0, 0, 0], {
    mode: "noninferior",
    margin: 2,
  });
  assert.equal(bad.pass, false);
});

test("evaluateUnpairedGate: サンプル不足は FAIL（理由つき）", () => {
  const r = evaluateUnpairedGate([1], [2]);
  assert.equal(r.pass, false);
  assert.match(r.reason, /サンプル不足/);
});
