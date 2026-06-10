// unpaired 統計層（ADR 0005）。
//
// 実時間化（決定論を捨てる）後は「同一 SEED の before/after = 同一市場」の paired 比較が
// 成立しない。代わりに各 config を N 回 i.i.d. 反復実行し、unpaired 統計で比較する:
//   - bootstrapMeanDiffCI: mean(xs) − mean(ys) の percentile bootstrap CI（既定の検定）
//   - welchT / mannWhitney: 補助検定（分布の形を見て最終選択する。ADR「決めていないこと」）
//   - evaluateUnpairedGate: strategy-evolve の受理ゲート本体
//     improve      … CI 下限 > 0（有意な改善）
//     noninferior  … CI 上限が −margin を割らない（holdout regime の汎化チェック）
//
// このモジュールは **純関数のみ**（coordinator/fs に依存しない）→ ユニットテスト可能。
// bootstrap は自前 Rng(seed) で決定論的に動く（同入力・同 seed = 同結果）。
import { Rng } from "./rng.js";

function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function varianceOf(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}

// 線形補間 percentile（xs はソート済みであること）。
function percentileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function resampleMean(xs: number[], rng: Rng): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[rng.int(0, xs.length)];
  return s / xs.length;
}

export type BootstrapOptions = {
  iterations?: number; // 既定 4000
  level?: number; // 両側信頼水準（既定 0.9。具体値は実測後に再較正 = ADR「決めていないこと」）
  seed?: number; // bootstrap の決定論 seed（既定 12345）
};

export type BootstrapCI = {
  meanDiff: number; // mean(xs) − mean(ys)
  low: number; // CI 下限
  high: number; // CI 上限
  level: number;
  iterations: number;
};

// mean(xs) − mean(ys) の unpaired percentile bootstrap CI。
// xs/ys を独立に復元抽出して差を iterations 回作り、分位点を取る。
// サンプルが片側 2 未満なら判定不能として null（呼び側で「データ不足」を明示する）。
export function bootstrapMeanDiffCI(
  xs: number[],
  ys: number[],
  opts: BootstrapOptions = {},
): BootstrapCI | null {
  if (xs.length < 2 || ys.length < 2) return null;
  const iterations = opts.iterations ?? 4000;
  const level = opts.level ?? 0.9;
  const rng = new Rng(opts.seed ?? 12345);
  const diffs: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    diffs[i] = resampleMean(xs, rng) - resampleMean(ys, rng);
  }
  diffs.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return {
    meanDiff: meanOf(xs) - meanOf(ys),
    low: percentileSorted(diffs, alpha),
    high: percentileSorted(diffs, 1 - alpha),
    level,
    iterations,
  };
}

// --- Welch の t 検定（補助） ---

// Lanczos 近似の log-gamma。
function logGamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // 反射公式
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (x + i + 1);
  return (
    0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
  );
}

// 正則化不完全ベータ I_x(a,b)。連分数（Lentz 法）。t 分布の CDF に使う。
function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta =
    logGamma(a + b) -
    logGamma(a) -
    logGamma(b) +
    a * Math.log(x) +
    b * Math.log(1 - x);
  const front = Math.exp(lnBeta);
  // 収束の良い側で評価し、必要なら対称性で反転。
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedIncompleteBeta(b, a, 1 - x);
  }
  const tiny = 1e-300;
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 200; i++) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0)
      numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else
      numerator =
        -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    const delta = c * d;
    f *= delta;
    if (Math.abs(1 - delta) < 1e-10) break;
  }
  // Lentz 法は f=1 から始めて初項(numerator=1)で 1 を余分に掛けるため、f−1 が連分数の値。
  return (front / a) * (f - 1);
}

// 両側 p 値: P(|T_df| > |t|) = I_{df/(df+t²)}(df/2, 1/2)
function studentTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  if (df <= 0) return 1;
  const x = df / (df + t * t);
  return regularizedIncompleteBeta(df / 2, 0.5, x);
}

export type WelchResult = {
  t: number;
  df: number;
  p: number; // 両側
};

// Welch の t（不等分散）。サンプル不足は null。両分散 0 のときは差の有無で退化処理。
export function welchT(xs: number[], ys: number[]): WelchResult | null {
  if (xs.length < 2 || ys.length < 2) return null;
  const diff = meanOf(xs) - meanOf(ys);
  const vx = varianceOf(xs) / xs.length;
  const vy = varianceOf(ys) / ys.length;
  const se = Math.sqrt(vx + vy);
  if (se === 0) {
    return diff === 0
      ? { t: 0, df: xs.length + ys.length - 2, p: 1 }
      : {
          t: diff > 0 ? Infinity : -Infinity,
          df: xs.length + ys.length - 2,
          p: 0,
        };
  }
  const t = diff / se;
  const df =
    (vx + vy) ** 2 / (vx ** 2 / (xs.length - 1) + vy ** 2 / (ys.length - 1));
  return { t, df, p: studentTwoSidedP(t, df) };
}

// --- Mann-Whitney U（補助） ---

// 標準正規の両側 p（erfc の有理近似）。
function normalTwoSidedP(z: number): number {
  const az = Math.abs(z);
  // Abramowitz & Stegun 7.1.26 ベースの erfc 近似
  const t = 1 / (1 + 0.3275911 * (az / Math.SQRT2));
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = poly * Math.exp(-(az * az) / 2);
  return Math.min(1, erfc);
}

export type MannWhitneyResult = {
  u: number; // U 統計量（xs 側）
  pGreater: number; // P(X > Y)（同値は 0.5。win-rate としてそのまま読める）
  p: number; // 両側（正規近似・tie 補正）
};

export function mannWhitney(
  xs: number[],
  ys: number[],
): MannWhitneyResult | null {
  const n = xs.length;
  const m = ys.length;
  if (n < 1 || m < 1) return null;
  let u = 0;
  for (const x of xs) {
    for (const y of ys) {
      if (x > y) u += 1;
      else if (x === y) u += 0.5;
    }
  }
  const pGreater = u / (n * m);
  // tie 補正つき正規近似
  const all = [...xs, ...ys].sort((a, b) => a - b);
  const N = n + m;
  let tieTerm = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j] === all[i]) j++;
    const t = j - i;
    tieTerm += t ** 3 - t;
    i = j;
  }
  const mu = (n * m) / 2;
  const sigma2 = N > 1 ? ((n * m) / 12) * (N + 1 - tieTerm / (N * (N - 1))) : 0;
  if (sigma2 <= 0) {
    return { u, pGreater, p: u === mu ? 1 : 0 };
  }
  const z = (u - mu) / Math.sqrt(sigma2);
  return { u, pGreater, p: normalTwoSidedP(z) };
}

// --- strategy-evolve の unpaired 受理ゲート（ADR 0005 §3。ADR 0002 §6 rule 2 を置換） ---

export type GateMode = "improve" | "noninferior";

export type UnpairedGateOptions = BootstrapOptions & {
  mode?: GateMode; // 既定 improve
  margin?: number; // noninferior の劣化許容幅（USDC, ≥0）。CI 上限 < −margin で不合格
};

export type UnpairedGateResult = {
  mode: GateMode;
  pass: boolean;
  reason: string;
  nBefore: number;
  nAfter: number;
  meanBefore: number;
  meanAfter: number;
  meanDiff: number; // mean(after) − mean(before)
  ci: BootstrapCI | null; // mean(after) − mean(before) の bootstrap CI
  winRate: number | null; // P(after run > before run)（補助指標 = Mann-Whitney の効果量）
  welch: WelchResult | null; // 補助
  mannWhitney: MannWhitneyResult | null; // 補助
  margin: number;
};

// before/after 各 N run の netPnl サンプルを unpaired 比較して受理判定する。
//   improve:     bootstrap CI( mean(after) − mean(before) ) の下限 > 0
//   noninferior: 同 CI の上限が −margin を割らない（holdout regime の汎化チェック用）
export function evaluateUnpairedGate(
  before: number[],
  after: number[],
  opts: UnpairedGateOptions = {},
): UnpairedGateResult {
  const mode = opts.mode ?? "improve";
  const margin = opts.margin ?? 0;
  const ci = bootstrapMeanDiffCI(after, before, opts);
  const mw = mannWhitney(after, before);
  const base = {
    mode,
    nBefore: before.length,
    nAfter: after.length,
    meanBefore: meanOf(before),
    meanAfter: meanOf(after),
    meanDiff: meanOf(after) - meanOf(before),
    ci,
    winRate: mw?.pGreater ?? null,
    welch: welchT(after, before),
    mannWhitney: mw,
    margin,
  };
  if (ci === null) {
    return {
      ...base,
      pass: false,
      reason: `サンプル不足（before=${before.length}, after=${after.length}。各 2 run 以上必要）`,
    };
  }
  if (mode === "improve") {
    const pass = ci.low > 0;
    return {
      ...base,
      pass,
      reason: pass
        ? `CI 下限 ${ci.low.toFixed(2)} > 0（有意な改善）`
        : `CI 下限 ${ci.low.toFixed(2)} ≤ 0（改善が有意でない）`,
    };
  }
  const pass = ci.high >= -margin;
  return {
    ...base,
    pass,
    reason: pass
      ? `CI 上限 ${ci.high.toFixed(2)} ≥ −${margin}（劣化閾値内 = 非劣化）`
      : `CI 上限 ${ci.high.toFixed(2)} < −${margin}（holdout で有意に劣化）`,
  };
}
