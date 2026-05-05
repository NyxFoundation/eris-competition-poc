import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const observation = JSON.parse(line);
  const pool = observation.pool.priceUsdcPerWeth;
  const fair = observation.fairPriceUsdcPerWeth;
  const gap = fair / pool - 1;
  if (Math.abs(gap) < 0.0015) {
    process.stdout.write(`${JSON.stringify({ type: "noop", reason: "gap too small" })}\n`);
    return;
  }
  const tokenIn = gap > 0 ? "USDC" : "WETH";
  const max = BigInt(tokenIn === "WETH" ? observation.limits.maxWethInWei : observation.limits.maxUsdcInUnits);
  const sizeBps = Math.min(2500, Math.max(250, Math.floor(Math.abs(gap) * 200_000)));
  const amountIn = (max * BigInt(sizeBps)) / 10_000n;
  process.stdout.write(
    `${JSON.stringify({
      type: "swap",
      tokenIn,
      amountIn: amountIn.toString(),
      maxPriorityFeePerGasWei: observation.limits.defaultPriorityFeePerGasWei,
      slippageBps: 50
    })}\n`
  );
});
