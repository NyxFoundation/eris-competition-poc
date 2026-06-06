import { createInterface } from "node:readline";
import { priceToTick, tickToPrice } from "../lib/tick-math.js";

// Fair-price-anchored narrow-range LP market-maker.
//
// Strategy:
//  - Center an LP range on `fairPriceUsdcPerWeth`, not the live pool tick.
//  - Range half-width = `tickSpacing * FAIR_MM_RANGE_TICK_MULTIPLIER` (N=4..8).
//  - Hold the position across rounds; rebalance (removeLiquidity + collectFees
//    in a single bundle, then mint on the next round) only when fair drifts
//    past half the range from our stored midpoint, OR when the position drifts
//    out of range and is no longer earning fees.
//  - Otherwise emit `collectFees` if there are uncollected fees, else `noop`.
//  - WETH:USDC inventory ratio uses fair price, not pool price, so the mint
//    target sizing reflects what we believe is the true mid.

type ObservationPosition = {
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  tokensOwedWethWei: string;
  tokensOwedUsdcUnits: string;
  amountWethWei: string;
  amountUsdcUnits: string;
  valueUsdc: number;
};

type Observation = {
  round: number;
  pool: {
    priceUsdcPerWeth: number;
    tick: number;
    tickSpacing: number;
    fee: number;
    pair: string;
  };
  fairPriceUsdcPerWeth: number;
  positions: ObservationPosition[];
  balances: {
    ethWei: string;
    wethWei: string;
    usdcUnits: string;
  };
  inventory: {
    valueUsdc: number;
    weth: number;
    usdc: number;
    eth: number;
  };
  limits: {
    defaultPriorityFeePerGasWei: string;
    maxPriorityFeePerGasWei: string;
    defaultSlippageBps: number;
    maxBundleActions: number;
    maxLpWethWei: string;
    maxLpUsdcUnits: string;
    maxOpenPositions: number;
  };
};

const RANGE_TICK_MULTIPLIER = clampInt(
  parseIntEnv("FAIR_MM_RANGE_TICK_MULTIPLIER", 4),
  1,
  64
);
const MINT_BUDGET_BPS = clampInt(parseIntEnv("FAIR_MM_MINT_BUDGET_BPS", 3500), 1, 10_000);
const REMINT_THRESHOLD_BPS = clampInt(
  parseIntEnv("FAIR_MM_REMINT_THRESHOLD_BPS", 150),
  1,
  10_000
);

const MIN_WETH_MINT_WEI = 5_000_000_000_000_000n; // 0.005 WETH
const MIN_USDC_MINT_UNITS = 10_000_000n; // 10 USDC
const LOG_BASE = Math.log(1.0001);

// State held across rounds (process is long-lived per the harness contract).
type ManagedRange = {
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  midTick: number;
  fairAtMint: number;
};
let managed: ManagedRange | null = null;

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let observation: Observation;
  try {
    observation = JSON.parse(line) as Observation;
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ type: "noop", reason: `parse error: ${(err as Error).message}` })}\n`);
    return;
  }
  const action = decide(observation);
  process.stdout.write(`${JSON.stringify(action)}\n`);
});

function decide(observation: Observation) {
  const priorityFee = observation.limits.defaultPriorityFeePerGasWei;
  const spacing = observation.pool.tickSpacing;
  const halfWidthTicks = spacing * RANGE_TICK_MULTIPLIER;
  const poolTick = observation.pool.tick;

  // Refresh managed state from on-chain positions: if the tokenId we remember
  // no longer exists or has zero liquidity, drop it. Otherwise prefer the
  // matching on-chain position so we never act on a stale id.
  const livePosition = pickLivePosition(observation, managed);
  if (!livePosition) {
    managed = null;
  }

  // Compute the fair tick using a pool-tick-anchored ratio so the orientation
  // convention (token0/token1) cancels out: fairTick = poolTick + delta where
  // delta = log(fairPrice/poolPrice) / log(1.0001).
  const fairTickRaw = computeFairTickFromPool(observation);
  // Fall back to absolute conversion if the pool price is degenerate.
  const fairTickAligned =
    fairTickRaw !== null
      ? alignTick(fairTickRaw, spacing)
      : alignTick(priceToTick(observation.fairPriceUsdcPerWeth, spacing), spacing);

  // The mint center is the fair tick, but clamped so the resulting band still
  // contains the current pool tick. If fair has wandered far from pool, this
  // prevents minting a dead (out-of-range) position that earns no fees.
  const centerTick = clampCenterToBracketPoolTick(
    fairTickAligned,
    poolTick,
    halfWidthTicks,
    spacing
  );

  // No live position → consider minting.
  if (!livePosition) {
    return tryMint(observation, centerTick, halfWidthTicks, priorityFee);
  }

  // Live position exists. Decide between (a) rebalance, (b) collect fees, (c) noop.
  const remembered = managed;
  const driftFromCenter =
    remembered === null
      ? Math.abs(centerTick - midTick(livePosition))
      : Math.abs(centerTick - remembered.midTick);

  // Rebalance thresholds:
  //  - drift in ticks >= full half-width (fair-derived target moved past the
  //    band's edge) AND drift in price >= REMINT_THRESHOLD_BPS (guards against
  //    gas-burning churn on low-volatility seeds where tick math wobbles)
  //  - OR position is fully out of range AND moving the band would actually
  //    bracket the pool tick again (so we don't churn while pool is far away)
  const driftBps = computeDriftBpsSinceMint(observation, remembered);
  const driftExceeds =
    driftFromCenter >= Math.max(1, halfWidthTicks) &&
    driftBps >= REMINT_THRESHOLD_BPS;
  const outOfRange = poolTick < livePosition.tickLower || poolTick > livePosition.tickUpper;
  const newBandLower = centerTick - halfWidthTicks;
  const newBandUpper = centerTick + halfWidthTicks;
  const newBandWouldHelp =
    poolTick >= newBandLower &&
    poolTick <= newBandUpper &&
    (centerTick !== midTick(livePosition) || !outOfRange);

  if ((driftExceeds && newBandWouldHelp) || (outOfRange && newBandWouldHelp)) {
    // Bundle remove + collect; the next round will mint anew.
    const actions: Array<Record<string, unknown>> = [
      { type: "removeLiquidity", tokenId: livePosition.tokenId, liquidity: livePosition.liquidity }
    ];
    if (hasCollectableFees(livePosition)) {
      actions.push({ type: "collectFees", tokenId: livePosition.tokenId });
    }
    // Clear local state; positions[] will reflect removal next round.
    managed = null;
    return {
      type: "bundle",
      maxPriorityFeePerGasWei: priorityFee,
      actions
    };
  }

  if (hasCollectableFees(livePosition)) {
    return {
      type: "collectFees",
      tokenId: livePosition.tokenId,
      maxPriorityFeePerGasWei: priorityFee
    };
  }

  return { type: "noop", reason: "fair-MM range still centered" };
}

// Clamp the band center so `[center - halfWidth, center + halfWidth]` includes
// poolTick. The center is always aligned to the spacing grid (so the mint
// transaction passes validation).
function clampCenterToBracketPoolTick(
  fairCenter: number,
  poolTick: number,
  halfWidthTicks: number,
  spacing: number
): number {
  const minCenter = poolTick - halfWidthTicks;
  const maxCenter = poolTick + halfWidthTicks;
  const clamped = Math.max(minCenter, Math.min(maxCenter, fairCenter));
  return alignTick(clamped, spacing);
}

function tryMint(
  observation: Observation,
  centerTick: number,
  halfWidthTicks: number,
  priorityFee: string
) {
  if (observation.positions.length >= observation.limits.maxOpenPositions) {
    return { type: "noop", reason: "max open LP positions reached" };
  }

  const tickLower = centerTick - halfWidthTicks;
  const tickUpper = centerTick + halfWidthTicks;
  if (tickLower >= tickUpper) {
    return { type: "noop", reason: "computed tick range invalid" };
  }

  // Compute desired amounts using fair price for the WETH/USDC split.
  // Target ratio: half value in WETH, half in USDC, where value uses fairPrice.
  const wethBudget = capBudget(
    BigInt(observation.balances.wethWei),
    BigInt(observation.limits.maxLpWethWei)
  );
  const usdcBudget = capBudget(
    BigInt(observation.balances.usdcUnits),
    BigInt(observation.limits.maxLpUsdcUnits)
  );

  if (wethBudget < MIN_WETH_MINT_WEI || usdcBudget < MIN_USDC_MINT_UNITS) {
    return { type: "noop", reason: "insufficient LP budget" };
  }

  // The pool itself will pick the actual ratio at mint time based on current
  // tick vs [tickLower, tickUpper]. We just need to provide both sides large
  // enough. Use full budget on both sides — the unused side is returned.
  const amountWethDesired = wethBudget;
  const amountUsdcDesired = usdcBudget;

  managed = {
    tokenId: "pending",
    tickLower,
    tickUpper,
    midTick: centerTick,
    fairAtMint: observation.fairPriceUsdcPerWeth
  };

  return {
    type: "mintLiquidity",
    tickLower,
    tickUpper,
    amountWethDesired: amountWethDesired.toString(),
    amountUsdcDesired: amountUsdcDesired.toString(),
    maxPriorityFeePerGasWei: priorityFee,
    slippageBps: Math.max(50, observation.limits.defaultSlippageBps)
  };
}

function pickLivePosition(observation: Observation, remembered: ManagedRange | null): ObservationPosition | null {
  const live = observation.positions.filter((p) => BigInt(p.liquidity) > 0n);
  if (live.length === 0) {
    // We may still hold a zero-liquidity position object with uncollected fees.
    if (remembered) {
      const stale = observation.positions.find((p) => p.tokenId === remembered.tokenId);
      if (stale && hasCollectableFees(stale)) return stale;
    }
    return null;
  }
  if (remembered) {
    const match = live.find((p) => p.tokenId === remembered.tokenId);
    if (match) {
      // Sync managed state in case we restarted: backfill midTick.
      managed = {
        tokenId: match.tokenId,
        tickLower: match.tickLower,
        tickUpper: match.tickUpper,
        midTick: midTick(match),
        fairAtMint: remembered.fairAtMint
      };
      return match;
    }
  }
  // Adopt the most-recent live position (largest tokenId numerically).
  const adopted = live.reduce((best, p) => (BigInt(p.tokenId) > BigInt(best.tokenId) ? p : best));
  managed = {
    tokenId: adopted.tokenId,
    tickLower: adopted.tickLower,
    tickUpper: adopted.tickUpper,
    midTick: midTick(adopted),
    fairAtMint: observation.fairPriceUsdcPerWeth
  };
  return adopted;
}

function computeFairTickFromPool(observation: Observation): number | null {
  const pool = observation.pool.priceUsdcPerWeth;
  const fair = observation.fairPriceUsdcPerWeth;
  if (!Number.isFinite(pool) || pool <= 0 || !Number.isFinite(fair) || fair <= 0) return null;
  const delta = Math.log(fair / pool) / LOG_BASE;
  return observation.pool.tick + delta;
}

function computeDriftBpsSinceMint(observation: Observation, remembered: ManagedRange | null): number {
  if (!remembered || !Number.isFinite(remembered.fairAtMint) || remembered.fairAtMint <= 0) return 0;
  const ratio = observation.fairPriceUsdcPerWeth / remembered.fairAtMint;
  const driftBps = Math.abs(ratio - 1) * 10_000;
  return driftBps;
}

function hasCollectableFees(p: Pick<ObservationPosition, "tokensOwedWethWei" | "tokensOwedUsdcUnits">): boolean {
  return BigInt(p.tokensOwedWethWei) > 0n || BigInt(p.tokensOwedUsdcUnits) > 0n;
}

function midTick(p: ObservationPosition): number {
  return Math.floor((p.tickLower + p.tickUpper) / 2);
}

function alignTick(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

function capBudget(balance: bigint, limit: bigint): bigint {
  const capped = balance < limit ? balance : limit;
  return (capped * BigInt(MINT_BUDGET_BPS)) / 10_000n;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

// `tickToPrice` is re-exported indirectly via the helper module; we import it
// to ensure the helper compiles into the dependency graph and stays callable
// from tests / future agents.
void tickToPrice;
