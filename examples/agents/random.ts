import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const observation = JSON.parse(line);
  if (Math.random() < 0.35) {
    process.stdout.write(`${JSON.stringify({ type: "noop", reason: "random skip" })}\n`);
    return;
  }
  const tokenIn = Math.random() < 0.5 ? "WETH" : "USDC";
  const max = BigInt(tokenIn === "WETH" ? observation.limits.maxWethInWei : observation.limits.maxUsdcInUnits);
  const amountIn = (max * BigInt(1 + Math.floor(Math.random() * 50))) / 100n;
  process.stdout.write(
    `${JSON.stringify({
      type: "swap",
      tokenIn,
      amountIn: amountIn.toString(),
      maxPriorityFeePerGasWei: observation.limits.defaultPriorityFeePerGasWei,
      slippageBps: 75
    })}\n`
  );
});
