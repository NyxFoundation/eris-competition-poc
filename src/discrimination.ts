// 競争環境の「識別力(discrimination power)」の集計と判定。
//
// ADR 0001 P1: 環境が、戦略の実力差を結果(PnL/リスク調整リターン)の差として安定に表せるか。
// 多様な戦略 + ベースライン(noop/random)を多 seed で実走した結果から 3 条件を判定する:
//   C1 実力報酬   — 賢い戦略の median が baseline を明確に上回る
//   C2 順位安定   — 上位↔下位の gap が seed をまたいで安定(総入れ替えなら不合格)
//   C3 risk 非潰れ — 全 agent が同一リスク調整リターンに潰れていない
//
// リスク調整リターンは「総リターン Sharpe」ではなく **information ratio(noop 比の超過リターン
// Sharpe)** を優先する。全員が WETH を保有すると総リターン Sharpe は共有 ETH ベータに支配され
// 全員同値に潰れる(実力でなくベータを測る)。noop は「初期保有を持つだけ」= ベータ基準なので、
// 各ラウンドの超過リターン(agent - noop)の Sharpe を取るとベータが剥がれ実力(alpha)が出る。
// ベンチマークが無い場合(infoRatio 未計算)は従来の総リターン Sharpe にフォールバックする。
//
// このモジュールは **純関数のみ**(coordinator/fs に依存しない)→ ユニットテスト可能。
// 多 seed の実走ループは src/multiSeedRun.ts、CLI は scripts/discrimination.ts。
// 集計(aggregateAgents)は evaluate.ts(過学習ゲート)とも共有し、Sharpe/PnL の基準を一致させる。

export type RiskMetric = "infoRatio" | "sharpe";

export type AgentAcc = {
  netPnl: number[]; // seed 順の net PnL(USDC)
  sharpe: number[]; // seed 順の総リターン Sharpe(計算不能 seed は欠落しうる)
  infoRatio: number[]; // seed 順の information ratio(noop 比。ベンチマーク無しなら空)
  revert: number[];
  included: number[];
};

export type AgentAggregate = {
  id: string;
  netPnl: {
    perSeed: number[];
    median: number;
    mean: number;
    min: number;
    stdev: number;
    winRate: number;
  };
  sharpe: { perSeed: number[]; median: number | null; mean: number | null };
  infoRatio: { perSeed: number[]; median: number | null; mean: number | null };
  revertTotal: number;
  includedTotal: number;
};

// --- 集計ヘルパ(test / evaluate と共有) ---
export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
export function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

// information ratio: ベンチマーク(noop)に対する超過リターンの Sharpe。
// 各ラウンドの単純リターン rv,rb を取り excess = rv - rb の mean/std。スケール不変。
export function informationRatio(
  values: number[],
  benchmark: number[],
): number | null {
  const n = Math.min(values.length, benchmark.length);
  if (n < 3) return null;
  const excess: number[] = [];
  for (let i = 1; i < n; i++) {
    const pv = values[i - 1];
    const pb = benchmark[i - 1];
    if (pv === 0 || pb === 0 || !Number.isFinite(pv) || !Number.isFinite(pb))
      continue;
    const rv = (values[i] - values[i - 1]) / pv;
    const rb = (benchmark[i] - benchmark[i - 1]) / pb;
    excess.push(rv - rb);
  }
  if (excess.length < 2) return null;
  const m = mean(excess);
  const sd = stdev(excess);
  if (!Number.isFinite(sd) || sd === 0) return null;
  return m / sd;
}

// 判定に使うリスク調整 metric の median。infoRatio があればそれ、無ければ総リターン Sharpe。
function riskMedianOf(a: AgentAggregate, useInfoRatio: boolean): number | null {
  return useInfoRatio ? a.infoRatio.median : a.sharpe.median;
}
// ロスター内に有効な infoRatio が 1 つでもあれば infoRatio を採用。
function useInfoRatioFor(agents: AgentAggregate[]): boolean {
  return agents.some((a) => a.infoRatio.median !== null);
}

// seed 横断アキュムレータ → 集計済み agent 配列。リスク調整 metric 降順 → PnL median 降順。
// evaluate.ts の出力もこれを使うので、両者の数値基準が一致する。
export function aggregateAgents(
  byAgent: Map<string, AgentAcc>,
): AgentAggregate[] {
  return [...byAgent.entries()]
    .map(([id, acc]) => ({
      id,
      netPnl: {
        perSeed: acc.netPnl,
        median: median(acc.netPnl),
        mean: mean(acc.netPnl),
        min: acc.netPnl.length ? Math.min(...acc.netPnl) : 0,
        stdev: stdev(acc.netPnl),
        winRate: acc.netPnl.length
          ? acc.netPnl.filter((v) => v > 0).length / acc.netPnl.length
          : 0,
      },
      sharpe: {
        perSeed: acc.sharpe,
        median: acc.sharpe.length ? median(acc.sharpe) : null,
        mean: acc.sharpe.length ? mean(acc.sharpe) : null,
      },
      infoRatio: {
        perSeed: acc.infoRatio,
        median: acc.infoRatio.length ? median(acc.infoRatio) : null,
        mean: acc.infoRatio.length ? mean(acc.infoRatio) : null,
      },
      revertTotal: sum(acc.revert),
      includedTotal: sum(acc.included),
    }))
    .sort((a, b) => {
      const ra = a.infoRatio.median ?? a.sharpe.median ?? -Infinity;
      const rb = b.infoRatio.median ?? b.sharpe.median ?? -Infinity;
      return rb - ra || b.netPnl.median - a.netPnl.median;
    });
}

// ---------------------------------------------------------------------------
// 識別力の判定(3 条件)
// ---------------------------------------------------------------------------

// しきい値は ADR「決めていないこと」: P1 実走データを見て確定する。ここでは暫定既定を置き、
// scripts/discrimination.ts が env(DISC_*)で上書きできるようにする。
// sharpeMargin / minSharpeSpread は「判定に使うリスク調整 metric(infoRatio 優先)」に適用される。
export type DiscriminationThresholds = {
  pnlMargin: number; // C1: 戦略が最強 baseline を上回る最小 PnL gap(USDC)
  sharpeMargin: number; // C1: 同 リスク調整 metric の gap
  minBeatFraction: number; // C1: baseline を上回るべき戦略の割合(0..1)
  minSpearman: number; // C2: seed 間順位相関(平均)の下限
  maxGapCv: number; // C2: top-bottom gap の変動係数(CV)上限
  minSharpeSpread: number; // C3: リスク調整 metric の median (max-min) 下限
};

export const DEFAULT_THRESHOLDS: DiscriminationThresholds = {
  pnlMargin: 0,
  sharpeMargin: 0,
  minBeatFraction: 0.5,
  minSpearman: 0.5,
  maxGapCv: 1.0,
  minSharpeSpread: 0.04,
};

export function classifyRoles(
  agents: AgentAggregate[],
  baselineIds: Set<string>,
): { baselines: AgentAggregate[]; strategies: AgentAggregate[] } {
  return {
    baselines: agents.filter((a) => baselineIds.has(a.id)),
    strategies: agents.filter((a) => !baselineIds.has(a.id)),
  };
}

export type C1StrategyRow = {
  id: string;
  pnlMedian: number;
  pnlGap: number; // 戦略 median - 最強 baseline median(PnL)
  sharpeMedian: number | null; // 総リターン Sharpe(参考)
  infoRatioMedian: number | null; // 超過(noop 比) = information ratio(参考)
  riskGap: number | null; // 判定に使う metric の gap
  beats: boolean;
};

export type C1Result = {
  pass: boolean;
  riskMetric: RiskMetric; // 判定に使ったリスク調整 metric
  bestBaselinePnlMedian: number | null;
  bestBaselineRiskMedian: number | null;
  beatFraction: number;
  strategies: C1StrategyRow[];
};

// C1: 賢い戦略の median(PnL & リスク調整リターン)が「最強 baseline」を margin 以上上回るか。
// 最強 baseline(= median が最も高い baseline)を超えられない戦略は実力を報酬されていない。
export function evaluateC1(
  agents: AgentAggregate[],
  baselineIds: Set<string>,
  t: DiscriminationThresholds,
): C1Result {
  const { baselines, strategies } = classifyRoles(agents, baselineIds);
  const useIR = useInfoRatioFor(agents);
  const risk = (a: AgentAggregate) => riskMedianOf(a, useIR);

  const bestBaselinePnl = baselines.length
    ? Math.max(...baselines.map((b) => b.netPnl.median))
    : null;
  const baselineRisks = baselines
    .map(risk)
    .filter((x): x is number => x !== null);
  const bestBaselineRisk = baselineRisks.length
    ? Math.max(...baselineRisks)
    : null;

  const rows: C1StrategyRow[] = strategies.map((s) => {
    const pnlGap =
      bestBaselinePnl === null ? 0 : s.netPnl.median - bestBaselinePnl;
    const sRisk = risk(s);
    const riskGap =
      sRisk !== null && bestBaselineRisk !== null
        ? sRisk - bestBaselineRisk
        : null;
    const beatsPnl = bestBaselinePnl !== null && pnlGap >= t.pnlMargin;
    // リスク調整 metric は計算不能 seed があり得るので、欠落時は PnL のみで判定(true 扱い)。
    const beatsRisk = riskGap === null ? true : riskGap >= t.sharpeMargin;
    return {
      id: s.id,
      pnlMedian: s.netPnl.median,
      pnlGap,
      sharpeMedian: s.sharpe.median,
      infoRatioMedian: s.infoRatio.median,
      riskGap,
      beats: beatsPnl && beatsRisk,
    };
  });

  const beatFraction = rows.length
    ? rows.filter((r) => r.beats).length / rows.length
    : 0;
  const pass =
    baselines.length > 0 &&
    strategies.length > 0 &&
    beatFraction >= t.minBeatFraction;

  return {
    pass,
    riskMetric: useIR ? "infoRatio" : "sharpe",
    bestBaselinePnlMedian: bestBaselinePnl,
    bestBaselineRiskMedian: bestBaselineRisk,
    beatFraction,
    strategies: rows,
  };
}

// 2 つの順位列(agent 整列)の Spearman 相関 = ランクに対する Pearson。
// 縮退(分散 0)は「完全一致 = 安定」とみなし 1 を返す。
export function spearman(rankA: number[], rankB: number[]): number {
  const n = rankA.length;
  if (n < 2) return 1;
  const ma = mean(rankA);
  const mb = mean(rankB);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = rankA[i] - ma;
    const db = rankB[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return 1;
  return cov / Math.sqrt(va * vb);
}

export type C2Result = {
  pass: boolean;
  seeds: number;
  meanSpearman: number | null; // seed 間順位相関の平均(1=毎回同順, ~0=無相関, <0=逆転)
  gapCv: number | null; // top-bottom gap の変動係数
  perSeedTopBottomGap: number[];
};

// C2: seed ごとに PnL 降順の順位を作り、seed 間の順位相関(平均 Spearman)と
// top-bottom gap の安定性(CV)を見る。順位が seed で総入れ替えならノイズ。
export function evaluateC2(
  agents: AgentAggregate[],
  t: DiscriminationThresholds,
): C2Result {
  const nSeeds = agents.reduce(
    (mx, a) => Math.max(mx, a.netPnl.perSeed.length),
    0,
  );
  if (nSeeds < 2 || agents.length < 2) {
    return {
      pass: false,
      seeds: nSeeds,
      meanSpearman: null,
      gapCv: null,
      perSeedTopBottomGap: [],
    };
  }

  const ranksBySeed: number[][] = [];
  const gaps: number[] = [];
  for (let s = 0; s < nSeeds; s++) {
    const pnls = agents.map((a) => a.netPnl.perSeed[s] ?? 0);
    gaps.push(Math.max(...pnls) - Math.min(...pnls));
    const order = pnls.map((p, i) => ({ p, i })).sort((x, y) => y.p - x.p);
    const rank = new Array<number>(agents.length).fill(0);
    order.forEach((o, idx) => {
      rank[o.i] = idx + 1;
    });
    ranksBySeed.push(rank);
  }

  let total = 0;
  let count = 0;
  for (let i = 0; i < nSeeds; i++) {
    for (let j = i + 1; j < nSeeds; j++) {
      total += spearman(ranksBySeed[i], ranksBySeed[j]);
      count++;
    }
  }
  const meanSpearman = count ? total / count : null;
  const gapMean = mean(gaps);
  const gapCv = gapMean !== 0 ? stdev(gaps) / Math.abs(gapMean) : 0;
  const pass =
    meanSpearman !== null &&
    meanSpearman >= t.minSpearman &&
    gapCv <= t.maxGapCv;

  return {
    pass,
    seeds: nSeeds,
    meanSpearman,
    gapCv,
    perSeedTopBottomGap: gaps,
  };
}

export type C3Result = {
  pass: boolean;
  riskMetric: RiskMetric;
  sharpeSpread: number | null; // 判定に使う metric の median の max-min
  maxSharpe: number | null;
  minSharpe: number | null;
};

// C3: 全 agent のリスク調整 metric の median が同一レンジに潰れていないか。
// spread が小さい = 戦略差が出ていない。
export function evaluateC3(
  agents: AgentAggregate[],
  t: DiscriminationThresholds,
): C3Result {
  const useIR = useInfoRatioFor(agents);
  const vals = agents
    .map((a) => riskMedianOf(a, useIR))
    .filter((x): x is number => x !== null);
  const riskMetric: RiskMetric = useIR ? "infoRatio" : "sharpe";
  if (vals.length < 2) {
    return {
      pass: false,
      riskMetric,
      sharpeSpread: null,
      maxSharpe: vals[0] ?? null,
      minSharpe: vals[0] ?? null,
    };
  }
  const mx = Math.max(...vals);
  const mn = Math.min(...vals);
  const spread = mx - mn;
  return {
    pass: spread > t.minSharpeSpread,
    riskMetric,
    sharpeSpread: spread,
    maxSharpe: mx,
    minSharpe: mn,
  };
}

export type DiscriminationVerdict = {
  pass: boolean;
  riskMetric: RiskMetric; // C1/C3 が使ったリスク調整 metric
  thresholds: DiscriminationThresholds;
  baselineIds: string[];
  c1: C1Result;
  c2: C2Result;
  c3: C3Result;
  hints: string[]; // 不合格時に sim-loop で引くべきレバーの示唆
};

export function computeVerdict(
  agents: AgentAggregate[],
  baselineIds: Set<string>,
  t: DiscriminationThresholds = DEFAULT_THRESHOLDS,
): DiscriminationVerdict {
  const c1 = evaluateC1(agents, baselineIds, t);
  const c2 = evaluateC2(agents, t);
  const c3 = evaluateC3(agents, t);
  const hints: string[] = [];
  if (!c1.pass) {
    hints.push(
      "C1 不合格: 賢い戦略が baseline を上回れていない → 機会が薄い / フロー過小 / 手数料・ガス過大。sim-loop で flow 強度↑・fee/gas↓・arb 機会サイズ↑ を 1 つずつ。",
    );
  }
  if (!c2.pass) {
    hints.push(
      "C2 不合格: 順位が seed で不安定(運次第) → 非定常。SEEDS を増やす / flow の決定論を確認 / 勝者総取りを緩和。",
    );
  }
  if (!c3.pass) {
    hints.push(
      "C3 不合格: 全 agent が同一のリスク調整リターンに潰れている → 戦略差が出る機会が無い。arb 機会サイズ↑・戦略多様性↑。",
    );
  }
  return {
    pass: c1.pass && c2.pass && c3.pass,
    riskMetric: c1.riskMetric,
    thresholds: t,
    baselineIds: [...baselineIds],
    c1,
    c2,
    c3,
    hints,
  };
}
