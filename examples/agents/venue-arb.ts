// venue-arb: 有効な AMM venue (uniswap/balancer/curve) のうち fairPrice から最も乖離した
// プールで、価格を fair に寄せる向きに swap する cross-venue 裁定エージェント。
import { createInterface } from "node:readline";

type Venue = {
  id: "uniswap" | "balancer" | "curve";
  swapType: "swap" | "balancerSwap" | "curveSwap";
  price: number;
};

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const fair = obs.fairPriceUsdcPerWeth;
  const p = obs.protocols ?? {};
  const venues: Venue[] = [];
  if (p.uniswap?.pool)
    venues.push({
      id: "uniswap",
      swapType: "swap",
      price: p.uniswap.pool.priceUsdcPerWeth,
    });
  if (p.balancer)
    venues.push({
      id: "balancer",
      swapType: "balancerSwap",
      price: p.balancer.priceUsdcPerWeth,
    });
  if (p.curve)
    venues.push({
      id: "curve",
      swapType: "curveSwap",
      price: p.curve.priceUsdcPerWeth,
    });

  let best: Venue | undefined;
  let bestGap = 0;
  for (const v of venues) {
    const gap = Math.abs(fair / v.price - 1);
    if (gap > bestGap) {
      bestGap = gap;
      best = v;
    }
  }

  if (!best || bestGap < 0.001) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: "no venue gap" })}\n`,
    );
    return;
  }

  // pool 価格 < fair なら WETH が割安 → USDC で WETH を買う（USDC in）
  const tokenIn = best.price < fair ? "USDC" : "WETH";
  const max = BigInt(
    tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits,
  );
  const sizeBps = Math.min(2500, Math.max(250, Math.floor(bestGap * 200_000)));
  const amountIn = (max * BigInt(sizeBps)) / 10_000n;

  process.stdout.write(
    `${JSON.stringify({
      type: best.swapType,
      tokenIn,
      amountIn: amountIn.toString(),
      maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
      slippageBps: 75,
    })}\n`,
  );
});
