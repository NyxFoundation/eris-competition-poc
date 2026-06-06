// JIT-style LP at round boundary (Issue #5).
//
// Pseudo-JIT without mempool visibility: predict per-round volatility from the
// pool-price history embedded in each observation. When the most-recent realized
// vol exceeds a high quantile of the recent vol distribution, mint a very narrow
// concentrated-liquidity range centered on the current tick. Next round, remove
// + collect that position and re-evaluate.
//
// Env (all optional):
//   JIT_VOL_WINDOW       (default 16)   history points per vol estimate
//   JIT_VOL_QUANTILE     (default 0.7)  fire only if current vol > this quantile
//   JIT_RANGE_TICKS      (default 2)    half-width in tick-spacing units
//   JIT_MINT_BUDGET_BPS  (default 4500) fraction of LP budget (bps of 10000)
//   JIT_MIN_HISTORY      (default JIT_VOL_WINDOW * 2) burn-in before any mint
//
// Cross-round state:
//   * lastMintedTokenId: the tokenId we minted on the previous round, used to
//     drive a remove+collect bundle at the top of the current round.
//   * pendingMintRange: the (tickLower, tickUpper) we just submitted; on the
//     following observation we reconcile that against `positions` to learn the
//     runtime-assigned tokenId.

import { createInterface } from "node:readline";
import { realizedVariance, quantile, type HistoryPoint } from "../lib/flow-stats.js";

type PositionObs = {
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  tokensOwedWethWei: string;
  tokensOwedUsdcUnits: string;
};

type Observation = {
  round: number;
  pool: {
    priceUsdcPerWeth: number;
    tick: number;
    tickSpacing: number;
  };
  fairPriceUsdcPerWeth: number;
  positions: PositionObs[];
  balances: { wethWei: string; usdcUnits: string };
  history: HistoryPoint[];
  limits: {
    defaultPriorityFeePerGasWei: string;
    maxLpWethWei: string;
    maxLpUsdcUnits: string;
    maxOpenPositions: number;
    maxBundleActions: number;
  };
};

// NOTE: the coordinator caps observation `history` at 20 points (see
// src/coordinator.ts). Defaults below assume that cap: VOL_WINDOW=6 lets us
// collect ~7 historical vol samples via the rolling step in
// collectHistoricalVols, while MIN_HISTORY=12 ensures we have enough burn-in
// to build a stable quantile threshold before firing.
//
// The runtime exposes maxOpenPositions=10 AND does not expose a burn action,
// so every fired JIT round leaves a stale NFT counted against the cap. A very
// high quantile (0.9) makes us conserve our 10 mint budget across the run and
// only fire on the strongest vol signal, which is also what the no-firing-in-
// low-vol-rounds completion criterion requires. Wider tick range (4 spacings)
// earns fees in a wider band so a single mint is meaningful when we do fire.
const VOL_WINDOW = positiveInt(process.env.JIT_VOL_WINDOW, 6);
const VOL_QUANTILE = clampUnit(parseFloatEnv(process.env.JIT_VOL_QUANTILE, 0.9));
const RANGE_TICKS = positiveInt(process.env.JIT_RANGE_TICKS, 4);
const MINT_BUDGET_BPS = positiveInt(process.env.JIT_MINT_BUDGET_BPS, 4500);
const MIN_HISTORY = positiveInt(process.env.JIT_MIN_HISTORY, 12);

const MIN_WETH_MINT_WEI = 1_000_000_000_000_000n; // 0.001 WETH floor (narrow range = small)
const MIN_USDC_MINT_UNITS = 2_500_000n; // 2.5 USDC floor

let lastMintedTokenId: string | null = null;
let pendingMintRange: { tickLower: number; tickUpper: number } | null = null;

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let observation: Observation;
  try {
    observation = JSON.parse(line) as Observation;
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ type: "noop", reason: `parse-error: ${(err as Error).message}` })}\n`);
    return;
  }
  reconcilePendingMint(observation);
  const action = decideAction(observation);
  process.stdout.write(`${JSON.stringify(action)}\n`);
});

function reconcilePendingMint(observation: Observation): void {
  if (!pendingMintRange || lastMintedTokenId !== null) return;
  // Reuse the same tick range across mints means previously closed positions
  // (liquidity=0) can still match the range. Pick the live one (liquidity > 0),
  // and among ties prefer the highest tokenId (most recently minted).
  const candidates = observation.positions
    .filter(
      (p) =>
        p.tickLower === pendingMintRange!.tickLower &&
        p.tickUpper === pendingMintRange!.tickUpper &&
        BigInt(p.liquidity) > 0n
    )
    .sort((a, b) => {
      const da = BigInt(a.tokenId);
      const db = BigInt(b.tokenId);
      if (da === db) return 0;
      return da < db ? 1 : -1;
    });
  if (candidates.length > 0) {
    lastMintedTokenId = candidates[0].tokenId;
    pendingMintRange = null;
  }
}

function decideAction(observation: Observation) {
  const priorityFee = observation.limits.defaultPriorityFeePerGasWei;

  // 1. Close out previous JIT mint if it is still open.
  const stalePosition = lastMintedTokenId
    ? observation.positions.find((p) => p.tokenId === lastMintedTokenId)
    : undefined;
  if (lastMintedTokenId && !stalePosition) {
    // Position no longer exists — runtime / external action cleared it.
    lastMintedTokenId = null;
  }
  if (stalePosition) {
    const closingTokenId = lastMintedTokenId as string;
    // Clear state optimistically; if the bundle reverts the next observation
    // will still surface the open position and we will retry the close.
    lastMintedTokenId = null;
    const actions: Array<Record<string, unknown>> = [];
    if (BigInt(stalePosition.liquidity) > 0n) {
      actions.push({
        type: "removeLiquidity",
        tokenId: closingTokenId,
        liquidity: stalePosition.liquidity
      });
    }
    actions.push({ type: "collectFees", tokenId: closingTokenId });
    if (actions.length === 1) return { ...actions[0], maxPriorityFeePerGasWei: priorityFee };
    if (actions.length > observation.limits.maxBundleActions) {
      return { type: "noop", reason: "close bundle exceeds maxBundleActions" };
    }
    return { type: "bundle", maxPriorityFeePerGasWei: priorityFee, actions };
  }

  // 2. Burn-in: need enough history for both the current-window variance and
  //    the historical distribution of vols we compare it to.
  const history = observation.history ?? [];
  if (history.length < MIN_HISTORY) {
    return { type: "noop", reason: "burn-in" };
  }

  // 3. Evaluate current vs historical vol.
  const currentVol = realizedVariance(history, VOL_WINDOW);
  const historicalVols = collectHistoricalVols(history, VOL_WINDOW);
  if (historicalVols.length < 4) {
    return { type: "noop", reason: "insufficient vol samples" };
  }
  const threshold = quantile(historicalVols, VOL_QUANTILE);
  if (!(currentVol > threshold) || currentVol <= 0) {
    return { type: "noop", reason: "low-vol round" };
  }

  // 4. Respect open position cap. The runtime counts ALL positions including
  //    liquidity=0 NFTs that Uniswap V3 leaves behind after removeLiquidity
  //    (no burn action is exposed). Stop firing once we get within one of the
  //    cap so we don't end up with stranded liquidity we can't unwind.
  if (observation.positions.length >= observation.limits.maxOpenPositions) {
    return { type: "noop", reason: "max open positions" };
  }

  // 5. Size proportional to vol relative to the max historical vol observed.
  //    Floor at 25% of budget so a triggered mint is meaningful.
  const maxVol = Math.max(...historicalVols, currentVol);
  const ratio = maxVol > 0 ? Math.min(1, currentVol / maxVol) : 1;
  const sizeFraction = Math.max(0.25, ratio);
  const budgetBps = BigInt(Math.round(MINT_BUDGET_BPS * sizeFraction));

  const balanceWeth = BigInt(observation.balances.wethWei);
  const balanceUsdc = BigInt(observation.balances.usdcUnits);
  const limitWeth = BigInt(observation.limits.maxLpWethWei);
  const limitUsdc = BigInt(observation.limits.maxLpUsdcUnits);
  const amountWethDesired = budgetAmount(balanceWeth, limitWeth, budgetBps);
  const amountUsdcDesired = budgetAmount(balanceUsdc, limitUsdc, budgetBps);
  if (amountWethDesired < MIN_WETH_MINT_WEI || amountUsdcDesired < MIN_USDC_MINT_UNITS) {
    return { type: "noop", reason: "insufficient LP budget" };
  }

  const spacing = observation.pool.tickSpacing;
  const center = alignTick(observation.pool.tick, spacing);
  const halfWidth = spacing * RANGE_TICKS;
  const tickLower = center - halfWidth;
  const tickUpper = center + halfWidth;
  if (tickLower >= tickUpper) {
    return { type: "noop", reason: "degenerate tick range" };
  }

  // Remember the range so we can identify the tokenId on the next observation.
  pendingMintRange = { tickLower, tickUpper };

  return {
    type: "mintLiquidity",
    tickLower,
    tickUpper,
    amountWethDesired: amountWethDesired.toString(),
    amountUsdcDesired: amountUsdcDesired.toString(),
    maxPriorityFeePerGasWei: priorityFee,
    slippageBps: 100
  };
}

function collectHistoricalVols(history: HistoryPoint[], window: number): number[] {
  // Roll a window of size `window` across the history excluding the most recent
  // window (the "current" estimate). Step by max(1, window/2) so samples are
  // roughly independent.
  const out: number[] = [];
  if (history.length < window + 1) return out;
  const step = Math.max(1, Math.floor(window / 2));
  for (let end = history.length - 1 - step; end >= window; end -= step) {
    const sub = history.slice(end - window, end);
    const v = realizedVariance(sub, window);
    if (v > 0) out.push(v);
  }
  return out;
}

function budgetAmount(balance: bigint, limit: bigint, bps: bigint): bigint {
  const capped = balance < limit ? balance : limit;
  return (capped * bps) / 10_000n;
}

function alignTick(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseFloatEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function clampUnit(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
