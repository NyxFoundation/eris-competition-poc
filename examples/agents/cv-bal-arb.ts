// cv-bal-arb: Balancer と Curve の WETH 価格差(スプレッド)そのものを取りに行くペア裁定。
// venue-arb.ts は各 venue を個別に fairPrice へ寄せるだけだが、本戦略は 2 venue 間の相対価格差に
// 着目し、割安 venue で WETH を買い・割高 venue で WETH を売る両建てを 1 つの bundle で実行する。
//
// env:
//   SPREAD_BPS  発注する最小スプレッド (bps, default 15)
import { createInterface } from "node:readline";
import { createEmitter } from "./lib/agentLog.js";

const SPREAD_BPS = Number(process.env.SPREAD_BPS ?? "15");
const SIZE_BPS_MIN = 250;
const SIZE_BPS_MAX = 5000;

const emit = createEmitter();

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const round = obs.round;
  const signals: Record<string, number> = {};
  const bal = obs.protocols?.balancer?.priceUsdcPerWeth;
  const curve = obs.protocols?.curve?.priceUsdcPerWeth;
  const fee = obs.limits.defaultPriorityFeePerGasWei;
  if (
    !Number.isFinite(bal) ||
    bal <= 0 ||
    !Number.isFinite(curve) ||
    curve <= 0
  ) {
    emit(
      { type: "noop", reason: "balancer/curve unavailable" },
      { round, signals },
    );
    return;
  }

  const spread = Math.abs(bal / curve - 1);
  signals.bal = bal;
  signals.curve = curve;
  signals.spread = spread;
  signals.spreadBps = spread * 10_000;
  if (spread < SPREAD_BPS / 10_000) {
    emit({ type: "noop", reason: "spread too small" }, { round, signals });
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
  signals.sizeBps = sizeBps;
  const usdcIn =
    (BigInt(obs.limits.maxUsdcInUnits) * BigInt(sizeBps)) / 10_000n;
  const wethIn = (BigInt(obs.limits.maxWethInWei) * BigInt(sizeBps)) / 10_000n;

  emit(
    {
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
    },
    { round, signals },
  );
});
