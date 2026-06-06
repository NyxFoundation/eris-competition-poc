/**
 * RollingStats: Welford's online algorithm for streaming mean / variance.
 *
 * Numerically stable, unbounded sample count (no fixed window — see note).
 * Used by stat-arb to feed pool/fair gap series and pull a z-score per round.
 *
 * Note: this implementation is unbounded; older samples are not evicted. The
 * `windowHint` constructor argument is metadata only (callers can read it via
 * `.windowHint`) so a single env var can express both "how long is the
 * burn-in" and "what window were you tuned against".
 *
 * Usage:
 *   const rs = new RollingStats();
 *   rs.update(0.001);
 *   rs.update(-0.0005);
 *   rs.zscore(0.0008); // (0.0008 - mean) / std
 */
export class RollingStats {
  private n = 0;
  private mu = 0;
  private m2 = 0;
  readonly windowHint: number;

  constructor(windowHint = 0) {
    this.windowHint = windowHint;
  }

  update(x: number): void {
    if (!Number.isFinite(x)) return;
    this.n += 1;
    const delta = x - this.mu;
    this.mu += delta / this.n;
    const delta2 = x - this.mu;
    this.m2 += delta * delta2;
  }

  count(): number {
    return this.n;
  }

  mean(): number {
    return this.n > 0 ? this.mu : 0;
  }

  /**
   * Sample standard deviation (n-1 denominator). Returns 0 if fewer than 2
   * samples have been recorded.
   */
  std(): number {
    if (this.n < 2) return 0;
    const variance = this.m2 / (this.n - 1);
    return variance > 0 ? Math.sqrt(variance) : 0;
  }

  /**
   * Z-score of `x` against the running mean/std. Returns 0 if std is 0 (no
   * spread observed yet) so callers can treat "uninformative" as "do nothing".
   */
  zscore(x: number): number {
    const s = this.std();
    if (s === 0) return 0;
    return (x - this.mu) / s;
  }
}
