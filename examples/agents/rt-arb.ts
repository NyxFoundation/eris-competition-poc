import { runRealtimeAgent } from "./lib/realtimeAgent.js";

// 実時間モードの最小 arb agent。flow が動かした pool 価格と fair の乖離(gap)を見て、
// |gap| が閾値を超えたら利益方向へ swap を出す。自前タイマーで非同期に送信する。
const FEE_WEI = process.env.FEE_WEI ?? "800000000";
const GAP_BPS = Number(process.env.RT_GAP_BPS ?? "20"); // |gap| > 0.2% で発火
const SIZE_BPS = Number(process.env.RT_SIZE_BPS ?? "1500");
const INTERVAL_MS = Number(process.env.RT_INTERVAL_MS ?? "2200");

runRealtimeAgent({
  intervalMs: INTERVAL_MS,
  decide: (obs) => {
    const pool = obs.protocols.uniswap?.pool.priceUsdcPerWeth;
    const fair = obs.fairPriceUsdcPerWeth;
    if (typeof pool !== "number" || typeof fair !== "number" || pool <= 0)
      return null;
    const gap = fair / pool - 1;
    if (Math.abs(gap) * 10_000 < GAP_BPS) return null;
    // pool が fair より安い(gap>0)なら WETH を買う(USDC を入れる)、高ければ WETH を売る。
    const tokenIn = gap > 0 ? "USDC" : "WETH";
    const max = BigInt(
      tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits,
    );
    const amountIn = (max * BigInt(SIZE_BPS)) / 10_000n;
    if (amountIn <= 0n) return null;
    return {
      type: "swap",
      tokenIn,
      amountIn: amountIn.toString(),
      maxPriorityFeePerGasWei: FEE_WEI,
      slippageBps: 100,
    };
  },
});
