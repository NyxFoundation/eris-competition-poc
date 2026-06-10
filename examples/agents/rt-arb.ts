import { createInterface } from "node:readline";

// 実時間モードの最小 arb agent。flow が動かした pool 価格と fair の乖離(gap)を見て、
// |gap| が閾値を超えたら利益方向へ swap を出す。自前タイマーで非同期に送信する。
// FEE_WEI で入札、RT_GAP_BPS で発火閾値、RT_SIZE_BPS で建玉サイズを調整。
const FEE_WEI = process.env.FEE_WEI ?? "800000000";
const GAP_BPS = Number(process.env.RT_GAP_BPS ?? "20"); // |gap| > 0.2% で発火
const SIZE_BPS = Number(process.env.RT_SIZE_BPS ?? "1500");
const INTERVAL_MS = Number(process.env.RT_INTERVAL_MS ?? "2200");

interface Observation {
  protocols?: { uniswap?: { pool?: { priceUsdcPerWeth?: number } } };
  fairPriceUsdcPerWeth?: number;
  oraclePrices?: { wethUsd?: number };
  limits: { maxWethInWei: string; maxUsdcInUnits: string };
}

let latest: Observation | null = null;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    latest = JSON.parse(line) as Observation;
  } catch {
    // パース失敗は無視
  }
});

function tick(): void {
  const obs = latest;
  if (!obs) return;
  const pool = obs.protocols?.uniswap?.pool?.priceUsdcPerWeth;
  const fair = obs.fairPriceUsdcPerWeth ?? obs.oraclePrices?.wethUsd;
  if (typeof pool !== "number" || typeof fair !== "number" || pool <= 0) return;
  const gap = fair / pool - 1;
  if (Math.abs(gap) * 10_000 < GAP_BPS) return;
  // pool が fair より安い(gap>0)なら WETH を買う(USDC を入れる)、高ければ WETH を売る。
  const tokenIn = gap > 0 ? "USDC" : "WETH";
  const max = BigInt(
    tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits,
  );
  const amountIn = (max * BigInt(SIZE_BPS)) / 10_000n;
  if (amountIn <= 0n) return;
  process.stdout.write(
    `${JSON.stringify({
      type: "swap",
      tokenIn,
      amountIn: amountIn.toString(),
      maxPriorityFeePerGasWei: FEE_WEI,
      slippageBps: 100,
    })}\n`,
  );
}

setInterval(tick, INTERVAL_MS);
