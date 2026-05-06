import { createInterface } from "node:readline";

type Observation = {
  pool: {
    priceUsdcPerWeth: number;
    tick: number;
    tickSpacing: number;
  };
  fairPriceUsdcPerWeth: number;
  balances: {
    wethWei: string;
    usdcUnits: string;
  };
  positions: Array<{
    tokenId: string;
    tickLower: number;
    tickUpper: number;
    liquidity: string;
    tokensOwedWethWei: string;
    tokensOwedUsdcUnits: string;
  }>;
  limits: {
    defaultPriorityFeePerGasWei: string;
    maxLpWethWei: string;
    maxLpUsdcUnits: string;
    maxOpenPositions: number;
  };
};

const rl = createInterface({ input: process.stdin });

const RANGE_WIDTH_MULTIPLIER = 60;
const EDGE_BUFFER_MULTIPLIER = 8;
const MINT_BUDGET_BPS = 3500;
const MIN_WETH_MINT_WEI = 10_000_000_000_000_000n;
const MIN_USDC_MINT_UNITS = 25_000_000n;

rl.on("line", (line) => {
  const observation = JSON.parse(line) as Observation;
  const action = decideAction(observation);
  process.stdout.write(`${JSON.stringify(action)}\n`);
});

function decideAction(observation: Observation) {
  const priorityFee = observation.limits.defaultPriorityFeePerGasWei;
  const managedPosition = observation.positions.find((position) => BigInt(position.liquidity) > 0n);
  if (managedPosition) {
    if (shouldRebalance(observation, managedPosition)) {
      return {
        type: "bundle",
        maxPriorityFeePerGasWei: priorityFee,
        actions: [
          {
            type: "removeLiquidity",
            tokenId: managedPosition.tokenId,
            liquidity: managedPosition.liquidity
          },
          {
            type: "collectFees",
            tokenId: managedPosition.tokenId
          }
        ]
      };
    }

    if (hasCollectableFees(managedPosition)) {
      return {
        type: "collectFees",
        tokenId: managedPosition.tokenId,
        maxPriorityFeePerGasWei: priorityFee
      };
    }

    return { type: "noop", reason: "LP position is in range" };
  }

  const collectOnly = observation.positions.find((position) => hasCollectableFees(position));
  if (collectOnly) {
    return {
      type: "collectFees",
      tokenId: collectOnly.tokenId,
      maxPriorityFeePerGasWei: priorityFee
    };
  }

  if (observation.positions.length >= observation.limits.maxOpenPositions) {
    return { type: "noop", reason: "max open LP positions reached" };
  }

  const amountWethDesired = budgetAmount(BigInt(observation.balances.wethWei), BigInt(observation.limits.maxLpWethWei));
  const amountUsdcDesired = budgetAmount(BigInt(observation.balances.usdcUnits), BigInt(observation.limits.maxLpUsdcUnits));
  if (amountWethDesired < MIN_WETH_MINT_WEI || amountUsdcDesired < MIN_USDC_MINT_UNITS) {
    return { type: "noop", reason: "insufficient LP budget" };
  }

  const { tickLower, tickUpper } = chooseRange(observation);
  return {
    type: "mintLiquidity",
    tickLower,
    tickUpper,
    amountWethDesired: amountWethDesired.toString(),
    amountUsdcDesired: amountUsdcDesired.toString(),
    maxPriorityFeePerGasWei: priorityFee,
    slippageBps: 100
  };
}

function shouldRebalance(observation: Observation, position: Observation["positions"][number]): boolean {
  const buffer = observation.pool.tickSpacing * EDGE_BUFFER_MULTIPLIER;
  return observation.pool.tick <= position.tickLower + buffer || observation.pool.tick >= position.tickUpper - buffer;
}

function hasCollectableFees(position: Pick<Observation["positions"][number], "tokensOwedWethWei" | "tokensOwedUsdcUnits">): boolean {
  return BigInt(position.tokensOwedWethWei) > 0n || BigInt(position.tokensOwedUsdcUnits) > 0n;
}

function budgetAmount(balance: bigint, limit: bigint): bigint {
  const capped = balance < limit ? balance : limit;
  return (capped * BigInt(MINT_BUDGET_BPS)) / 10_000n;
}

function chooseRange(observation: Observation): { tickLower: number; tickUpper: number } {
  const spacing = observation.pool.tickSpacing;
  const halfWidth = spacing * RANGE_WIDTH_MULTIPLIER;
  const fairGap = observation.fairPriceUsdcPerWeth / observation.pool.priceUsdcPerWeth - 1;
  const rawShift = Math.trunc(fairGap * halfWidth * 4);
  const boundedShift = clamp(rawShift, -Math.trunc(halfWidth / 2), Math.trunc(halfWidth / 2));
  const center = alignTick(observation.pool.tick + boundedShift, spacing);
  return {
    tickLower: center - halfWidth,
    tickUpper: center + halfWidth
  };
}

function alignTick(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
