// ベース戦略ライブラリ（シード付き自己改善エージェントの土台, ADR 0001 A-5 / P3 系）。
//
// 既存のルール戦略(arb-bot / lp-provider)を claude-llm の executor 形式
// ((obs, params, helpers) => AgentAction の本体文字列)に移植したもの。
// claudeAgent は ERIS_BASE_STRATEGY=<id> のとき、これを v1 として **決定論的にシード**する
// (LLM init をスキップ → 最初から即戦力・再現可能)。以降の revise が同じ executor 形式で
// この v1 を磨いていく。offline ゲート(P3)で勝った版をここへ書き戻して恒久化する。
import type { Strategy } from "./strategy.js";

// arb: uniswap/balancer/curve の各 venue で pool↔fair の gap を見て、最も乖離した venue を fair へ
// 寄せる swap。利益比例で priority fee を入札。3 venue 対応(最大乖離 venue を選ぶ)。
// (examples/agents/arb-bot.ts の発展。obs だけで完結する純粋判断)
const ARB_EXECUTOR = `
const p = obs.protocols || {};
const fair = obs.fairPriceUsdcPerWeth;
if (!(fair > 0)) return { type: "noop", reason: "invalid fair" };
const venues = [];
if (p.uniswap && p.uniswap.pool && p.uniswap.pool.priceUsdcPerWeth > 0) venues.push({ swapType: "swap", price: p.uniswap.pool.priceUsdcPerWeth });
if (p.balancer && p.balancer.priceUsdcPerWeth > 0) venues.push({ swapType: "balancerSwap", price: p.balancer.priceUsdcPerWeth });
if (p.curve && p.curve.priceUsdcPerWeth > 0) venues.push({ swapType: "curveSwap", price: p.curve.priceUsdcPerWeth });
if (venues.length === 0) return { type: "noop", reason: "no venue" };
let best = null; let bestGap = 0;
for (let i = 0; i < venues.length; i++) { const g = fair / venues[i].price - 1; if (Math.abs(g) > Math.abs(bestGap)) { bestGap = g; best = venues[i]; } }
if (!best || Math.abs(bestGap) < params.gapThreshold) return { type: "noop", reason: "gap too small" };
const tokenIn = bestGap > 0 ? "USDC" : "WETH";
const maxLimit = BigInt(tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits);
const balance = BigInt(tokenIn === "WETH" ? obs.balances.wethWei : obs.balances.usdcUnits);
const cap = balance < maxLimit ? balance : maxLimit;
const sizeBps = Math.min(params.maxSizeBps, Math.max(params.minSizeBps, Math.floor(Math.abs(bestGap) * params.sizeGain)));
const amountIn = (cap * BigInt(sizeBps)) / 10000n;
if (amountIn <= 0n) return { type: "noop", reason: "computed size zero" };
const sizeUsdc = tokenIn === "USDC" ? Number(amountIn) / 1e6 : (Number(amountIn) / 1e18) * fair;
const profitUsdc = sizeUsdc * Math.abs(bestGap);
const profitWei = Math.floor((profitUsdc / fair) * 1e9) * 1e9;
const bidPerGas = Math.floor((profitWei * params.bidProfitFraction) / 180000);
const minBid = BigInt(obs.limits.defaultPriorityFeePerGasWei);
const maxBid = BigInt(obs.limits.maxPriorityFeePerGasWei);
let bid = BigInt(bidPerGas > 0 ? bidPerGas : 0);
if (bid < minBid) bid = minBid;
if (bid > maxBid) bid = maxBid;
helpers.log("venue=" + best.swapType + " gap=" + (bestGap * 10000).toFixed(1) + "bps size=" + sizeBps + " bid=" + bid.toString());
return { type: best.swapType, tokenIn: tokenIn, amountIn: amountIn.toString(), maxPriorityFeePerGasWei: bid.toString(), slippageBps: params.slippageBps };
`.trim();

// adaptivearb: arb と同じ最大乖離 venue swap だが、入札を「競争シグナル(ADR 0011)で勝てる最小限を
// 機会価値の範囲で」決める。obs.competition の競合最高入札を僅かに上回るだけ積み(margin)、ただし
// profit×ceilFraction/gas の機会価値上限で頭打ちにする(過剰入札を罰せられない)。front-run が多い
// (recentRevertRate 高)なら margin を上げて確実に前へ。revise で margin / ceilFraction を磨く。
// (examples/agents/adaptive-arb.ts の executor 移植。経済ガス土俵で arb の固定割合入札を上回る狙い)
const ADAPTIVE_ARB_EXECUTOR = `
const p = obs.protocols || {};
const fair = obs.fairPriceUsdcPerWeth;
if (!(fair > 0)) return { type: "noop", reason: "invalid fair" };
const venues = [];
if (p.uniswap && p.uniswap.pool && p.uniswap.pool.priceUsdcPerWeth > 0) venues.push({ swapType: "swap", price: p.uniswap.pool.priceUsdcPerWeth });
if (p.balancer && p.balancer.priceUsdcPerWeth > 0) venues.push({ swapType: "balancerSwap", price: p.balancer.priceUsdcPerWeth });
if (p.curve && p.curve.priceUsdcPerWeth > 0) venues.push({ swapType: "curveSwap", price: p.curve.priceUsdcPerWeth });
if (venues.length === 0) return { type: "noop", reason: "no venue" };
let best = null; let bestGap = 0;
for (let i = 0; i < venues.length; i++) { const g = fair / venues[i].price - 1; if (Math.abs(g) > Math.abs(bestGap)) { bestGap = g; best = venues[i]; } }
if (!best || Math.abs(bestGap) < params.gapThreshold) return { type: "noop", reason: "gap too small" };
const tokenIn = bestGap > 0 ? "USDC" : "WETH";
const maxLimit = BigInt(tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits);
const balance = BigInt(tokenIn === "WETH" ? obs.balances.wethWei : obs.balances.usdcUnits);
const cap = balance < maxLimit ? balance : maxLimit;
const sizeBps = Math.min(params.maxSizeBps, Math.max(params.minSizeBps, Math.floor(Math.abs(bestGap) * params.sizeGain)));
const amountIn = (cap * BigInt(sizeBps)) / 10000n;
if (amountIn <= 0n) return { type: "noop", reason: "computed size zero" };
const ONE_GWEI = 1000000000n;
// 機会価値(per gas)の上限 = profit × ceilFraction / gas。これを超えて積むと net を削る。
const sizeUsdc = tokenIn === "USDC" ? Number(amountIn) / 1e6 : (Number(amountIn) / 1e18) * fair;
const profitUsdc = sizeUsdc * Math.abs(bestGap);
const profitWei = BigInt(Math.max(0, Math.floor((profitUsdc / fair) * 1e9))) * ONE_GWEI;
const ceilNum = BigInt(Math.max(0, Math.floor(params.ceilFraction * 10000)));
const gasUnits = BigInt(Math.max(1, Math.floor(params.gasUnitsEstimate)));
const ceilingPerGas = (profitWei * ceilNum) / 10000n / gasUnits;
// 競争シグナル: 競合の最高入札を margin% だけ上回る(勝てる最小限)。front-run 多発なら margin↑。
const comp = obs.competition;
const competitorMax = BigInt((comp && comp.maxCompetitorPriorityFeeWei) || "0");
const revertRate = (comp && comp.recentRevertRate) || 0;
const marginPct = BigInt(Math.floor(revertRate > params.frontrunRevertThreshold ? params.marginPctFrontrun : params.marginPctNormal));
let margin = (competitorMax * marginPct) / 100n;
if (margin < ONE_GWEI) margin = ONE_GWEI;
let bid = competitorMax + margin;
if (bid > ceilingPerGas) bid = ceilingPerGas;
const minBid = BigInt(obs.limits.defaultPriorityFeePerGasWei);
const maxBid = BigInt(obs.limits.maxPriorityFeePerGasWei);
if (bid < minBid) bid = minBid;
if (bid > maxBid) bid = maxBid;
helpers.log("venue=" + best.swapType + " gap=" + (bestGap * 10000).toFixed(1) + "bps size=" + sizeBps + " bid=" + bid.toString() + " comp=" + competitorMax.toString());
return { type: best.swapType, tokenIn: tokenIn, amountIn: amountIn.toString(), maxPriorityFeePerGasWei: bid.toString(), slippageBps: params.slippageBps };
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

// statarb: uniswap gap の z-score(obs.history の直近窓から平均/分散を再計算 → 状態を持たない近似)で
// 「動いている regime か」を判定し、超えたら**3 venue のうち最大乖離 venue**を fair へ寄せる z 比例
// サイズの swap。history は uniswap pool 価格のみなのでボラ推定は uniswap、執行は最大乖離 venue。
// (examples/agents/stat-arb.ts の窓版を 3 venue 化)
const STATARB_EXECUTOR = `
const p = obs.protocols || {};
const uni = p.uniswap;
const fair = obs.fairPriceUsdcPerWeth;
if (!uni || !uni.pool || !(uni.pool.priceUsdcPerWeth > 0) || !(fair > 0)) return { type: "noop", reason: "invalid prices" };
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
const venues = [{ swapType: "swap", price: uni.pool.priceUsdcPerWeth }];
if (p.balancer && p.balancer.priceUsdcPerWeth > 0) venues.push({ swapType: "balancerSwap", price: p.balancer.priceUsdcPerWeth });
if (p.curve && p.curve.priceUsdcPerWeth > 0) venues.push({ swapType: "curveSwap", price: p.curve.priceUsdcPerWeth });
let best = venues[0]; let bestGap = fair / venues[0].price - 1;
for (let i = 1; i < venues.length; i++) { const g = fair / venues[i].price - 1; if (Math.abs(g) > Math.abs(bestGap)) { bestGap = g; best = venues[i]; } }
const z = (bestGap - mean) / std;
const absZ = Math.abs(z);
if (absZ < params.zEnter) return { type: "noop", reason: "|z|=" + absZ.toFixed(2) + " < enter" };
const tokenIn = bestGap > 0 ? "USDC" : "WETH";
const max = BigInt(tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits);
const span = Math.max(0.0001, params.zAggressive - params.zEnter);
const t = Math.max(0, Math.min(1, (absZ - params.zEnter) / span));
const sizeBps = Math.floor(params.minSizeBps + (params.maxSizeBps - params.minSizeBps) * t);
const amountIn = (max * BigInt(sizeBps)) / 10000n;
if (amountIn <= 0n) return { type: "noop", reason: "computed size zero" };
helpers.log("venue=" + best.swapType + " z=" + z.toFixed(2) + " size=" + sizeBps);
return { type: best.swapType, tokenIn: tokenIn, amountIn: amountIn.toString(), maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei, slippageBps: params.slippageBps };
`.trim();

// cvbal: uniswap/balancer/curve の最安 venue で買い・最高 venue で売る delta-neutral ペア裁定。
// 両建てを 1 bundle で。状態を持たず obs の venue 価格だけで判断。3 venue 対応(最大スプレッドのペアを選ぶ)。
// (examples/agents/cv-bal-arb.ts を 3 venue 化)
const CVBAL_EXECUTOR = `
const p = obs.protocols || {};
const fee = obs.limits.defaultPriorityFeePerGasWei;
const venues = [];
if (p.uniswap && p.uniswap.pool && p.uniswap.pool.priceUsdcPerWeth > 0) venues.push({ swapType: "swap", price: p.uniswap.pool.priceUsdcPerWeth });
if (p.balancer && p.balancer.priceUsdcPerWeth > 0) venues.push({ swapType: "balancerSwap", price: p.balancer.priceUsdcPerWeth });
if (p.curve && p.curve.priceUsdcPerWeth > 0) venues.push({ swapType: "curveSwap", price: p.curve.priceUsdcPerWeth });
if (venues.length < 2) return { type: "noop", reason: "need >=2 venues" };
let lo = venues[0]; let hi = venues[0];
for (let i = 0; i < venues.length; i++) { if (venues[i].price < lo.price) lo = venues[i]; if (venues[i].price > hi.price) hi = venues[i]; }
const spread = hi.price / lo.price - 1;
if (spread < params.spreadBps / 10000 || lo.swapType === hi.swapType) return { type: "noop", reason: "spread too small" };
const sizeBps = Math.min(params.maxSizeBps, Math.max(params.minSizeBps, Math.floor(spread * params.sizeGain)));
const usdcIn = (BigInt(obs.limits.maxUsdcInUnits) * BigInt(sizeBps)) / 10000n;
const wethIn = (BigInt(obs.limits.maxWethInWei) * BigInt(sizeBps)) / 10000n;
if (usdcIn <= 0n || wethIn <= 0n) return { type: "noop", reason: "computed size zero" };
helpers.log("spread=" + (spread * 10000).toFixed(1) + "bps buy=" + lo.swapType + " sell=" + hi.swapType);
return { type: "bundle", actions: [ { type: lo.swapType, tokenIn: "USDC", amountIn: usdcIn.toString(), slippageBps: params.slippageBps }, { type: hi.swapType, tokenIn: "WETH", amountIn: wethIn.toString(), slippageBps: params.slippageBps } ], maxPriorityFeePerGasWei: fee };
`.trim();

// dnlp: Uniswap V3 LP を mint し、その WETH エクスポージャを GMX short でヘッジするデルタニュートラル。
// ラウンドをまたぐ状態は obs.protocols.uniswap.positions / obs.protocols.gmx.position から毎ラウンド
// 判定する(A:LP無→mint, B:LP有/short無→hedge, C:両方→hold)。(examples/agents/dn-lp.ts の移植)
const DNLP_EXECUTOR = `
const uni = obs.protocols && obs.protocols.uniswap;
const gmx = obs.protocols && obs.protocols.gmx;
const fee = obs.limits.defaultPriorityFeePerGasWei;
if (!uni || !uni.pool) return { type: "noop", reason: "uniswap disabled" };
const positions = uni.positions || [];
if (positions.length === 0) {
  const spacing = uni.pool.tickSpacing;
  const center = Math.floor(uni.pool.tick / spacing) * spacing;
  const w = Math.max(1, Math.floor(params.rangeSpacings)) * spacing;
  return { type: "mintLiquidity", tickLower: center - w, tickUpper: center + w, amountWethDesired: (BigInt(obs.limits.maxLpWethWei) / 2n).toString(), amountUsdcDesired: (BigInt(obs.limits.maxLpUsdcUnits) / 2n).toString(), maxPriorityFeePerGasWei: fee, slippageBps: 100 };
}
if (!gmx) return { type: "noop", reason: "lp held (gmx disabled, no hedge)" };
if (!gmx.position) {
  let totalWethWei = 0n;
  for (let i = 0; i < positions.length; i++) totalWethWei += BigInt(positions[i].amountWethWei || "0");
  const wethEth = Number(totalWethWei) / 1e18;
  const mkt = gmx.marketPriceUsd;
  if (!(wethEth > 0) || !(mkt > 0)) return { type: "noop", reason: "no exposure to hedge" };
  const notionalUsd = wethEth * mkt * params.hedgeFraction;
  const sizeRaw = BigInt(Math.max(0, Math.round(notionalUsd))) * (10n ** 30n);
  const maxSize = BigInt(obs.limits.maxGmxSizeUsd);
  const sizeUsd = sizeRaw < maxSize ? sizeRaw : maxSize;
  const collRaw = BigInt(Math.max(0, Math.round((notionalUsd / 2) * 1e6)));
  const maxColl = BigInt(obs.limits.maxUsdcInUnits);
  const collateral = collRaw < maxColl ? collRaw : maxColl;
  if (sizeUsd <= 0n) return { type: "noop", reason: "hedge size zero" };
  helpers.log("hedge short notional=" + Math.round(notionalUsd) + "usd");
  return { type: "gmxIncrease", isLong: false, collateral: "USDC", collateralAmount: collateral.toString(), sizeDeltaUsd: sizeUsd.toString(), maxPriorityFeePerGasWei: fee };
}
return { type: "noop", reason: "delta-neutral established" };
`.trim();

// gmxperp: ポジションが無ければ ETH long を open、あれば hold。(examples/agents/gmx-perp.ts の移植)
const GMXPERP_EXECUTOR = `
const gmx = obs.protocols && obs.protocols.gmx;
const fee = obs.limits.defaultPriorityFeePerGasWei;
if (!gmx) return { type: "noop", reason: "gmx disabled" };
if (gmx.position) return { type: "noop", reason: "position open" };
const collWei = BigInt(Math.max(0, Math.round(params.collateralWeth * 1000))) * (10n ** 15n);
const sizeRaw = BigInt(Math.max(0, Math.round(params.sizeUsd))) * (10n ** 30n);
const maxSize = BigInt(obs.limits.maxGmxSizeUsd);
const sizeUsd = sizeRaw < maxSize ? sizeRaw : maxSize;
if (collWei <= 0n || sizeUsd <= 0n) return { type: "noop", reason: "computed size zero" };
return { type: "gmxIncrease", isLong: params.isLong !== false, collateral: "WETH", collateralAmount: collWei.toString(), sizeDeltaUsd: sizeUsd.toString(), maxPriorityFeePerGasWei: fee };
`.trim();

// gmxrev: history の MA からの乖離で逆張り。割高→short / 割安→long を open、MA 近傍復帰 or
// 含み損 stop でクローズ。(examples/agents/gmx-reversion.ts の移植)
const GMXREV_EXECUTOR = `
const gmx = obs.protocols && obs.protocols.gmx;
const fee = obs.limits.defaultPriorityFeePerGasWei;
if (!gmx) return { type: "noop", reason: "gmx disabled" };
const h = obs.history || [];
const hist = [];
for (let i = 0; i < h.length; i++) { const p = h[i] && h[i].fairPriceUsdcPerWeth; if (p > 0) hist.push(p); }
const look = Math.max(2, Math.floor(params.maLookback));
if (hist.length < look) return { type: "noop", reason: "warming up" };
const win = hist.slice(-look);
let ma = 0; for (let i = 0; i < win.length; i++) ma += win[i]; ma /= win.length;
const price = obs.fairPriceUsdcPerWeth;
if (!(price > 0) || !(ma > 0)) return { type: "noop", reason: "invalid prices" };
const dev = price / ma - 1;
const pos = gmx.position;
if (pos) {
  const pnl = Number(pos.pnlUsd || 0);
  const reverted = Math.abs(dev) < params.exitBps / 10000;
  const stopped = pnl < -params.stopUsd;
  if (reverted || stopped) return { type: "gmxDecrease", isLong: pos.isLong, collateral: pos.collateral, collateralDeltaAmount: pos.collateralAmount, sizeDeltaUsd: pos.sizeUsd, maxPriorityFeePerGasWei: fee };
  return { type: "noop", reason: "hold (awaiting reversion)" };
}
if (Math.abs(dev) < params.entryBps / 10000) return { type: "noop", reason: "near MA" };
const mkt = gmx.marketPriceUsd;
if (!(mkt > 0)) return { type: "noop", reason: "invalid gmx price" };
const sizeRaw = BigInt(Math.max(0, Math.round(mkt * params.leverage))) * (10n ** 30n);
const maxSize = BigInt(obs.limits.maxGmxSizeUsd);
const sizeUsd = sizeRaw < maxSize ? sizeRaw : maxSize;
const collWei = BigInt(Math.max(0, Math.round(params.collateralWeth * 1000))) * (10n ** 15n);
if (sizeUsd <= 0n) return { type: "noop", reason: "computed size zero" };
helpers.log("dev=" + (dev * 10000).toFixed(1) + "bps long=" + (dev < 0));
return { type: "gmxIncrease", isLong: dev < 0, collateral: "WETH", collateralAmount: collWei.toString(), sizeDeltaUsd: sizeUsd.toString(), maxPriorityFeePerGasWei: fee };
`.trim();

// gmxtrend: history の傾き(前半/後半平均の変化率)で順張り。トレンド方向に open、反転で close。
// (examples/agents/gmx-trend.ts の移植)
const GMXTREND_EXECUTOR = `
const gmx = obs.protocols && obs.protocols.gmx;
const fee = obs.limits.defaultPriorityFeePerGasWei;
if (!gmx) return { type: "noop", reason: "gmx disabled" };
const h = obs.history || [];
const hist = [];
for (let i = 0; i < h.length; i++) { const p = h[i] && h[i].fairPriceUsdcPerWeth; if (p > 0) hist.push(p); }
const look = Math.max(4, Math.floor(params.lookback));
if (hist.length < look) return { type: "noop", reason: "warming up" };
const win = hist.slice(-look);
const half = Math.floor(look / 2);
let oa = 0; for (let i = 0; i < half; i++) oa += win[i]; oa /= Math.max(1, half);
let ra = 0; for (let i = half; i < win.length; i++) ra += win[i]; ra /= Math.max(1, win.length - half);
if (!(oa > 0)) return { type: "noop", reason: "invalid window" };
const trend = ra / oa - 1;
const upTrend = trend > 0;
const pos = gmx.position;
if (pos) {
  const reversed = pos.isLong !== upTrend;
  if (reversed && Math.abs(trend) > params.trendBps / 10000) return { type: "gmxDecrease", isLong: pos.isLong, collateral: pos.collateral, collateralDeltaAmount: pos.collateralAmount, sizeDeltaUsd: pos.sizeUsd, maxPriorityFeePerGasWei: fee };
  return { type: "noop", reason: "hold (trend intact)" };
}
if (Math.abs(trend) < params.trendBps / 10000) return { type: "noop", reason: "no trend" };
const mkt = gmx.marketPriceUsd;
if (!(mkt > 0)) return { type: "noop", reason: "invalid gmx price" };
const sizeRaw = BigInt(Math.max(0, Math.round(mkt * params.leverage))) * (10n ** 30n);
const maxSize = BigInt(obs.limits.maxGmxSizeUsd);
const sizeUsd = sizeRaw < maxSize ? sizeRaw : maxSize;
const collWei = BigInt(Math.max(0, Math.round(params.collateralWeth * 1000))) * (10n ** 15n);
if (sizeUsd <= 0n) return { type: "noop", reason: "computed size zero" };
helpers.log("trend=" + (trend * 10000).toFixed(1) + "bps up=" + upTrend);
return { type: "gmxIncrease", isLong: upTrend, collateral: "WETH", collateralAmount: collWei.toString(), sizeDeltaUsd: sizeUsd.toString(), maxPriorityFeePerGasWei: fee };
`.trim();

// fairmm: pool tick ではなく fairPrice の含意 tick を中心に集中流動性を供給する MM。
// 状態は obs.positions(liquidity>0 があれば hold)から判定。offset は ln(fair/pool)/ln(1.0001)。
// (examples/agents/fair-mm.ts の簡約シード。レンジ再調整等の高度化は revise に委ねる)
const FAIRMM_EXECUTOR = `
const uni = obs.protocols && obs.protocols.uniswap;
if (!uni || !uni.pool) return { type: "noop", reason: "uniswap disabled" };
const fee = obs.limits.defaultPriorityFeePerGasWei;
const positions = uni.positions || [];
let live = 0; for (let i = 0; i < positions.length; i++) if (BigInt(positions[i].liquidity) > 0n) live++;
if (live > 0) return { type: "noop", reason: "holding fair-anchored LP" };
const pool = uni.pool.priceUsdcPerWeth;
const fair = obs.fairPriceUsdcPerWeth;
if (!(pool > 0) || !(fair > 0)) return { type: "noop", reason: "invalid prices" };
const spacing = uni.pool.tickSpacing;
const offset = Math.round(Math.log(fair / pool) / Math.log(1.0001));
const center = Math.round((uni.pool.tick + offset) / spacing) * spacing;
const w = Math.max(1, Math.floor(params.rangeSpacings)) * spacing;
const frac = BigInt(Math.max(0, Math.min(10000, Math.floor(params.depositFraction * 10000))));
const wethWei = BigInt(obs.balances.wethWei); const usdcUnits = BigInt(obs.balances.usdcUnits);
const maxW = BigInt(obs.limits.maxLpWethWei); const maxU = BigInt(obs.limits.maxLpUsdcUnits);
const wethDesired = ((wethWei < maxW ? wethWei : maxW) * frac) / 10000n;
const usdcDesired = ((usdcUnits < maxU ? usdcUnits : maxU) * frac) / 10000n;
if (wethDesired <= 0n && usdcDesired <= 0n) return { type: "noop", reason: "no inventory to LP" };
helpers.log("fair-anchored mint center=" + center + " offset=" + offset);
return { type: "mintLiquidity", tickLower: center - w, tickUpper: center + w, amountWethDesired: wethDesired.toString(), amountUsdcDesired: usdcDesired.toString(), maxPriorityFeePerGasWei: fee, slippageBps: params.slippageBps };
`.trim();

// jitlp: history の直近リターンの実現ボラが閾値超のときだけ集中レンジを mint する Just-In-Time LP。
// (examples/agents/jit-lp.ts の簡約シード。窓ボラ stddev で発火判定。分位ベースの高度化は revise)
const JITLP_EXECUTOR = `
const uni = obs.protocols && obs.protocols.uniswap;
if (!uni || !uni.pool) return { type: "noop", reason: "uniswap disabled" };
const fee = obs.limits.defaultPriorityFeePerGasWei;
const positions = uni.positions || [];
let live = 0; for (let i = 0; i < positions.length; i++) if (BigInt(positions[i].liquidity) > 0n) live++;
if (live > 0) return { type: "noop", reason: "holding JIT LP" };
const h = obs.history || [];
const rets = [];
for (let i = 1; i < h.length; i++) { const a = h[i-1] && h[i-1].fairPriceUsdcPerWeth; const b = h[i] && h[i].fairPriceUsdcPerWeth; if (a > 0 && b > 0) rets.push(b / a - 1); }
if (rets.length < params.minHistory) return { type: "noop", reason: "insufficient vol samples" };
let m = 0; for (let i = 0; i < rets.length; i++) m += rets[i]; m /= rets.length;
let v = 0; for (let i = 0; i < rets.length; i++) { const d = rets[i] - m; v += d * d; }
const vol = Math.sqrt(v / Math.max(1, rets.length - 1));
if (vol < params.volThreshold) return { type: "noop", reason: "low-vol round" };
const spacing = uni.pool.tickSpacing;
const center = Math.round(uni.pool.tick / spacing) * spacing;
const w = Math.max(1, Math.floor(params.rangeTicks)) * spacing;
const frac = BigInt(Math.max(0, Math.min(10000, Math.floor(params.mintBudgetBps))));
const wethWei = BigInt(obs.balances.wethWei); const usdcUnits = BigInt(obs.balances.usdcUnits);
const maxW = BigInt(obs.limits.maxLpWethWei); const maxU = BigInt(obs.limits.maxLpUsdcUnits);
const wethDesired = ((wethWei < maxW ? wethWei : maxW) * frac) / 10000n;
const usdcDesired = ((usdcUnits < maxU ? usdcUnits : maxU) * frac) / 10000n;
if (wethDesired <= 0n && usdcDesired <= 0n) return { type: "noop", reason: "no inventory to LP" };
helpers.log("JIT mint vol=" + (vol * 10000).toFixed(1) + "bps");
return { type: "mintLiquidity", tickLower: center - w, tickUpper: center + w, amountWethDesired: wethDesired.toString(), amountUsdcDesired: usdcDesired.toString(), maxPriorityFeePerGasWei: fee, slippageBps: params.slippageBps };
`.trim();

// ladder: 現在 tick の周りに steps 段の集中レンジを外側へ広げて張るラダー型 MM。1 ラウンド 1 段ずつ
// 構築(owned 数で次段を決定)。(examples/agents/ladder-mm.ts の簡約シード。在庫スキュー等は revise)
const LADDER_EXECUTOR = `
const uni = obs.protocols && obs.protocols.uniswap;
if (!uni || !uni.pool) return { type: "noop", reason: "uniswap disabled" };
const fee = obs.limits.defaultPriorityFeePerGasWei;
const positions = uni.positions || [];
let owned = 0; for (let i = 0; i < positions.length; i++) if (BigInt(positions[i].liquidity) > 0n) owned++;
const steps = Math.max(1, Math.floor(params.steps));
if (owned >= steps) return { type: "noop", reason: "ladder full" };
const maxOpen = obs.limits.maxOpenPositions;
if (positions.length >= maxOpen) return { type: "noop", reason: "no position slots" };
const spacing = uni.pool.tickSpacing;
const center = Math.round(uni.pool.tick / spacing) * spacing;
const halfWidth = Math.max(1, Math.floor(params.stepWidthSpacings)) * spacing;
const step = owned;
const dir = step % 2 === 0 ? 1 : -1;
const segCenter = center + dir * Math.ceil(step / 2) * halfWidth * 2;
const totalFrac = Math.max(0, Math.min(10000, Math.floor(params.mintBudgetBps)));
const perStep = BigInt(Math.floor(totalFrac / steps));
const wethWei = BigInt(obs.balances.wethWei); const usdcUnits = BigInt(obs.balances.usdcUnits);
const maxW = BigInt(obs.limits.maxLpWethWei); const maxU = BigInt(obs.limits.maxLpUsdcUnits);
const wethDesired = ((wethWei < maxW ? wethWei : maxW) * perStep) / 10000n;
const usdcDesired = ((usdcUnits < maxU ? usdcUnits : maxU) * perStep) / 10000n;
if (wethDesired <= 0n && usdcDesired <= 0n) return { type: "noop", reason: "no inventory to LP" };
helpers.log("ladder step " + (step + 1) + "/" + steps + " center=" + segCenter);
return { type: "mintLiquidity", tickLower: segCenter - halfWidth, tickUpper: segCenter + halfWidth, amountWethDesired: wethDesired.toString(), amountUsdcDesired: usdcDesired.toString(), maxPriorityFeePerGasWei: fee, slippageBps: params.slippageBps };
`.trim();

// aaveloop: WETH supply → USDC borrow → USDC を WETH に swap → 再 supply を多段ループする
// leveraged WETH carry(GitHub #6)。状態は obs.protocols.aave の collateral/debt/availableBorrows
// から毎ラウンド再構成し、targetLtv に達するまで 1 段ずつ進める素朴版。(aave-leverage の発展)
const AAVELOOP_EXECUTOR = `
const aave = obs.protocols && obs.protocols.aave;
if (!aave) return { type: "noop", reason: "aave disabled" };
const fee = obs.limits.defaultPriorityFeePerGasWei;
const wethWei = BigInt(obs.balances.wethWei);
const usdcUnits = BigInt(obs.balances.usdcUnits);
const maxIn = BigInt(obs.limits.maxUsdcInUnits);
const coll = Number(aave.totalCollateralBase) / 1e8;
const debt = Number(aave.totalDebtBase) / 1e8;
const avail = Number(aave.availableBorrowsBase) / 1e8;
const underTarget = coll === 0 || debt / coll < params.targetLtv;
// 1) 手元 WETH を supply して担保を積む(初期 WETH + swap で得た WETH。carry の土台)
if (wethWei > 0n && underTarget) {
  const maxSupply = BigInt(obs.limits.maxAaveSupplyWethWei);
  const capped = wethWei < maxSupply ? wethWei : maxSupply;
  const frac = BigInt(Math.max(0, Math.min(10000, Math.floor(params.supplyFraction * 10000))));
  const amt = (capped * frac) / 10000n;
  if (amt > 0n) return { type: "aaveSupply", asset: "WETH", amount: amt.toString(), maxPriorityFeePerGasWei: fee };
}
// 2) 目標 LTV 未満で借入余力があれば USDC borrow
if (underTarget && coll > 0) {
  const borrowUsd = Math.floor(avail * params.borrowFraction);
  if (borrowUsd >= 10) {
    const maxBorrow = BigInt(obs.limits.maxAaveBorrowUsdcUnits);
    const want = BigInt(borrowUsd) * 1000000n;
    const amt = want < maxBorrow ? want : maxBorrow;
    if (amt > 0n) return { type: "aaveBorrow", asset: "USDC", amount: amt.toString(), maxPriorityFeePerGasWei: fee };
  }
}
// 3) 借りた native USDC を WETH へ swap(次段 supply の原資)。maxUsdcInUnits で上限を切り、
//    集約残高(USDC.e/USDT 込み)で native 残高を超えて reject されるのを避ける。
if (underTarget && coll > 0 && usdcUnits > 1000000n) {
  const amountIn = usdcUnits < maxIn ? usdcUnits : maxIn;
  return { type: "swap", tokenIn: "USDC", amountIn: amountIn.toString(), slippageBps: params.slippageBps, maxPriorityFeePerGasWei: fee };
}
return { type: "noop", reason: "target leverage reached" };
`.trim();

// crossvenue: uniswap/balancer/curve のうち最安 venue で買い・最高 venue で売る 2-leg 裁定
// (GitHub #4 の cross-venue 部分)。cvbal(bal↔curve 限定)を 3 venue の最大乖離ペアへ一般化。
// 注: 別 fee-tier / v2 は観測に無いため対象外(uni 0.05% + balancer + curve のみ)。
const CROSSVENUE_EXECUTOR = `
const p = obs.protocols || {};
const fee = obs.limits.defaultPriorityFeePerGasWei;
const venues = [];
if (p.uniswap && p.uniswap.pool && p.uniswap.pool.priceUsdcPerWeth > 0) venues.push({ swapType: "swap", price: p.uniswap.pool.priceUsdcPerWeth });
if (p.balancer && p.balancer.priceUsdcPerWeth > 0) venues.push({ swapType: "balancerSwap", price: p.balancer.priceUsdcPerWeth });
if (p.curve && p.curve.priceUsdcPerWeth > 0) venues.push({ swapType: "curveSwap", price: p.curve.priceUsdcPerWeth });
if (venues.length < 2) return { type: "noop", reason: "need >=2 venues" };
let lo = venues[0]; let hi = venues[0];
for (let i = 0; i < venues.length; i++) { if (venues[i].price < lo.price) lo = venues[i]; if (venues[i].price > hi.price) hi = venues[i]; }
const spread = hi.price / lo.price - 1;
if (spread < params.spreadThreshold || lo.swapType === hi.swapType) return { type: "noop", reason: "spread too small" };
const sizeBps = Math.min(params.maxSizeBps, Math.max(params.minSizeBps, Math.floor(spread * params.sizeGain)));
const usdcIn = (BigInt(obs.limits.maxUsdcInUnits) * BigInt(sizeBps)) / 10000n;
const wethIn = (BigInt(obs.limits.maxWethInWei) * BigInt(sizeBps)) / 10000n;
if (usdcIn <= 0n || wethIn <= 0n) return { type: "noop", reason: "computed size zero" };
helpers.log("crossvenue spread=" + (spread * 10000).toFixed(1) + "bps buy=" + lo.swapType + " sell=" + hi.swapType);
return { type: "bundle", actions: [
  { type: lo.swapType, tokenIn: "USDC", amountIn: usdcIn.toString(), slippageBps: params.slippageBps },
  { type: hi.swapType, tokenIn: "WETH", amountIn: wethIn.toString(), slippageBps: params.slippageBps },
], maxPriorityFeePerGasWei: fee };
`.trim();

// lpyield: fair 含意 tick 中心に LP を mint し、残った遊休 USDC を Aave に supply して手数料+利回りの
// 二段収益を狙う無レバレッジ複合(GitHub #11)。fairmm(LP)+ aave(park)の合成。
const LPYIELD_EXECUTOR = `
const uni = obs.protocols && obs.protocols.uniswap;
if (!uni || !uni.pool) return { type: "noop", reason: "uniswap disabled" };
const aave = obs.protocols && obs.protocols.aave;
const fee = obs.limits.defaultPriorityFeePerGasWei;
const positions = uni.positions || [];
let live = 0; for (let i = 0; i < positions.length; i++) if (BigInt(positions[i].liquidity) > 0n) live++;
if (live === 0) {
  const pool = uni.pool.priceUsdcPerWeth; const fair = obs.fairPriceUsdcPerWeth;
  if (!(pool > 0) || !(fair > 0)) return { type: "noop", reason: "invalid prices" };
  const spacing = uni.pool.tickSpacing;
  const offset = Math.round(Math.log(fair / pool) / Math.log(1.0001));
  const center = Math.round((uni.pool.tick + offset) / spacing) * spacing;
  const w = Math.max(1, Math.floor(params.rangeSpacings)) * spacing;
  const frac = BigInt(Math.max(0, Math.min(10000, Math.floor(params.depositFraction * 10000))));
  const wethWei = BigInt(obs.balances.wethWei); const usdcUnits = BigInt(obs.balances.usdcUnits);
  const maxW = BigInt(obs.limits.maxLpWethWei); const maxU = BigInt(obs.limits.maxLpUsdcUnits);
  const wd = ((wethWei < maxW ? wethWei : maxW) * frac) / 10000n;
  const ud = ((usdcUnits < maxU ? usdcUnits : maxU) * frac) / 10000n;
  if (wd > 0n || ud > 0n) return { type: "mintLiquidity", tickLower: center - w, tickUpper: center + w, amountWethDesired: wd.toString(), amountUsdcDesired: ud.toString(), maxPriorityFeePerGasWei: fee, slippageBps: params.slippageBps };
}
// LP 配分後の遊休 USDC を Aave に park(余剰だけ)。1 回の supply は maxUsdcInUnits で上限を切り、
// 集約残高(USDC.e/USDT 込み)で native USDC 残高を超えて reject されるのを避ける。
if (aave) {
  const usdcUnits = BigInt(obs.balances.usdcUnits);
  const maxIn = BigInt(obs.limits.maxUsdcInUnits);
  const minIdle = BigInt(Math.max(0, Math.floor(params.minIdleUsdc))) * 1000000n;
  if (usdcUnits > minIdle) {
    const excess = usdcUnits - minIdle;
    const amt = excess < maxIn ? excess : maxIn;
    return { type: "aaveSupply", asset: "USDC", amount: amt.toString(), maxPriorityFeePerGasWei: fee };
  }
}
return { type: "noop", reason: "LP + idle parked" };
`.trim();

// flasharb: Aave flashLoanSimple で自己資金上限を超えるサイズの uniswap↔balancer cross-venue 裁定を
// 1 tx で実行する(GitHub #3、資本制約を外すレバレッジ裁定)。割安 venue で買い割高で売り、返済段で利益
// 不足なら atomic revert(gas のみ損)。executor は FlashArb を起動する rawTx を組む。**要 ERIS_FLASH_ARB=1**
// (coordinator が FlashArb をデプロイし claudeAgent が helpers.ADDRESSES.FLASH_ARB を注入。未注入なら noop)。
// (examples/agents/flash-arb.ts + examples/lib/flash.ts の executor 移植。calldata を sandbox 内で構築)
const FLASH_ARB_EXECUTOR = `
const p = obs.protocols || {};
const uni = (p.uniswap && p.uniswap.pool) ? p.uniswap.pool.priceUsdcPerWeth : 0;
const bal = p.balancer ? p.balancer.priceUsdcPerWeth : 0;
if (!(uni > 0) || !(bal > 0)) return { type: "noop", reason: "need uniswap+balancer prices" };
const flashAddr = helpers.ADDRESSES.FLASH_ARB;
if (!flashAddr) return { type: "noop", reason: "FlashArb not deployed (needs ERIS_FLASH_ARB=1)" };
const spread = Math.abs(uni / bal - 1);
if (spread < params.spreadThreshold) return { type: "noop", reason: "spread too small" };
const flashUsdc = Math.max(0, Math.floor(params.flashUsdc));
if (flashUsdc <= 0) return { type: "noop", reason: "flashUsdc zero" };
const mode = uni < bal ? 0 : 1;
const amount = BigInt(flashUsdc) * 1000000n;
const paramsType = [{ type: "tuple", components: [ { name: "mode", type: "uint8" }, { name: "wethMinOut", type: "uint256" }, { name: "usdcMinOut", type: "uint256" }, { name: "profitTo", type: "address" } ] }];
const encoded = helpers.encodeAbiParameters(paramsType, [{ mode: mode, wethMinOut: 0n, usdcMinOut: 0n, profitTo: obs.agentAddress }]);
const flashAbi = [{ type: "function", name: "flashLoanSimple", stateMutability: "nonpayable", inputs: [ { name: "receiverAddress", type: "address" }, { name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "params", type: "bytes" }, { name: "referralCode", type: "uint16" } ], outputs: [] }];
const data = helpers.encodeFunctionData({ abi: flashAbi, functionName: "flashLoanSimple", args: [flashAddr, helpers.ADDRESSES.USDC, amount, encoded, 0] });
const fee = obs.limits.defaultPriorityFeePerGasWei;
helpers.log("flash mode=" + mode + " spread=" + (spread * 10000).toFixed(1) + "bps usdc=" + flashUsdc);
return { type: "rawTx", tx: { to: helpers.ADDRESSES.AAVE_POOL, data: data }, maxPriorityFeePerGasWei: fee };
`.trim();

// id → ベース戦略(version を除いた雛形)。
const BASE_STRATEGIES: Record<string, Omit<Strategy, "version">> = {
  arb: {
    notes:
      "Base strategy **arb**: uniswap/balancer/curve の各 venue で pool↔fair の gap を見て最大乖離 venue を fair へ寄せる swap。期待利益の一部を priority fee に入札。revise で gapThreshold / sizeGain / bidProfitFraction を磨く。",
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
  adaptivearb: {
    notes:
      "Base strategy **adaptivearb**: arb と同じ最大乖離 venue swap だが、入札を競争シグナル(ADR 0011)で『勝てる最小限を機会価値の範囲で』決める。競合最高入札を marginPct% 上回り、profit×ceilFraction/gas で頭打ち。front-run 多発(recentRevertRate 高)なら margin↑。revise で marginPct / ceilFraction / gapThreshold を磨く。経済ガス土俵(ERIS_ECONOMIC_GAS)で arb の固定割合入札を上回る狙い。",
    params: {
      gapThreshold: 0.0005,
      minSizeBps: 250,
      maxSizeBps: 5000,
      sizeGain: 200000,
      ceilFraction: 0.8,
      gasUnitsEstimate: 180000,
      marginPctNormal: 20,
      marginPctFrontrun: 60,
      frontrunRevertThreshold: 0.4,
      slippageBps: 75,
    },
    executorTs: ADAPTIVE_ARB_EXECUTOR,
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
      "Base strategy **statarb**: uniswap gap の z-score(obs.history 窓から再計算)で動いている regime を判定し、超えたら 3 venue の最大乖離 venue を fair へ寄せる z 比例 swap。revise で zEnter / zAggressive / サイズを磨く。",
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
  cvbal: {
    notes:
      "Base strategy **cvbal**: uniswap/balancer/curve の最安 venue 買い+最高 venue 売りの delta-neutral 両建て bundle(最大スプレッドのペアを選ぶ)。revise で spreadBps / サイズを磨く。複数 AMM venue 有効時のみ。",
    params: {
      spreadBps: 15,
      minSizeBps: 250,
      maxSizeBps: 5000,
      sizeGain: 200000,
      slippageBps: 75,
    },
    executorTs: CVBAL_EXECUTOR,
  },
  dnlp: {
    notes:
      "Base strategy **dnlp**: Uniswap LP を mint し WETH エクスポージャを GMX short でヘッジするデルタニュートラル(LP→hedge→hold の状態機械)。revise で hedgeFraction / レンジ幅を磨く。uniswap+gmx 有効時のみ。",
    params: {
      hedgeFraction: 1.0,
      rangeSpacings: 20,
    },
    executorTs: DNLP_EXECUTOR,
  },
  gmxperp: {
    notes:
      "Base strategy **gmxperp**: GMX でポジション無しなら ETH long を open、あれば hold。revise で size / leverage / 方向を磨く。gmx 有効時のみ。",
    params: {
      collateralWeth: 1,
      sizeUsd: 4000,
      isLong: true,
    },
    executorTs: GMXPERP_EXECUTOR,
  },
  gmxrev: {
    notes:
      "Base strategy **gmxrev**: history MA からの乖離で逆張り(割高 short / 割安 long)。MA 近傍復帰 or 含み損 stop でクローズ。revise で entry/exit/stop/lookback を磨く。gmx 有効時のみ。",
    params: {
      maLookback: 12,
      entryBps: 40,
      exitBps: 10,
      stopUsd: 150,
      leverage: 2,
      collateralWeth: 1,
    },
    executorTs: GMXREV_EXECUTOR,
  },
  gmxtrend: {
    notes:
      "Base strategy **gmxtrend**: history の傾きで順張り。トレンド方向に open、反転で close。revise で lookback / trendBps / leverage を磨く。gmx 有効時のみ。",
    params: {
      lookback: 8,
      trendBps: 30,
      leverage: 2,
      collateralWeth: 1,
    },
    executorTs: GMXTREND_EXECUTOR,
  },
  fairmm: {
    notes:
      "Base strategy **fairmm**: fairPrice の含意 tick を中心に集中流動性を供給(pool tick ではなく fair 基準)。revise でレンジ幅 / 預入率 / 再調整条件を磨く。",
    params: {
      rangeSpacings: 4,
      depositFraction: 0.35,
      slippageBps: 75,
    },
    executorTs: FAIRMM_EXECUTOR,
  },
  jitlp: {
    notes:
      "Base strategy **jitlp**: history 窓の実現ボラが閾値超のときだけ集中レンジを mint する JIT LP。revise で volThreshold / レンジ幅 / 予算を磨く。",
    params: {
      minHistory: 12,
      volThreshold: 0.003,
      rangeTicks: 4,
      mintBudgetBps: 4500,
      slippageBps: 75,
    },
    executorTs: JITLP_EXECUTOR,
  },
  ladder: {
    notes:
      "Base strategy **ladder**: 現在 tick の周りに steps 段の集中レンジを外側へ広げて 1 ラウンド 1 段ずつ張るラダー型 MM。revise で段数 / 段幅 / 在庫スキューを磨く。",
    params: {
      steps: 3,
      stepWidthSpacings: 60,
      mintBudgetBps: 5000,
      slippageBps: 75,
    },
    executorTs: LADDER_EXECUTOR,
  },
  aaveloop: {
    notes:
      "Base strategy **aaveloop** (GitHub #6): WETH supply → USDC borrow → swap → 再 supply の多段レバレッジ carry。targetLtv まで 1 段ずつ。revise で targetLtv / borrowFraction を磨く。aave+uniswap 有効時のみ。",
    params: {
      targetLtv: 0.7,
      borrowFraction: 0.8,
      supplyFraction: 1.0,
      slippageBps: 75,
    },
    executorTs: AAVELOOP_EXECUTOR,
  },
  crossvenue: {
    notes:
      "Base strategy **crossvenue** (GitHub #4): uniswap/balancer/curve の最安 venue で買い・最高 venue で売る 2-leg 裁定。revise で spreadThreshold / サイズを磨く。複数 AMM venue 有効時のみ。",
    params: {
      spreadThreshold: 0.001,
      minSizeBps: 250,
      maxSizeBps: 5000,
      sizeGain: 200000,
      slippageBps: 75,
    },
    executorTs: CROSSVENUE_EXECUTOR,
  },
  lpyield: {
    notes:
      "Base strategy **lpyield** (GitHub #11): fair 含意 tick 中心に LP を mint し残った遊休 USDC を Aave に supply する無レバレッジ複合(手数料+利回り)。revise でレンジ幅 / 預入率 / 遊休下限を磨く。uniswap+aave 有効時のみ。",
    params: {
      rangeSpacings: 4,
      depositFraction: 0.5,
      minIdleUsdc: 10,
      slippageBps: 75,
    },
    executorTs: LPYIELD_EXECUTOR,
  },
  flasharb: {
    notes:
      "Base strategy **flasharb** (GitHub #3): Aave flashLoanSimple で自己資金上限を超えるサイズの uniswap↔balancer cross-venue 裁定を 1 tx で実行(資本制約を外すレバレッジ裁定)。割安 venue で買い割高で売り、返済段で利益不足なら atomic revert(gas のみ損)。revise で spreadThreshold / flashUsdc を磨く。**要 ERIS_FLASH_ARB=1**(未設定なら self-guard で noop)。uniswap+balancer 有効時のみ。",
    params: {
      spreadThreshold: 0.003,
      flashUsdc: 15000,
    },
    executorTs: FLASH_ARB_EXECUTOR,
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
