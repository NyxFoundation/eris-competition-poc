import { createInterface } from "node:readline";

type PositionObservation = {
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
  pool: {
    priceUsdcPerWeth: number;
    tick: number;
    tickSpacing: number;
    fee: number;
    pair: string;
  };
  fairPriceUsdcPerWeth: number;
  positions: PositionObservation[];
  balances: {
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
    maxBundleActions: number;
    maxLpWethWei: string;
    maxLpUsdcUnits: string;
    maxOpenPositions: number;
  };
};

type BundleAction =
  | {
      type: "mintLiquidity";
      tickLower: number;
      tickUpper: number;
      amountWethDesired: string;
      amountUsdcDesired: string;
      slippageBps?: number;
    }
  | { type: "removeLiquidity"; tokenId: string; liquidity: string }
  | { type: "collectFees"; tokenId: string };

type AgentAction =
  | { type: "noop"; reason?: string }
  | (BundleAction & { maxPriorityFeePerGasWei?: string })
  | {
      type: "bundle";
      actions: BundleAction[];
      maxPriorityFeePerGasWei?: string;
    };

type ManagedPosition = { tickLower: number; tickUpper: number; weight: number };

const LADDER_STEPS = clampInt(intEnv("LADDER_STEPS", 3), 1, 9);
// Weight allocation: concentrate the inner step heavily so the at-price
// capital approaches the single-range LP baseline; outer steps are thin
// inventory-management reserves that capture flow during larger drift.
const LADDER_INNER_WEIGHT = floatEnv("LADDER_INNER_WEIGHT", 0.8);
const LADDER_OUTER_WEIGHT = floatEnv("LADDER_OUTER_WEIGHT", 0.2);
// Step width: each step covers ±(width/2) ticks. tickSpacing=10 for the 5-bps
// WETH/USDC pool, so multiplier=120 → each step spans 1200 ticks (~±6%), the
// same width as the single-range LP baseline (`lp-provider`'s
// RANGE_WIDTH_MULTIPLIER=60 = half-width 600 ticks = total width 1200 ticks).
// Matching the baseline width neutralises the concentration-IL premium so the
// ladder's inventory-skew advantage can show up in PnL.
//
// Previously 20 (~±1% per step) drained ladder slots within <128 rounds, since
// drained NFTs permanently consume a `maxOpenPositions` slot (no burn action).
const LADDER_STEP_WIDTH_MULTIPLIER = intEnv(
  "LADDER_STEP_WIDTH_MULTIPLIER",
  120,
);
const LADDER_REBALANCE_GAP_BPS = intEnv("LADDER_REBALANCE_GAP_BPS", 80);
const LADDER_REBALANCE_SKEW = floatEnv("LADDER_REBALANCE_SKEW", 0.3);
// Total fraction of available balance to deploy across the ladder. The single-
// range LP baseline uses 3500 (35%); we use 5000 (50%) because ladder splits
// across multiple positions, so each position individually receives less. With
// inner=0.8 and budget=0.5 the inner position holds ~40% of capped balance,
// slightly above the single-range baseline.
const LADDER_MINT_BUDGET_BPS = intEnv("LADDER_MINT_BUDGET_BPS", 5000);
const LADDER_SKEW_TILT = floatEnv("LADDER_SKEW_TILT", 0.5);
const MIN_WETH_MINT_WEI = 5_000_000_000_000_000n; // 0.005 WETH
const MIN_USDC_MINT_UNITS = 10_000_000n; // 10 USDC

const managed = new Map<string, ManagedPosition>();

// 観測はネスト形 (protocols.uniswap.{pool,positions})。本戦略はトップレベル
// pool/positions を前提にしたフラット形を使うため、パース後に正規化する。
type RawObservation = Observation & {
  protocols?: {
    uniswap?: { pool?: Observation["pool"]; positions?: PositionObservation[] };
  };
};

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  try {
    const raw = JSON.parse(line) as RawObservation;
    const uni = raw.protocols?.uniswap;
    if (!uni?.pool) {
      process.stdout.write(
        `${JSON.stringify({ type: "noop", reason: "uniswap unavailable" })}\n`,
      );
      return;
    }
    const observation: Observation = {
      ...raw,
      pool: uni.pool,
      positions: uni.positions ?? [],
    };
    const action = decide(observation);
    process.stdout.write(`${JSON.stringify(action)}\n`);
  } catch (err) {
    process.stderr.write(`[ladder-mm] error: ${(err as Error).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: "parse error" })}\n`,
    );
  }
});

function decide(obs: Observation): AgentAction {
  syncManaged(obs);

  const priorityFee = obs.limits.defaultPriorityFeePerGasWei;
  const maxBundle = obs.limits.maxBundleActions;
  const maxOpen = obs.limits.maxOpenPositions;

  const fairTick = fairTickFromPool(
    obs.pool.tick,
    obs.pool.priceUsdcPerWeth,
    obs.fairPriceUsdcPerWeth,
    obs.pool.tickSpacing,
  );
  const gapBps =
    Math.abs(obs.fairPriceUsdcPerWeth / obs.pool.priceUsdcPerWeth - 1) * 10_000;
  const skew = inventorySkew(obs);

  const targets = buildTargetLadder(fairTick, skew, obs.pool.tickSpacing);

  // Determine which existing positions are stale. We allow generous tolerance
  // when matching positions to target ranges: a position that overlaps a target
  // by >=70% of the target's tick span counts as a match. This stops trivial
  // fair-price wobble from churning the entire ladder.
  const ownedPositions = obs.positions.filter((p) => BigInt(p.liquidity) > 0n);
  const matchTolerance = 0.7;

  const stale: PositionObservation[] = [];
  const matchedTargetIdx = new Set<number>();
  for (const pos of ownedPositions) {
    let matched = false;
    for (let i = 0; i < targets.length; i++) {
      if (matchedTargetIdx.has(i)) continue;
      const t = targets[i];
      const overlap = Math.max(
        0,
        Math.min(pos.tickUpper, t.tickUpper) -
          Math.max(pos.tickLower, t.tickLower),
      );
      const span = t.tickUpper - t.tickLower;
      if (span > 0 && overlap / span >= matchTolerance) {
        matchedTargetIdx.add(i);
        matched = true;
        break;
      }
    }
    if (!matched) stale.push(pos);
  }

  // Compute drift between the existing ladder centroid and the new fair tick.
  // Rebalance only when the centroid is well outside the inner step — otherwise
  // we'd churn every round and burn through `maxOpenPositions` (drained NFTs
  // are never burned in this sim, they just accumulate).
  const stepWidthTicks = obs.pool.tickSpacing * LADDER_STEP_WIDTH_MULTIPLIER;
  const ladderCenter = ownedPositions.length
    ? Math.round(
        ownedPositions.reduce(
          (s, p) => s + (p.tickLower + p.tickUpper) / 2,
          0,
        ) / ownedPositions.length,
      )
    : fairTick;
  const driftTicks = Math.abs(fairTick - ladderCenter);
  const driftTriggered =
    ownedPositions.length > 0 && driftTicks > stepWidthTicks * 1.5;

  const gapTriggered = gapBps > LADDER_REBALANCE_GAP_BPS;
  const skewTriggered = Math.abs(skew) > LADDER_REBALANCE_SKEW;

  // Soft brake: if we're within `steps + 2` NFT slots of maxOpenPositions,
  // stop initiating new tear-downs (since every rebalance burns through `steps`
  // more NFTs). This guarantees we never hit the hard validator limit.
  const nftBudget = maxOpen - obs.positions.length;
  const rebalanceAllowed = nftBudget >= LADDER_STEPS;

  const rebalanceTriggered =
    rebalanceAllowed &&
    ownedPositions.length > 0 &&
    (driftTriggered ||
      (gapTriggered && stale.length > 0) ||
      (skewTriggered && stale.length > 0));

  // When a rebalance fires we tear down the whole ladder so the next mint cycle
  // can construct a fresh, properly weighted one. Otherwise we only purge
  // positions that are strictly stale (don't match any current target).
  const positionsToRemove = rebalanceTriggered ? ownedPositions.slice() : stale;

  // 1. Tear down stale positions first (free up position slots).
  if (positionsToRemove.length > 0) {
    const actions: BundleAction[] = [];
    for (const pos of positionsToRemove) {
      // remove + collect = 2 slots. Stop before exceeding maxBundle.
      if (actions.length + 2 > maxBundle) break;
      actions.push({
        type: "removeLiquidity",
        tokenId: pos.tokenId,
        liquidity: pos.liquidity,
      });
      actions.push({ type: "collectFees", tokenId: pos.tokenId });
      managed.delete(pos.tokenId);
    }
    if (actions.length === 1) {
      const only = actions[0];
      return { ...only, maxPriorityFeePerGasWei: priorityFee };
    }
    if (actions.length >= 2) {
      return { type: "bundle", actions, maxPriorityFeePerGasWei: priorityFee };
    }
    // If we couldn't fit any remove+collect pair (maxBundle < 2), fall through to other behaviour.
  }

  // 2. Collect fees on still-managed in-range positions before potentially minting more.
  const collectable = ownedPositions.find(
    (p) => !positionsToRemove.includes(p) && hasCollectableFees(p),
  );
  // Targets that don't already have a sufficiently-overlapping live position.
  // Use the same tolerance as the staleness check so we don't double-mint when
  // an existing position drifted slightly out of exact tick alignment.
  const remainingTargets = targets.filter(
    (t) =>
      !ownedPositions.some((p) => {
        if (positionsToRemove.includes(p)) return false;
        const overlap = Math.max(
          0,
          Math.min(p.tickUpper, t.tickUpper) -
            Math.max(p.tickLower, t.tickLower),
        );
        const span = t.tickUpper - t.tickLower;
        return span > 0 && overlap / span >= matchTolerance;
      }),
  );

  // 3. Mint missing target steps.
  // CAREFUL: obs.positions includes drained NFTs (liquidity=0). Burning isn't
  // exposed as an action, so every rebalance burns through real NFT slots. We
  // count drained NFTs against `maxOpenPositions` because the validator does.
  const slotsLeft = maxOpen - obs.positions.length;
  const mintsToEmit = remainingTargets.slice(
    0,
    Math.max(0, Math.min(slotsLeft, maxBundle)),
  );

  if (mintsToEmit.length > 0) {
    const totalWeightToMint = mintsToEmit.reduce((sum, t) => sum + t.weight, 0);
    if (totalWeightToMint <= 0) {
      return collectable
        ? collectAction(collectable.tokenId, priorityFee)
        : { type: "noop", reason: "no positive ladder weight" };
    }

    const wethBudget = budgetAmount(
      BigInt(obs.balances.wethWei),
      BigInt(obs.limits.maxLpWethWei),
    );
    const usdcBudget = budgetAmount(
      BigInt(obs.balances.usdcUnits),
      BigInt(obs.limits.maxLpUsdcUnits),
    );

    // If total budget is too tiny across the ladder, skip minting.
    if (wethBudget < MIN_WETH_MINT_WEI && usdcBudget < MIN_USDC_MINT_UNITS) {
      return collectable
        ? collectAction(collectable.tokenId, priorityFee)
        : { type: "noop", reason: "insufficient LP budget for ladder" };
    }

    const actions: BundleAction[] = [];
    for (const t of mintsToEmit) {
      const share = t.weight / totalWeightToMint;
      const wethShare =
        (wethBudget * BigInt(Math.floor(share * 10_000))) / 10_000n;
      const usdcShare =
        (usdcBudget * BigInt(Math.floor(share * 10_000))) / 10_000n;
      // Skip ranges that would mint trivially small amounts.
      if (wethShare < MIN_WETH_MINT_WEI && usdcShare < MIN_USDC_MINT_UNITS)
        continue;
      actions.push({
        type: "mintLiquidity",
        tickLower: t.tickLower,
        tickUpper: t.tickUpper,
        amountWethDesired: wethShare.toString(),
        amountUsdcDesired: usdcShare.toString(),
        slippageBps: 100,
      });
      managed.set(`pending:${t.tickLower}:${t.tickUpper}`, {
        tickLower: t.tickLower,
        tickUpper: t.tickUpper,
        weight: t.weight,
      });
    }
    if (actions.length === 1) {
      return { ...actions[0], maxPriorityFeePerGasWei: priorityFee };
    }
    if (actions.length >= 2) {
      return { type: "bundle", actions, maxPriorityFeePerGasWei: priorityFee };
    }
  }

  if (collectable) {
    return collectAction(collectable.tokenId, priorityFee);
  }

  return { type: "noop", reason: "ladder in place" };
}

function syncManaged(obs: Observation): void {
  const onChainIds = new Set(obs.positions.map((p) => p.tokenId));
  // Drop entries we tracked for tokenIds that no longer exist.
  for (const key of Array.from(managed.keys())) {
    if (key.startsWith("pending:")) {
      managed.delete(key);
      continue;
    }
    if (!onChainIds.has(key)) managed.delete(key);
  }
  // Pick up tokenIds that appeared this round (likely minted last round).
  for (const pos of obs.positions) {
    if (BigInt(pos.liquidity) === 0n) continue;
    if (!managed.has(pos.tokenId)) {
      managed.set(pos.tokenId, {
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        weight: 1,
      });
    }
  }
}

function buildTargetLadder(
  fairTick: number,
  skew: number,
  tickSpacing: number,
): Array<{ tickLower: number; tickUpper: number; weight: number }> {
  // Ensure stepWidth is a multiple of tickSpacing and even so half-widths align.
  let stepWidth = tickSpacing * LADDER_STEP_WIDTH_MULTIPLIER;
  if (stepWidth % (tickSpacing * 2) !== 0) {
    stepWidth = tickSpacing * (LADDER_STEP_WIDTH_MULTIPLIER + 1);
  }
  const halfWidth = stepWidth / 2; // multiple of tickSpacing by construction.

  const steps = LADDER_STEPS;
  // Index range: for STEPS=3 we use [-1, 0, 1]; for STEPS=5 use [-2..2]; for
  // STEPS=4 use [-2, -1, 1, 2] (skip 0).
  const half = Math.floor(steps / 2);
  const indices: number[] = [];
  for (let i = -half; i <= half; i++) {
    if (steps % 2 === 0 && i === 0) continue;
    indices.push(i);
  }

  const innerCount = steps % 2 === 1 ? 1 : 2;
  const outerCount = steps - innerCount;
  const innerWeightEach =
    outerCount === 0 ? 1 : LADDER_INNER_WEIGHT / innerCount;
  const outerWeightEach =
    outerCount === 0 ? 0 : LADDER_OUTER_WEIGHT / outerCount;

  const out: Array<{ tickLower: number; tickUpper: number; weight: number }> =
    [];
  for (const i of indices) {
    const isInner = steps % 2 === 1 ? i === 0 : Math.abs(i) === 1;
    let weight = isInner ? innerWeightEach : outerWeightEach;

    // Skew adjustment: positive skew (WETH-heavy) => bias OUTER steps to the
    // ask side (i > 0) so flow sweeps WETH out and brings USDC in. Keep inner
    // symmetric to preserve a tight spot quote.
    if (!isInner && Math.abs(skew) > 0) {
      const direction = Math.sign(i); // +1 above fair, -1 below fair
      const tilt = clamp(skew * LADDER_SKEW_TILT, -0.9, 0.9);
      weight = Math.max(0, weight * (1 + direction * tilt));
    }

    const stepCenter = alignTick(fairTick + i * stepWidth, tickSpacing);
    const lo = stepCenter - halfWidth;
    const up = stepCenter + halfWidth;
    if (up <= lo) continue;
    out.push({ tickLower: lo, tickUpper: up, weight });
  }
  // Normalize weights to sum to 1 (skew tilt may have changed the total).
  const total = out.reduce((s, t) => s + t.weight, 0);
  if (total > 0) for (const t of out) t.weight = t.weight / total;
  return out;
}

function inventorySkew(obs: Observation): number {
  const wethValue = obs.inventory.weth * obs.fairPriceUsdcPerWeth;
  const usdc = obs.inventory.usdc;
  const sum = wethValue + usdc;
  if (sum <= 0) return 0;
  return (wethValue - usdc) / sum;
}

function collectAction(tokenId: string, priorityFee: string): AgentAction {
  return { type: "collectFees", tokenId, maxPriorityFeePerGasWei: priorityFee };
}

function hasCollectableFees(p: PositionObservation): boolean {
  return BigInt(p.tokensOwedWethWei) > 0n || BigInt(p.tokensOwedUsdcUnits) > 0n;
}

function budgetAmount(balance: bigint, limit: bigint): bigint {
  const capped = balance < limit ? balance : limit;
  return (capped * BigInt(LADDER_MINT_BUDGET_BPS)) / 10_000n;
}

// Derive the fair tick by anchoring on the pool's reported tick and shifting by
// the log-price ratio. We use `pool.tick` as the calibration anchor so we don't
// need to hard-code a tick-zero offset.
//
// For the WETH/USDC 0.05% pool token0=USDC, token1=WETH. v3 ticks encode
// token1/token0, so higher tick == higher WETH/USDC == lower USDC/WETH (the
// human price the observation reports). Hence:
//   fairTick - poolTick = log(poolPrice / fairPrice) / log(1.0001)
// where prices are USDC/WETH (human units).
//
// After PR-A (#10) merges, swap this for `priceToTick` in `examples/lib/tick-math.ts`
// (see follow-up issue).
function fairTickFromPool(
  poolTick: number,
  poolPrice: number,
  fairPrice: number,
  tickSpacing: number,
): number {
  if (
    !Number.isFinite(fairPrice) ||
    fairPrice <= 0 ||
    !Number.isFinite(poolPrice) ||
    poolPrice <= 0
  ) {
    return alignTick(poolTick, tickSpacing);
  }
  const offset = Math.log(poolPrice / fairPrice) / Math.log(1.0001);
  const rawFairTick = poolTick + Math.round(offset);
  return alignTick(rawFairTick, tickSpacing);
}

function alignTick(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
