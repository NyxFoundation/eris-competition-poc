// 競争環境の「識別力(discrimination power)」の集計と判定。
//
// ADR 0001 P1: 環境が、戦略の実力差を結果(PnL/Sharpe)の差として安定に表せるか。
// 多様な戦略 + ベースライン(noop/random)を多 seed で実走した結果から 3 条件を判定する:
//   C1 実力報酬   — 賢い戦略の median が baseline を明確に上回る
//   C2 順位安定   — 上位↔下位の gap が seed をまたいで安定(総入れ替えなら不合格)
//   C3 Sharpe 非潰れ — 全 agent が同一 Sharpe レンジに潰れていない
//
// このモジュールは **純関数のみ**(coordinator/fs に依存しない)→ ユニットテスト可能。
// 多 seed の実走ループは src/multiSeedRun.ts、CLI は scripts/discrimination.ts。
// 集計(aggregateAgents)は evaluate.ts(過学習ゲート)とも共有し、Sharpe/PnL の基準を一致させる。

export type AgentAcc = {
  netPnl: number[]; // seed 順の net PnL(USDC)
  sharpe: number[]; // seed 順の Sharpe(計算不能 seed は欠落しうる)
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

// seed 横断アキュムレータ → 集計済み agent 配列。Sharpe median 降順 → PnL median 降順。
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
      revertTotal: sum(acc.revert),
      includedTotal: sum(acc.included),
    }))
    .sort(
      (a, b) =>
        (b.sharpe.median ?? -Infinity) - (a.sharpe.median ?? -Infinity) ||
        b.netPnl.median - a.netPnl.median,
    );
}

// ---------------------------------------------------------------------------
// 識別力の判定(3 条件)
// ---------------------------------------------------------------------------

// しきい値は ADR「決めていないこと」: P1 実走データを見て確定する。ここでは暫定既定を置き、
// scripts/discrimination.ts が env(DISC_*)で上書きできるようにする。
export type DiscriminationThresholds = {
  pnlMargin: number; // C1: 戦略が最強 baseline を上回る最小 PnL gap(USDC)
  sharpeMargin: number; // C1: 同 Sharpe gap
  minBeatFraction: number; // C1: baseline を上回るべき戦略の割合(0..1)
  minSpearman: number; // C2: seed 間順位相関(平均)の下限
  maxGapCv: number; // C2: top-bottom gap の変動係数(CV)上限
  minSharpeSpread: number; // C3: median Sharpe の (max-min) 下限
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
  sharpeMedian: number | null;
  pnlGap: number; // 戦略 median - 最強 baseline median(PnL)
  sharpeGap: number | null;
  beats: boolean;
};

export type C1Result = {
  pass: boolean;
  bestBaselinePnlMedian: number | null;
  bestBaselineSharpeMedian: number | null;
  beatFraction: number;
  strategies: C1StrategyRow[];
};

// C1: 賢い戦略の median(PnL & Sharpe)が「最強 baseline」を margin 以上上回るか。
// 最強 baseline(= median が最も高い baseline)を超えられない戦略は実力を報酬されていない。
export function evaluateC1(
  agents: AgentAggregate[],
  baselineIds: Set<string>,
  t: DiscriminationThresholds,
): C1Result {
  const { baselines, strategies } = classifyRoles(agents, baselineIds);
  const bestBaselinePnl = baselines.length
    ? Math.max(...baselines.map((b) => b.netPnl.median))
    : null;
  const baselineSharpes = baselines
    .map((b) => b.sharpe.median)
    .filter((x): x is number => x !== null);
  const bestBaselineSharpe = baselineSharpes.length
    ? Math.max(...baselineSharpes)
    : null;

  const rows: C1StrategyRow[] = strategies.map((s) => {
    const pnlGap =
      bestBaselinePnl === null ? 0 : s.netPnl.median - bestBaselinePnl;
    const sharpeGap =
      s.sharpe.median !== null && bestBaselineSharpe !== null
        ? s.sharpe.median - bestBaselineSharpe
        : null;
    const beatsPnl = bestBaselinePnl !== null && pnlGap >= t.pnlMargin;
    // Sharpe は計算不能 seed があり得るので、欠落時は PnL のみで判定(true 扱い)。
    const beatsSharpe = sharpeGap === null ? true : sharpeGap >= t.sharpeMargin;
    return {
      id: s.id,
      pnlMedian: s.netPnl.median,
      sharpeMedian: s.sharpe.median,
      pnlGap,
      sharpeGap,
      beats: beatsPnl && beatsSharpe,
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
    bestBaselinePnlMedian: bestBaselinePnl,
    bestBaselineSharpeMedian: bestBaselineSharpe,
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
  sharpeSpread: number | null; // median Sharpe の max-min
  maxSharpe: number | null;
  minSharpe: number | null;
};

// C3: 全 agent の median Sharpe が同一レンジに潰れていないか。spread が小さい=戦略差が出ていない。
export function evaluateC3(
  agents: AgentAggregate[],
  t: DiscriminationThresholds,
): C3Result {
  const sharpes = agents
    .map((a) => a.sharpe.median)
    .filter((x): x is number => x !== null);
  if (sharpes.length < 2) {
    return {
      pass: false,
      sharpeSpread: null,
      maxSharpe: sharpes[0] ?? null,
      minSharpe: sharpes[0] ?? null,
    };
  }
  const mx = Math.max(...sharpes);
  const mn = Math.min(...sharpes);
  const spread = mx - mn;
  return {
    pass: spread > t.minSharpeSpread,
    sharpeSpread: spread,
    maxSharpe: mx,
    minSharpe: mn,
  };
}

export type DiscriminationVerdict = {
  pass: boolean;
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
      "C3 不合格: 全 agent が同一 Sharpe レンジに潰れている → 戦略差が出る機会が無い。arb 機会サイズ↑・戦略多様性↑。",
    );
  }
  return {
    pass: c1.pass && c2.pass && c3.pass,
    thresholds: t,
    baselineIds: [...baselineIds],
    c1,
    c2,
    c3,
    hints,
  };
}
