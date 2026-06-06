// ベース戦略ライブラリ（シード付き自己改善エージェントの土台, ADR 0001 A-5 / P3 系）。
//
// 既存のルール戦略(arb-bot / lp-provider)を claude-llm の executor 形式
// ((obs, params, helpers) => AgentAction の本体文字列)に移植したもの。
// claudeAgent は ERIS_BASE_STRATEGY=<id> のとき、これを v1 として **決定論的にシード**する
// (LLM init をスキップ → 最初から即戦力・再現可能)。以降の revise が同じ executor 形式で
// この v1 を磨いていく。offline ゲート(P3)で勝った版をここへ書き戻して恒久化する。
import type { Strategy } from "./strategy.js";

// arb: Uniswap pool↔fair の gap を取りに行く swap。利益比例で priority fee を入札。
// (examples/agents/arb-bot.ts の逐語移植。obs だけで完結する純粋判断)
const ARB_EXECUTOR = `
const uni = obs.protocols && obs.protocols.uniswap;
if (!uni || !uni.pool) return { type: "noop", reason: "uniswap disabled" };
const pool = uni.pool.priceUsdcPerWeth;
const fair = obs.fairPriceUsdcPerWeth;
if (!(pool > 0) || !(fair > 0)) return { type: "noop", reason: "invalid prices" };
const gap = fair / pool - 1;
if (Math.abs(gap) < params.gapThreshold) return { type: "noop", reason: "gap too small" };
const tokenIn = gap > 0 ? "USDC" : "WETH";
const maxLimit = BigInt(tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits);
const balance = BigInt(tokenIn === "WETH" ? obs.balances.wethWei : obs.balances.usdcUnits);
const cap = balance < maxLimit ? balance : maxLimit;
const sizeBps = Math.min(params.maxSizeBps, Math.max(params.minSizeBps, Math.floor(Math.abs(gap) * params.sizeGain)));
const amountIn = (cap * BigInt(sizeBps)) / 10000n;
if (amountIn <= 0n) return { type: "noop", reason: "computed size zero" };
const sizeUsdc = tokenIn === "USDC" ? Number(amountIn) / 1e6 : (Number(amountIn) / 1e18) * fair;
const profitUsdc = sizeUsdc * Math.abs(gap);
const profitWei = Math.floor((profitUsdc / fair) * 1e9) * 1e9;
const bidPerGas = Math.floor((profitWei * params.bidProfitFraction) / 180000);
const minBid = BigInt(obs.limits.defaultPriorityFeePerGasWei);
const maxBid = BigInt(obs.limits.maxPriorityFeePerGasWei);
let bid = BigInt(bidPerGas > 0 ? bidPerGas : 0);
if (bid < minBid) bid = minBid;
if (bid > maxBid) bid = maxBid;
helpers.log("gap=" + (gap * 10000).toFixed(1) + "bps size=" + sizeBps + " bid=" + bid.toString());
return { type: "swap", tokenIn: tokenIn, amountIn: amountIn.toString(), maxPriorityFeePerGasWei: bid.toString(), slippageBps: params.slippageBps };
`.trim();

// lp: 現在 tick の周りに集中流動性を供給する素朴な v1。既にポジションがあれば hold。
// (シードなので簡素。LP の高度化は revise / offline ゲートに委ねる)
const LP_EXECUTOR = `
const uni = obs.protocols && obs.protocols.uniswap;
if (!uni || !uni.pool) return { type: "noop", reason: "uniswap disabled" };
if (uni.positions && uni.positions.length > 0) return { type: "noop", reason: "holding LP position" };
const spacing = uni.pool.tickSpacing;
const center = Math.round(uni.pool.tick / spacing) * spacing;
const width = Math.max(1, params.widthSpacings) * spacing;
const tickLower = center - width;
const tickUpper = center + width;
const wethWei = BigInt(obs.balances.wethWei);
const usdcUnits = BigInt(obs.balances.usdcUnits);
const maxLpWeth = BigInt(obs.limits.maxLpWethWei);
const maxLpUsdc = BigInt(obs.limits.maxLpUsdcUnits);
const fracNum = BigInt(Math.max(0, Math.floor(params.depositFraction * 10000)));
const wethDesired = ((wethWei < maxLpWeth ? wethWei : maxLpWeth) * fracNum) / 10000n;
const usdcDesired = ((usdcUnits < maxLpUsdc ? usdcUnits : maxLpUsdc) * fracNum) / 10000n;
if (wethDesired <= 0n && usdcDesired <= 0n) return { type: "noop", reason: "no inventory to LP" };
helpers.log("mint range [" + tickLower + "," + tickUpper + "]");
return { type: "mintLiquidity", tickLower: tickLower, tickUpper: tickUpper, amountWethDesired: wethDesired.toString(), amountUsdcDesired: usdcDesired.toString(), slippageBps: params.slippageBps };
`.trim();

// venue: 有効な AMM venue (uniswap/balancer/curve) のうち fair から最も乖離した
// プールで価格を fair に寄せる cross-venue 裁定。状態を持たず obs だけで判断。
// (examples/agents/venue-arb.ts の移植)
const VENUE_EXECUTOR = `
const p = obs.protocols || {};
const fair = obs.fairPriceUsdcPerWeth;
if (!(fair > 0)) return { type: "noop", reason: "invalid fair" };
const venues = [];
if (p.uniswap && p.uniswap.pool) venues.push({ swapType: "swap", price: p.uniswap.pool.priceUsdcPerWeth });
if (p.balancer) venues.push({ swapType: "balancerSwap", price: p.balancer.priceUsdcPerWeth });
if (p.curve) venues.push({ swapType: "curveSwap", price: p.curve.priceUsdcPerWeth });
let best = null; let bestGap = 0;
for (const v of venues) {
  if (!(v.price > 0)) continue;
  const gap = Math.abs(fair / v.price - 1);
  if (gap > bestGap) { bestGap = gap; best = v; }
}
if (!best || bestGap < params.gapThreshold) return { type: "noop", reason: "no venue gap" };
const tokenIn = best.price < fair ? "USDC" : "WETH";
const max = BigInt(tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits);
const sizeBps = Math.min(params.maxSizeBps, Math.max(params.minSizeBps, Math.floor(bestGap * params.sizeGain)));
const amountIn = (max * BigInt(sizeBps)) / 10000n;
if (amountIn <= 0n) return { type: "noop", reason: "computed size zero" };
helpers.log("venue=" + best.swapType + " gap=" + (bestGap * 10000).toFixed(1) + "bps size=" + sizeBps);
return { type: best.swapType, tokenIn: tokenIn, amountIn: amountIn.toString(), maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei, slippageBps: params.slippageBps };
`.trim();

// aave: WETH を担保供給 → USDC を借入する段階的レバレッジ。状態は obs.protocols.aave
// (supplied/borrowed)から毎ラウンド判定するので持たない。(examples/agents/aave-leverage.ts の移植)
const AAVE_EXECUTOR = `
const aave = obs.protocols && obs.protocols.aave;
if (!aave) return { type: "noop", reason: "aave disabled" };
const suppliedWeth = BigInt((aave.supplied && aave.supplied.WETH) || "0");
const borrowedUsdc = BigInt((aave.borrowed && aave.borrowed.USDC) || "0");
const wethWei = BigInt(obs.balances.wethWei);
const fee = obs.limits.defaultPriorityFeePerGasWei;
if (suppliedWeth === 0n && wethWei > 0n) {
  const maxSupply = BigInt(obs.limits.maxAaveSupplyWethWei);
  const half = wethWei / 2n;
  const base = half < maxSupply ? half : maxSupply;
  const frac = BigInt(Math.max(0, Math.min(10000, Math.floor(params.supplyFraction * 10000))));
  const amount = (base * frac) / 10000n;
  if (amount > 0n) return { type: "aaveSupply", asset: "WETH", amount: amount.toString(), maxPriorityFeePerGasWei: fee };
}
if (suppliedWeth > 0n && borrowedUsdc === 0n) {
  const maxBorrow = BigInt(obs.limits.maxAaveBorrowUsdcUnits);
  const want = BigInt(Math.max(0, Math.floor(params.borrowUsdc))) * 1000000n;
  const amount = want < maxBorrow ? want : maxBorrow;
  if (amount > 0n) return { type: "aaveBorrow", asset: "USDC", amount: amount.toString(), maxPriorityFeePerGasWei: fee };
}
return { type: "noop", reason: "position established" };
`.trim();

// statarb: gap の z-score(obs.history の直近窓から平均/分散を再計算 → 状態を持たない近似)で
// 閾値超のとき過小評価側へ z 比例サイズで swap。(examples/agents/stat-arb.ts の窓版移植)
const STATARB_EXECUTOR = `
const uni = obs.protocols && obs.protocols.uniswap;
if (!uni || !uni.pool) return { type: "noop", reason: "uniswap disabled" };
const pool = uni.pool.priceUsdcPerWeth;
const fair = obs.fairPriceUsdcPerWeth;
if (!(pool > 0) || !(fair > 0)) return { type: "noop", reason: "invalid prices" };
const hist = obs.history || [];
const gaps = [];
for (let i = 0; i < hist.length; i++) {
  const h = hist[i];
  if (h && h.poolPriceUsdcPerWeth > 0 && h.fairPriceUsdcPerWeth > 0) gaps.push(h.fairPriceUsdcPerWeth / h.poolPriceUsdcPerWeth - 1);
}
if (gaps.length < params.minSamples) return { type: "noop", reason: "burn-in (" + gaps.length + ")" };
let mean = 0; for (let i = 0; i < gaps.length; i++) mean += gaps[i]; mean /= gaps.length;
let vs = 0; for (let i = 0; i < gaps.length; i++) { const d = gaps[i] - mean; vs += d * d; }
const std = Math.sqrt(vs / Math.max(1, gaps.length - 1));
if (!(std > 0)) return { type: "noop", reason: "no variance" };
const gap = fair / pool - 1;
const z = (gap - mean) / std;
const absZ = Math.abs(z);
if (absZ < params.zEnter) return { type: "noop", reason: "|z|=" + absZ.toFixed(2) + " < enter" };
const tokenIn = gap > 0 ? "USDC" : "WETH";
const max = BigInt(tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits);
const span = Math.max(0.0001, params.zAggressive - params.zEnter);
const t = Math.max(0, Math.min(1, (absZ - params.zEnter) / span));
const sizeBps = Math.floor(params.minSizeBps + (params.maxSizeBps - params.minSizeBps) * t);
const amountIn = (max * BigInt(sizeBps)) / 10000n;
if (amountIn <= 0n) return { type: "noop", reason: "computed size zero" };
helpers.log("z=" + z.toFixed(2) + " size=" + sizeBps);
return { type: "swap", tokenIn: tokenIn, amountIn: amountIn.toString(), maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei, slippageBps: params.slippageBps };
`.trim();

// id → ベース戦略(version を除いた雛形)。
const BASE_STRATEGIES: Record<string, Omit<Strategy, "version">> = {
  arb: {
    notes:
      "Base strategy **arb**: Uniswap pool↔fair の gap が閾値超なら過小評価側へ gap 比例サイズで swap。期待利益の一部を priority fee に入札。revise で gapThreshold / sizeGain / bidProfitFraction を磨く。",
    params: {
      gapThreshold: 0.0005,
      minSizeBps: 250,
      maxSizeBps: 5000,
      sizeGain: 200000,
      bidProfitFraction: 0.3,
      slippageBps: 75,
    },
    executorTs: ARB_EXECUTOR,
  },
  lp: {
    notes:
      "Base strategy **lp**: ポジションが無ければ現在 tick の周りに集中流動性を供給(±widthSpacings)。あれば hold。revise でレンジ幅 / 預入率 / リバランス条件を磨く。",
    params: {
      widthSpacings: 10,
      depositFraction: 0.5,
      slippageBps: 100,
    },
    executorTs: LP_EXECUTOR,
  },
  venue: {
    notes:
      "Base strategy **venue**: uniswap/balancer/curve のうち fair から最も乖離した venue で価格を fair に寄せる cross-venue 裁定。revise で gapThreshold / sizeGain を磨く。",
    params: {
      gapThreshold: 0.001,
      minSizeBps: 250,
      maxSizeBps: 2500,
      sizeGain: 200000,
      slippageBps: 75,
    },
    executorTs: VENUE_EXECUTOR,
  },
  aave: {
    notes:
      "Base strategy **aave**: WETH を担保供給 → USDC を借入する段階的レバレッジ。revise で supplyFraction / borrowUsdc やヘッジ運用を磨く。aave protocol 有効時のみ機能。",
    params: {
      supplyFraction: 1.0,
      borrowUsdc: 1000,
    },
    executorTs: AAVE_EXECUTOR,
  },
  statarb: {
    notes:
      "Base strategy **statarb**: gap の z-score(obs.history 窓から再計算)が zEnter 超で過小評価側へ z 比例サイズで swap。revise で zEnter / zAggressive / サイズを磨く。",
    params: {
      minSamples: 12,
      zEnter: 1.5,
      zAggressive: 2.5,
      minSizeBps: 500,
      maxSizeBps: 5000,
      slippageBps: 75,
    },
    executorTs: STATARB_EXECUTOR,
  },
};

export const BASE_STRATEGY_IDS = Object.keys(BASE_STRATEGIES);

// ベース戦略を v1 として取得。未知 id / undefined は null(= 通常の LLM init にフォールバック)。
export function getBaseStrategy(id: string | undefined): Strategy | null {
  if (!id) return null;
  const base = BASE_STRATEGIES[id];
  if (!base) return null;
  return {
    version: 1,
    notes: base.notes,
    params: { ...base.params },
    executorTs: base.executorTs,
  };
}
