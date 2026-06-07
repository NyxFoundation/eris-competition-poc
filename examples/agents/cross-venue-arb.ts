// cross-venue-arb (GitHub #4): uniswap/balancer/curve のうち最安 venue で買い・最高 venue で
// 売る 2-leg 裁定。cv-bal-arb.ts(bal↔curve 限定)を 3 venue の最大乖離ペアへ一般化したもの。
// 注: 別 fee-tier / Uniswap v2 は観測に含まれないため対象外(uni 0.05% + balancer + curve のみ)。
// RPC 不要・semantic action のみ。
//
// env:
//   CROSS_VENUE_SPREAD_BPS  発注する最小スプレッド(bps, default 10)
import { createInterface } from "node:readline";

const SPREAD_BPS = intEnv("CROSS_VENUE_SPREAD_BPS", 10);
const SIZE_BPS_MIN = 250;
const SIZE_BPS_MAX = 5000;
const SLIPPAGE_BPS = 75;

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  try {
    const obs = JSON.parse(line);
    const p = obs.protocols ?? {};
    const fee = obs.limits.defaultPriorityFeePerGasWei;
    const venues: Array<{ swapType: string; price: number }> = [];
    if (p.uniswap?.pool?.priceUsdcPerWeth > 0)
      venues.push({ swapType: "swap", price: p.uniswap.pool.priceUsdcPerWeth });
    if (p.balancer?.priceUsdcPerWeth > 0)
      venues.push({
        swapType: "balancerSwap",
        price: p.balancer.priceUsdcPerWeth,
      });
    if (p.curve?.priceUsdcPerWeth > 0)
      venues.push({ swapType: "curveSwap", price: p.curve.priceUsdcPerWeth });
    if (venues.length < 2) {
      out({ type: "noop", reason: "need >=2 venues" });
      return;
    }
    let lo = venues[0];
    let hi = venues[0];
    for (const v of venues) {
      if (v.price < lo.price) lo = v;
      if (v.price > hi.price) hi = v;
    }
    const spread = hi.price / lo.price - 1;
    if (spread < SPREAD_BPS / 10_000 || lo.swapType === hi.swapType) {
      out({ type: "noop", reason: "spread too small" });
      return;
    }
    const sizeBps = Math.min(
      SIZE_BPS_MAX,
      Math.max(SIZE_BPS_MIN, Math.floor(spread * 200_000)),
    );
    const usdcIn =
      (BigInt(obs.limits.maxUsdcInUnits) * BigInt(sizeBps)) / 10_000n;
    const wethIn =
      (BigInt(obs.limits.maxWethInWei) * BigInt(sizeBps)) / 10_000n;
    if (usdcIn <= 0n || wethIn <= 0n) {
      out({ type: "noop", reason: "computed size zero" });
      return;
    }
    out({
      type: "bundle",
      actions: [
        {
          type: lo.swapType,
          tokenIn: "USDC",
          amountIn: usdcIn.toString(),
          slippageBps: SLIPPAGE_BPS,
        },
        {
          type: hi.swapType,
          tokenIn: "WETH",
          amountIn: wethIn.toString(),
          slippageBps: SLIPPAGE_BPS,
        },
      ],
      maxPriorityFeePerGasWei: fee,
    });
  } catch (error) {
    out({ type: "noop", reason: `error: ${error}` });
  }
});

function out(action: unknown): void {
  process.stdout.write(`${JSON.stringify(action)}\n`);
}
function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}
