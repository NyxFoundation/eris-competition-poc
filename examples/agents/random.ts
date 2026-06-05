import { createInterface } from "node:readline";
import { Rng } from "../../src/rng.js";

// ベースライン「でたらめ売買」。識別力判定の物差しなので決定論にする:
// 市場(SEED)と agent id から乱数源を導出 → 同一 SEED = 同一物差し（before/after が再現可能）。
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const seed = Number(process.env.SEED ?? process.env.ERIS_FLOW_SEED ?? 1);
const agentId = process.env.ERIS_AGENT_ID ?? "random";
const rng = new Rng((seed ^ hashStr(agentId)) >>> 0);

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const observation = JSON.parse(line);
  if (rng.next() < 0.35) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: "random skip" })}\n`,
    );
    return;
  }
  const tokenIn = rng.next() < 0.5 ? "WETH" : "USDC";
  const max = BigInt(
    tokenIn === "WETH"
      ? observation.limits.maxWethInWei
      : observation.limits.maxUsdcInUnits,
  );
  const amountIn = (max * BigInt(1 + rng.int(0, 50))) / 100n;
  process.stdout.write(
    `${JSON.stringify({
      type: "swap",
      tokenIn,
      amountIn: amountIn.toString(),
      maxPriorityFeePerGasWei: observation.limits.defaultPriorityFeePerGasWei,
      slippageBps: 75,
    })}\n`,
  );
});
