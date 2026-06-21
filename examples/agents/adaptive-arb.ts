/**
 * adaptive-arb: 競争シグナル（ADR 0011）で「勝てる最小限を、機会価値を超えない範囲で」入札する arb。
 *
 * arb-bot との違い: arb-bot は利益の固定割合(BID_PROFIT_FRACTION)を機械的に積む（過剰/過少になりうる）。
 * adaptive-arb は obs.competition を見て:
 *   - 競合の最高入札(maxCompetitorPriorityFeeWei)を僅かに上回るだけ積む（勝てる最小限）
 *   - ただし機会価値の上限(profit×CEIL_FRACTION/gas)を超えない（過剰入札を罰せられないようにする）
 *   - 直近で front-run されている(recentRevertRate 高)なら margin を上げる
 * これにより「積まなすぎ→先約定され revert」も「積みすぎ→fee 浪費」も避ける（執行スキル）。
 *
 * 環境変数:
 *   ADAPT_CEIL_FRACTION  機会価値のうち入札上限に充てる割合 (default 0.8。残りを net 利益に残す)
 */
import { createInterface } from "node:readline";
import { createEmitter } from "./lib/agentLog.js";

type Observation = {
  round: number;
  protocols: {
    uniswap?: { pool?: { priceUsdcPerWeth: number } };
    balancer?: { priceUsdcPerWeth: number };
    curve?: { priceUsdcPerWeth: number };
  };
  fairPriceUsdcPerWeth: number;
  limits: {
    maxWethInWei: string;
    maxUsdcInUnits: string;
    defaultPriorityFeePerGasWei: string;
    maxPriorityFeePerGasWei: string;
  };
  competition?: {
    maxCompetitorPriorityFeeWei: string;
    maxBlockPriorityFeeWei: string;
    lastTxIndex: number | null;
    recentRevertRate: number;
    recentSampleSize: number;
  };
};

const emit = createEmitter();

const CEIL_FRACTION = Number(process.env.ADAPT_CEIL_FRACTION ?? "0.8");
const GAS_UNITS_ESTIMATE = 180_000n;
const GAP_THRESHOLD = 0.0005;
const SIZE_BPS_MIN = 250;
const SIZE_BPS_MAX = 5000;
const ONE_GWEI = 1_000_000_000n;

if (!Number.isFinite(CEIL_FRACTION) || CEIL_FRACTION <= 0) {
  process.stderr.write(
    `invalid ADAPT_CEIL_FRACTION: ${process.env.ADAPT_CEIL_FRACTION}\n`,
  );
  process.exit(1);
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line) as Observation;
  const round = obs.round;
  const signals: Record<string, number> = {};
  const fair = obs.fairPriceUsdcPerWeth;
  if (!Number.isFinite(fair) || fair <= 0) {
    emit({ type: "noop", reason: "invalid fair" }, { round, signals });
    return;
  }
  // 3 venue から最大乖離 venue を選ぶ（arb-bot と同じ機会選択）。
  const venues: Array<{ swapType: string; price: number }> = [];
  const uni = obs.protocols?.uniswap?.pool?.priceUsdcPerWeth;
  if (Number.isFinite(uni) && (uni ?? 0) > 0)
    venues.push({ swapType: "swap", price: uni as number });
  const bal = obs.protocols?.balancer?.priceUsdcPerWeth;
  if (Number.isFinite(bal) && (bal ?? 0) > 0)
    venues.push({ swapType: "balancerSwap", price: bal as number });
  const curve = obs.protocols?.curve?.priceUsdcPerWeth;
  if (Number.isFinite(curve) && (curve ?? 0) > 0)
    venues.push({ swapType: "curveSwap", price: curve as number });
  if (venues.length === 0) {
    emit({ type: "noop", reason: "no venue" }, { round, signals });
    return;
  }
  let best = venues[0];
  let gap = fair / venues[0].price - 1;
  for (const v of venues) {
    const g = fair / v.price - 1;
    if (Math.abs(g) > Math.abs(gap)) {
      gap = g;
      best = v;
    }
  }
  signals.gapBps = gap * 10_000;
  if (Math.abs(gap) < GAP_THRESHOLD) {
    emit({ type: "noop", reason: "gap too small" }, { round, signals });
    return;
  }

  const tokenIn = gap > 0 ? "USDC" : "WETH";
  const max = BigInt(
    tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits,
  );
  const sizeBps = Math.min(
    SIZE_BPS_MAX,
    Math.max(SIZE_BPS_MIN, Math.floor(Math.abs(gap) * 200_000)),
  );
  const amountIn = (max * BigInt(sizeBps)) / 10_000n;

  // 機会価値（per gas）の上限 = profit × CEIL_FRACTION / gas。これを超えて積むと net を削る。
  const sizeUsdc =
    tokenIn === "USDC"
      ? Number(amountIn) / 1e6
      : (Number(amountIn) / 1e18) * fair;
  const profitUsdc = sizeUsdc * Math.abs(gap);
  const profitWei =
    BigInt(Math.max(0, Math.floor((profitUsdc / fair) * 1e9))) * ONE_GWEI;
  const ceilNum = BigInt(Math.max(0, Math.floor(CEIL_FRACTION * 10_000)));
  const ceilingPerGas = (profitWei * ceilNum) / 10_000n / GAS_UNITS_ESTIMATE;

  // 競争シグナル: 競合の最高入札を僅かに上回る（勝てる最小限）。front-run されているなら margin↑。
  const comp = obs.competition;
  const competitorMax = BigInt(comp?.maxCompetitorPriorityFeeWei ?? "0");
  const revertRate = comp?.recentRevertRate ?? 0;
  signals.competitorMaxGwei = Number(competitorMax / ONE_GWEI);
  signals.revertRate = revertRate;
  signals.lastTxIndex = comp?.lastTxIndex ?? -1;
  // margin: 平常 20%、先約定が多い(revert>0.4)なら 60% 上乗せして確実に前へ。最低 1 gwei。
  const marginFrac = revertRate > 0.4 ? 60n : 20n;
  const margin =
    (competitorMax * marginFrac) / 100n > ONE_GWEI
      ? (competitorMax * marginFrac) / 100n
      : ONE_GWEI;
  let bid = competitorMax + margin;
  // 機会価値の上限で頭打ち（過剰入札を避ける）。
  if (bid > ceilingPerGas) bid = ceilingPerGas;
  // floor/上限 clamp。
  const minBid = BigInt(obs.limits.defaultPriorityFeePerGasWei);
  const maxBid = BigInt(obs.limits.maxPriorityFeePerGasWei);
  if (bid < minBid) bid = minBid;
  if (bid > maxBid) bid = maxBid;

  signals.bidGwei = Number(bid / ONE_GWEI);
  signals.ceilingGwei = Number(ceilingPerGas / ONE_GWEI);
  emit(
    {
      type: best.swapType,
      tokenIn,
      amountIn: amountIn.toString(),
      maxPriorityFeePerGasWei: bid.toString(),
      slippageBps: 75,
    },
    { round, signals },
  );
});
