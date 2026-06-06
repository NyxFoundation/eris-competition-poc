// Tick math helpers for Uniswap v3-style concentrated liquidity ranges.
// Uses the standard formula: tick = log(price) / log(1.0001), aligned to tickSpacing
// via Math.floor (so the returned tick is the largest multiple of tickSpacing
// that is <= the raw tick, which mirrors the spacing convention used by the pool).
//
// `price` here is the pool price in token1-per-token0 terms. For our pool that
// is USDC-per-WETH, after normalizing the 12-decimal gap between WETH (18) and
// USDC (6). Observations already expose `pool.priceUsdcPerWeth` in that
// human-readable form, so callers can pass it directly.

const LOG_BASE = Math.log(1.0001);

export function priceToTick(price: number, tickSpacing: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("priceToTick: price must be a positive finite number");
  }
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error("priceToTick: tickSpacing must be a positive integer");
  }
  const rawTick = Math.log(price) / LOG_BASE;
  return Math.floor(rawTick / tickSpacing) * tickSpacing;
}

export function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}
