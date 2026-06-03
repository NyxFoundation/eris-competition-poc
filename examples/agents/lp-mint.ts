import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
let minted = false;

rl.on("line", (line) => {
  const observation = JSON.parse(line);
  const uni = observation.protocols.uniswap;
  if (minted || uni.positions.length > 0) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: "LP already opened" })}\n`,
    );
    return;
  }

  const spacing = uni.pool.tickSpacing;
  const center = Math.floor(uni.pool.tick / spacing) * spacing;
  minted = true;
  process.stdout.write(
    `${JSON.stringify({
      type: "mintLiquidity",
      tickLower: center - spacing * 20,
      tickUpper: center + spacing * 20,
      amountWethDesired: (
        BigInt(observation.limits.maxLpWethWei) / 10n
      ).toString(),
      amountUsdcDesired: (
        BigInt(observation.limits.maxLpUsdcUnits) / 10n
      ).toString(),
      maxPriorityFeePerGasWei: observation.limits.defaultPriorityFeePerGasWei,
      slippageBps: 100,
    })}\n`,
  );
});
