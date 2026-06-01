// cv-bal-arb: Balancer と Curve の WETH 価格差(スプレッド)そのものを取りに行くペア裁定。
// venue-arb.ts は各 venue を個別に fairPrice へ寄せるだけだが、本戦略は 2 venue 間の相対価格差に
// 着目し、割安 venue で WETH を買い・割高 venue で WETH を売る両建てを 1 つの bundle で実行する。
//
// env:
//   SPREAD_BPS  発注する最小スプレッド (bps, default 15)
import { createInterface } from "node:readline";

const SPREAD_BPS = Number(process.env.SPREAD_BPS ?? "15");
const SIZE_BPS_MIN = 250;
const SIZE_BPS_MAX = 5000;

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const bal = obs.protocols?.balancer?.priceUsdcPerWeth;
  const curve = obs.protocols?.curve?.priceUsdcPerWeth;
  const fee = obs.limits.defaultPriorityFeePerGasWei;
  if (
    !Number.isFinite(bal) ||
    bal <= 0 ||
    !Number.isFinite(curve) ||
    curve <= 0
  ) {
    out({ type: "noop", reason: "balancer/curve unavailable" });
    return;
  }

  const spread = Math.abs(bal / curve - 1);
  if (spread < SPREAD_BPS / 10_000) {
    out({ type: "noop", reason: "spread too small" });
    return;
  }

  // 価格が低い venue = WETH が割安 → そこで USDC→WETH 買い。高い venue で WETH→USDC 売り。
  const balCheaper = bal < curve;
  const buyVenue = balCheaper ? "balancerSwap" : "curveSwap";
  const sellVenue = balCheaper ? "curveSwap" : "balancerSwap";

  const sizeBps = Math.min(
    SIZE_BPS_MAX,
    Math.max(SIZE_BPS_MIN, Math.floor(spread * 200_000)),
  );
  const usdcIn =
    (BigInt(obs.limits.maxUsdcInUnits) * BigInt(sizeBps)) / 10_000n;
  const wethIn = (BigInt(obs.limits.maxWethInWei) * BigInt(sizeBps)) / 10_000n;

  out({
    type: "bundle",
    actions: [
      {
        type: buyVenue,
        tokenIn: "USDC",
        amountIn: usdcIn.toString(),
        slippageBps: 75,
      },
      {
        type: sellVenue,
        tokenIn: "WETH",
        amountIn: wethIn.toString(),
        slippageBps: 75,
      },
    ],
    maxPriorityFeePerGasWei: fee,
  });
});

function out(action: unknown): void {
  process.stdout.write(`${JSON.stringify(action)}\n`);
}
