import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateAgents,
  collapseNetPnlByRegime,
  computeVerdict,
  DEFAULT_THRESHOLDS,
  evaluateC1,
  evaluateC2,
  evaluateC3,
  informationRatio,
  spearman,
  type AgentAcc,
  type DiscriminationThresholds,
} from "../src/discrimination.js";

// seed 横断アキュムレータを手早く組むヘルパ。infoRatio 省略時は空(=総リターン Sharpe へフォールバック)。
function acc(
  netPnl: number[],
  sharpe: number[],
  infoRatio: number[] = [],
): AgentAcc {
  return {
    netPnl,
    sharpe,
    infoRatio,
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
  // 注: ADR 0005 の有意性必須化により、リスク metric が baseline と完全タイ（CI=[0,0]）の
  // 戦略は不合格になる。margin 上書きの検証なので、リスクはわずかに上回るデータにする。
  const agents = aggregateAgents(
    byAgent({
      s: acc([105, 106, 104], [0.31, 0.31, 0.31]),
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

test("informationRatio: 超過リターンの Sharpe（同一系列は null）", () => {
  // 同一系列 → excess 全 0 → std 0 → null
  assert.equal(
    informationRatio([100, 101, 102, 101], [100, 101, 102, 101]),
    null,
  );
  // ベンチマークより毎ラウンド上振れ → 正の IR
  const ir = informationRatio([100, 102, 105, 109], [100, 101, 102, 103]);
  assert.ok(ir !== null && ir > 0);
});

test("C1 は infoRatio を優先（総 Sharpe がタイでも超過リターンで勝てば合格）", () => {
  const baselineIds = new Set(["random"]);
  // 総リターン Sharpe は両者 0.025 でタイ。だが strat は noop 比の超過リターン(infoRatio)で勝つ。
  const agents = aggregateAgents(
    byAgent({
      strat: acc([300, 320, 290], [0.025, 0.025, 0.025], [0.4, 0.45, 0.4]),
      random: acc([60, 70, 65], [0.025, 0.025, 0.025], [0.0, 0.01, 0.0]),
    }),
  );
  const c1 = evaluateC1(agents, baselineIds, DEFAULT_THRESHOLDS);
  assert.equal(c1.riskMetric, "infoRatio");
  assert.equal(c1.pass, true);
  assert.equal(c1.beatFraction, 1);
});

test("infoRatio が無ければ総リターン Sharpe にフォールバック", () => {
  const agents = aggregateAgents(
    byAgent({ a: acc([10, 20], [0.1, 0.2]), b: acc([5, 6], [0.05, 0.06]) }),
  );
  const c3 = evaluateC3(agents, DEFAULT_THRESHOLDS);
  assert.equal(c3.riskMetric, "sharpe");
});

// --- ADR 0005: 反復読み替え（unpaired 統計）の追加ケース ---

test("C1 有意性(ADR 0005): median は超えたが高分散で CI が 0 を跨ぐ → 不合格", () => {
  const baselineIds = new Set(["noop"]);
  const agents = aggregateAgents(
    byAgent({
      // median 150 > 0 だが run 間のぶれが激しく、平均超過の CI 下限 ≤ 0（運の疑い）
      lucky: acc([200, -180, 150, -160, 170], [0.5, 0.5, 0.5, 0.5, 0.5]),
      noop: acc([0, 0, 0, 0, 0], [0, 0, 0, 0, 0]),
    }),
  );
  const c1 = evaluateC1(agents, baselineIds, DEFAULT_THRESHOLDS);
  const row = c1.strategies.find((r) => r.id === "lucky");
  assert.ok(row);
  assert.ok(row.pnlGap > 0, "median 比較では超えている");
  assert.ok(row.pnlCiLow !== null && row.pnlCiLow <= 0, "CI 下限は 0 以下");
  assert.equal(row.beats, false, "有意性必須化により不合格");
  assert.equal(c1.pass, false);
});

test("C1 有意性: 安定して上回る戦略は CI 下限 > 0 で合格のまま", () => {
  const baselineIds = new Set(["noop"]);
  const agents = aggregateAgents(
    byAgent({
      steady: acc([300, 320, 290, 310, 305], [0.8, 0.9, 0.85, 0.8, 0.9]),
      noop: acc([0, 0, 0, 0, 0], [0, 0, 0, 0, 0]),
    }),
  );
  const c1 = evaluateC1(agents, baselineIds, DEFAULT_THRESHOLDS);
  const row = c1.strategies[0];
  assert.ok(row.pnlCiLow !== null && row.pnlCiLow > 0);
  assert.equal(row.beats, true);
  assert.equal(c1.pass, true);
});

test("collapseNetPnlByRegime: regime 内反復を median に畳む（C2 の代表ランク用）", () => {
  const collapsed = collapseNetPnlByRegime(
    byAgent({
      a: acc([1, 3, 5, 7, 9, 11], [0, 0, 0, 0, 0, 0]),
    }),
    [1, 1, 1, 2, 2, 2],
  );
  const a = collapsed.get("a");
  assert.ok(a);
  assert.deepEqual(a.netPnl, [3, 9]);
  assert.deepEqual(a.sharpe, []);
});

test("C2 regime 読み替え: regime 内の順位ノイズは畳めば消え、regime 間の安定が残る", () => {
  // regime 内では勝者が反復ごとに入れ替わる（タイミングノイズ）が、
  // regime 代表値(median)では常に a > b（市場が変わっても順位は安定）。
  const raw = byAgent({
    a: acc([100, -50, 90, 80, -40, 85], [0, 0, 0, 0, 0, 0]),
    b: acc([-60, 95, -55, -45, 70, -50], [0, 0, 0, 0, 0, 0]),
  });
  const regimeOf = [1, 1, 1, 2, 2, 2];
  // 畳まず run ごとに順位を取ると不安定
  const noisy = evaluateC2(aggregateAgents(raw), DEFAULT_THRESHOLDS);
  assert.ok((noisy.meanSpearman ?? 1) < DEFAULT_THRESHOLDS.minSpearman);
  // regime 代表ランクへ畳むと安定
  const collapsed = evaluateC2(
    aggregateAgents(collapseNetPnlByRegime(raw, regimeOf)),
    DEFAULT_THRESHOLDS,
  );
  assert.equal(collapsed.regimes, 2);
  assert.equal(collapsed.meanSpearman, 1);
  assert.equal(collapsed.pass, true);
});

test("computeVerdict: 単一 regime 構成では C2 は参考値（pass 判定から除外）", () => {
  const baselineIds = new Set(["noop"]);
  const raw = byAgent({
    strong: acc([300, 320, 290, 310], [0.8, 0.9, 0.85, 0.8]),
    noop: acc([0, 0, 0, 0], [0, 0, 0, 0]),
  });
  const agents = aggregateAgents(raw);
  const rankAgents = aggregateAgents(collapseNetPnlByRegime(raw, [1, 1, 1, 1]));
  const v = computeVerdict(agents, baselineIds, DEFAULT_THRESHOLDS, {
    rankAgents,
    regimeCount: 1,
  });
  assert.equal(v.c2Skipped, true);
  assert.equal(v.c1.pass, true);
  assert.equal(v.c3.pass, true);
  assert.equal(v.pass, true, "C2 を除外して C1/C3 で判定");
  assert.ok(v.hints.some((h) => h.includes("単一 regime")));
});
