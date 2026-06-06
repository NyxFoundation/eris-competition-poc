/**
 * stat-arb: rolling-stats driven arb agent with z-score sizing and dynamic
 *           priority fee bidding.
 *
 * Compared to arb-bot (fixed gap threshold, fixed sizing schedule):
 *   - Threshold is data-driven: enter when |z(gap)| > STAT_ARB_Z_ENTER.
 *   - Size scales with |z| (capped at 50% of per-round swap limit).
 *   - Priority fee is EV-proportional: bid ≈ alpha * EV_wei / gasEstimate,
 *     clamped to the simulator's [defaultPriorityFee, maxPriorityFee] band.
 *   - During burn-in (rolling stats not yet meaningful) emit noop. The
 *     observation's `history` field is replayed on startup so late-spawned
 *     agents don't need a fresh N rounds of cold start.
 *
 * Env vars:
 *   STAT_ARB_WINDOW         (default 64)  burn-in stats window metadata; the
 *                                          Welford estimator is unbounded, so
 *                                          this only labels the tuning window.
 *   STAT_ARB_Z_ENTER        (default 1.5) minimum |z| to take a position.
 *   STAT_ARB_Z_AGGRESSIVE   (default 2.5) |z| at which sizing saturates the
 *                                          50% cap; below this, size scales
 *                                          linearly from Z_ENTER → cap.
 *   STAT_ARB_BID_ALPHA      (default 0.3) fraction of expected EV (wei) routed
 *                                          to priority fee bidding.
 *   STAT_ARB_BURN_IN        (default 20)  minimum sample count before trading.
 */
import { createInterface } from "node:readline";
import { RollingStats } from "../lib/rolling-stats.js";

type HistoryPoint = { round: number; poolPriceUsdcPerWeth: number; fairPriceUsdcPerWeth: number };

type Observation = {
  round: number;
  pool: { priceUsdcPerWeth: number };
  fairPriceUsdcPerWeth: number;
  history?: HistoryPoint[];
  limits: {
    maxWethInWei: string;
    maxUsdcInUnits: string;
    defaultPriorityFeePerGasWei: string;
    maxPriorityFeePerGasWei: string;
  };
};

const WINDOW = Math.max(2, Math.floor(Number(process.env.STAT_ARB_WINDOW ?? "64")));
const Z_ENTER = Number(process.env.STAT_ARB_Z_ENTER ?? "1.5");
const Z_AGGRESSIVE = Number(process.env.STAT_ARB_Z_AGGRESSIVE ?? "2.5");
const BID_ALPHA = Number(process.env.STAT_ARB_BID_ALPHA ?? "0.3");
const BURN_IN = Math.max(2, Math.floor(Number(process.env.STAT_ARB_BURN_IN ?? "20")));

const GAS_UNITS_ESTIMATE = 180_000n;
const SIZE_CAP_BPS = 5000; // 50% of per-round swap limit
const SIZE_FLOOR_BPS = 500; // 5% — when |z| barely clears Z_ENTER

if (!Number.isFinite(Z_ENTER) || Z_ENTER <= 0) {
  process.stderr.write(`invalid STAT_ARB_Z_ENTER: ${process.env.STAT_ARB_Z_ENTER}\n`);
  process.exit(1);
}
if (!Number.isFinite(Z_AGGRESSIVE) || Z_AGGRESSIVE <= Z_ENTER) {
  process.stderr.write(`invalid STAT_ARB_Z_AGGRESSIVE (must be > Z_ENTER): ${process.env.STAT_ARB_Z_AGGRESSIVE}\n`);
  process.exit(1);
}
if (!Number.isFinite(BID_ALPHA) || BID_ALPHA < 0) {
  process.stderr.write(`invalid STAT_ARB_BID_ALPHA: ${process.env.STAT_ARB_BID_ALPHA}\n`);
  process.exit(1);
}

const stats = new RollingStats(WINDOW);
const seenRounds = new Set<number>();

function computeGap(pool: number, fair: number): number | null {
  if (!Number.isFinite(pool) || pool <= 0) return null;
  if (!Number.isFinite(fair) || fair <= 0) return null;
  return fair / pool - 1;
}

function seedFromHistory(history: HistoryPoint[] | undefined): void {
  if (!history || history.length === 0) return;
  for (const point of history) {
    if (seenRounds.has(point.round)) continue;
    const gap = computeGap(point.poolPriceUsdcPerWeth, point.fairPriceUsdcPerWeth);
    if (gap === null) continue;
    stats.update(gap);
    seenRounds.add(point.round);
  }
}

function noop(reason: string): string {
  return `${JSON.stringify({ type: "noop", reason })}\n`;
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let obs: Observation;
  try {
    obs = JSON.parse(line) as Observation;
  } catch (err) {
    process.stdout.write(noop(`parse error: ${(err as Error).message}`));
    return;
  }

  seedFromHistory(obs.history);

  const pool = obs.pool.priceUsdcPerWeth;
  const fair = obs.fairPriceUsdcPerWeth;
  const gap = computeGap(pool, fair);
  if (gap === null) {
    process.stdout.write(noop("invalid prices"));
    return;
  }

  // Score against the current model BEFORE incorporating the new sample —
  // otherwise the latest point pulls the mean toward itself and damps the
  // signal. Then fold it in for next round.
  const z = stats.zscore(gap);
  stats.update(gap);
  seenRounds.add(obs.round);

  if (stats.count() < BURN_IN) {
    process.stdout.write(noop(`burn-in (${stats.count()}/${BURN_IN})`));
    return;
  }

  const absZ = Math.abs(z);
  if (absZ < Z_ENTER) {
    process.stdout.write(noop(`|z|=${absZ.toFixed(2)} < ${Z_ENTER}`));
    return;
  }

  const tokenIn: "WETH" | "USDC" = gap > 0 ? "USDC" : "WETH";
  const max = BigInt(tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits);

  // Linear ramp: SIZE_FLOOR_BPS at |z| = Z_ENTER, SIZE_CAP_BPS at |z| >= Z_AGGRESSIVE.
  const span = Math.max(0.0001, Z_AGGRESSIVE - Z_ENTER);
  const t = Math.max(0, Math.min(1, (absZ - Z_ENTER) / span));
  const sizeBps = Math.max(SIZE_FLOOR_BPS, Math.min(SIZE_CAP_BPS, Math.floor(SIZE_FLOOR_BPS + (SIZE_CAP_BPS - SIZE_FLOOR_BPS) * t)));
  const amountIn = (max * BigInt(sizeBps)) / 10_000n;

  if (amountIn <= 0n) {
    process.stdout.write(noop("size rounds to zero"));
    return;
  }

  // EV in USDC ≈ size_usdc * |gap|. Convert to wei via fair price.
  const sizeUsdc =
    tokenIn === "USDC"
      ? Number(amountIn) / 1e6
      : (Number(amountIn) / 1e18) * fair;
  const evUsdc = sizeUsdc * Math.abs(gap);
  const evGwei = Math.max(0, Math.floor((evUsdc / fair) * 1e9));
  const evWei = BigInt(evGwei) * 1_000_000_000n;

  const alphaScale = 10_000n;
  const alphaNum = BigInt(Math.max(0, Math.floor(BID_ALPHA * Number(alphaScale))));
  const bidPerGasWei = (evWei * alphaNum) / alphaScale / GAS_UNITS_ESTIMATE;

  const minBid = BigInt(obs.limits.defaultPriorityFeePerGasWei);
  const maxBid = BigInt(obs.limits.maxPriorityFeePerGasWei);
  const bid = bidPerGasWei < minBid ? minBid : bidPerGasWei > maxBid ? maxBid : bidPerGasWei;

  process.stdout.write(
    `${JSON.stringify({
      type: "swap",
      tokenIn,
      amountIn: amountIn.toString(),
      maxPriorityFeePerGasWei: bid.toString(),
      slippageBps: 75
    })}\n`
  );
});
