// Flow / volatility statistics helpers for prediction-style strategies.
// Pure functions; no shared state. Numbers (float) inputs since price observations
// are returned as JS numbers in the observation schema.

export type HistoryPoint = {
  round: number;
  poolPriceUsdcPerWeth: number;
  fairPriceUsdcPerWeth: number;
};

/**
 * Realized variance of `poolPriceUsdcPerWeth` log-returns over the last `window`
 * history points. Uses log-returns so it is scale-invariant and consistent with
 * standard realized-vol estimators.
 *
 * Returns 0 if fewer than 2 valid points are available in the window. The
 * variance is computed with N-1 (sample) denominator; for window=2 this is the
 * single squared log-return.
 */
export function realizedVariance(history: HistoryPoint[], window: number): number {
  if (!Array.isArray(history) || history.length < 2 || window < 2) return 0;
  const slice = history.slice(-window);
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1].poolPriceUsdcPerWeth;
    const curr = slice[i].poolPriceUsdcPerWeth;
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0 || curr <= 0) continue;
    returns.push(Math.log(curr / prev));
  }
  if (returns.length < 1) return 0;
  if (returns.length === 1) return returns[0] * returns[0];
  let mean = 0;
  for (const r of returns) mean += r;
  mean /= returns.length;
  let sumSq = 0;
  for (const r of returns) {
    const d = r - mean;
    sumSq += d * d;
  }
  return sumSq / (returns.length - 1);
}

/**
 * Root-mean-square deviation of `poolPrice` from `fairPrice` (relative) over
 * the last `window` history points. 0 if no points.
 */
export function fairDeviationRms(history: HistoryPoint[], window: number): number {
  if (!Array.isArray(history) || history.length === 0 || window < 1) return 0;
  const slice = history.slice(-window);
  let sumSq = 0;
  let n = 0;
  for (const point of slice) {
    const pool = point.poolPriceUsdcPerWeth;
    const fair = point.fairPriceUsdcPerWeth;
    if (!Number.isFinite(pool) || !Number.isFinite(fair) || fair <= 0) continue;
    const rel = pool / fair - 1;
    sumSq += rel * rel;
    n++;
  }
  if (n === 0) return 0;
  return Math.sqrt(sumSq / n);
}

/**
 * Linear-interpolated quantile (q in [0,1]) of `values`. Returns 0 if empty.
 * Does NOT mutate `values`.
 */
export function quantile(values: number[], q: number): number {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const cleaned = values.filter((v) => Number.isFinite(v));
  if (cleaned.length === 0) return 0;
  if (cleaned.length === 1) return cleaned[0];
  const sorted = cleaned.slice().sort((a, b) => a - b);
  const clamped = Math.max(0, Math.min(1, q));
  const pos = clamped * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
