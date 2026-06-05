import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateAgents,
  computeVerdict,
  DEFAULT_THRESHOLDS,
  evaluateC1,
  evaluateC2,
  evaluateC3,
  spearman,
  type AgentAcc,
  type DiscriminationThresholds,
} from "../src/discrimination.js";

// seed 横断アキュムレータを手早く組むヘルパ。
function acc(netPnl: number[], sharpe: number[]): AgentAcc {
  return {
    netPnl,
    sharpe,
    revert: netPnl.map(() => 0),
    included: netPnl.map(() => 1),
  };
}

function byAgent(entries: Record<string, AgentAcc>): Map<string, AgentAcc> {
  return new Map(Object.entries(entries));
}

test("aggregateAgents: median / winRate / Sharpe降順ソート", () => {
  const agents = aggregateAgents(
    byAgent({
      lo: acc([10, -10, 30], [0.1, 0.1, 0.1]),
      hi: acc([100, 90, 110], [0.5, 0.6, 0.4]),
    }),
  );
  // Sharpe median 降順 → hi が先頭
  assert.equal(agents[0].id, "hi");
  assert.equal(agents[0].netPnl.median, 100);
  assert.equal(agents[1].netPnl.median, 10);
  // winRate: lo は 3 seed 中 2 勝
  assert.equal(agents[1].netPnl.winRate, 2 / 3);
});

test("spearman: 完全一致=1, 完全逆転=-1", () => {
  assert.equal(spearman([1, 2, 3, 4], [1, 2, 3, 4]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
});

test("computeVerdict: 識別力のある環境は PASS", () => {
  const baselineIds = new Set(["noop", "random"]);
  const agents = aggregateAgents(
    byAgent({
      // 戦略 2 体: baseline を安定して上回り、順位も安定、Sharpe も散る
      strongA: acc([300, 320, 290], [0.8, 0.9, 0.85]),
      strongB: acc([200, 210, 195], [0.5, 0.55, 0.5]),
      // baseline 2 体: 低 PnL・低 Sharpe
      noop: acc([0, 0, 0], [0.0, 0.0, 0.0]),
      random: acc([-20, 10, -5], [0.02, 0.03, 0.01]),
    }),
  );
  const v = computeVerdict(agents, baselineIds, DEFAULT_THRESHOLDS);
  assert.equal(v.c1.pass, true, "C1");
  assert.equal(v.c2.pass, true, "C2");
  assert.equal(v.c3.pass, true, "C3");
  assert.equal(v.pass, true);
  assert.equal(v.hints.length, 0);
});

test("C1 FAIL: 戦略が baseline を上回れない", () => {
  const baselineIds = new Set(["random"]);
  const agents = aggregateAgents(
    byAgent({
      weak: acc([-50, -40, -60], [-0.2, -0.1, -0.3]),
      random: acc([100, 110, 90], [0.4, 0.5, 0.45]),
    }),
  );
  const c1 = evaluateC1(agents, baselineIds, DEFAULT_THRESHOLDS);
  assert.equal(c1.pass, false);
  assert.equal(c1.beatFraction, 0);
});

test("C2 FAIL: 順位が seed で総入れ替え", () => {
  // 2 体が seed ごとに勝者交代 → Spearman 平均が低い
  const agents = aggregateAgents(
    byAgent({
      a: acc([100, -100, 100, -100], [0.1, 0.1, 0.1, 0.1]),
      b: acc([-100, 100, -100, 100], [0.1, 0.1, 0.1, 0.1]),
    }),
  );
  const c2 = evaluateC2(agents, DEFAULT_THRESHOLDS);
  assert.equal(c2.pass, false);
  assert.ok((c2.meanSpearman ?? 1) < DEFAULT_THRESHOLDS.minSpearman);
});

test("C3 FAIL: 全 agent が同一 Sharpe レンジに潰れる", () => {
  const agents = aggregateAgents(
    byAgent({
      a: acc([100, 120, 90], [0.5, 0.51, 0.5]),
      b: acc([80, 70, 95], [0.5, 0.49, 0.51]),
      c: acc([60, 65, 55], [0.5, 0.5, 0.5]),
    }),
  );
  const c3 = evaluateC3(agents, DEFAULT_THRESHOLDS);
  assert.equal(c3.pass, false);
  assert.ok((c3.sharpeSpread ?? 1) <= DEFAULT_THRESHOLDS.minSharpeSpread);
});

test("しきい値は上書きできる（margin を上げると C1 が厳しくなる）", () => {
  const baselineIds = new Set(["random"]);
  const agents = aggregateAgents(
    byAgent({
      s: acc([105, 106, 104], [0.3, 0.3, 0.3]),
      random: acc([100, 100, 100], [0.3, 0.3, 0.3]),
    }),
  );
  // margin 0 なら 5 USDC 差で合格
  assert.equal(evaluateC1(agents, baselineIds, DEFAULT_THRESHOLDS).pass, true);
  // margin 50 にすると 5 USDC 差では不合格
  const strict: DiscriminationThresholds = {
    ...DEFAULT_THRESHOLDS,
    pnlMargin: 50,
  };
  assert.equal(evaluateC1(agents, baselineIds, strict).pass, false);
});
