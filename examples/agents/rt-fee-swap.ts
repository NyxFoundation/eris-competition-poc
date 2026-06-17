import { runRealtimeAgent } from "./lib/realtimeAgent.js";

// 実時間モード検証用の最小フリーラン agent。
// 自前タイマー（RT_INTERVAL_MS ごと）で指定 priority fee（FEE_WEI）の WETH->USDC 小口 swap を出す。
// FEE_WEI を agent ごとに変えると同一2秒ブロック内の fee 降順整列を観測でき、RT_OFFSET_MS で
// 送信位相をずらすとタイミング差が着ブロック差に出るのを観測できる。
const FEE_WEI = process.env.FEE_WEI ?? "100000000";
const AMOUNT_IN_WEI = process.env.RT_AMOUNT_WEI ?? "1000000000000000"; // 0.001 WETH
const INTERVAL_MS = Number(process.env.RT_INTERVAL_MS ?? "2200");
const OFFSET_MS = Number(process.env.RT_OFFSET_MS ?? "0");

runRealtimeAgent({
  intervalMs: INTERVAL_MS,
  offsetMs: OFFSET_MS,
  decide: () => ({
    type: "swap",
    tokenIn: "WETH",
    amountIn: AMOUNT_IN_WEI,
    maxPriorityFeePerGasWei: FEE_WEI,
    slippageBps: 200,
  }),
});
