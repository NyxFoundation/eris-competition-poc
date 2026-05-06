import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  maxUint128,
  type Address,
  type Hex,
  type PublicClient
} from "viem";
import { nonfungiblePositionManagerAbi, poolAbi, quoterV2Abi, swapRouterAbi } from "./abis.js";
import { ADDRESSES, WETH_USDC_FEE, WETH_USDC_TICK_SPACING } from "./constants.js";
import type { BundleActionItem, LpPositionObservation, SwapAction, TokenSymbol } from "./types.js";

export function tokenAddress(symbol: TokenSymbol): Address {
  return symbol === "WETH" ? ADDRESSES.weth : ADDRESSES.usdc;
}

export function oppositeToken(symbol: TokenSymbol): TokenSymbol {
  return symbol === "WETH" ? "USDC" : "WETH";
}

export async function getPoolState(publicClient: PublicClient): Promise<{ priceUsdcPerWeth: number; tick: number; tickSpacing: number }> {
  const [[sqrtPriceX96, tick], tickSpacing] = await Promise.all([
    publicClient.readContract({
      address: ADDRESSES.uniswapV3PoolWethUsdc500,
      abi: poolAbi,
      functionName: "slot0"
    }),
    publicClient.readContract({
      address: ADDRESSES.uniswapV3PoolWethUsdc500,
      abi: poolAbi,
      functionName: "tickSpacing"
    }).catch(() => WETH_USDC_TICK_SPACING)
  ]);
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const rawToken1PerToken0 = ratio * ratio;
  return { priceUsdcPerWeth: 10 ** 12 / rawToken1PerToken0, tick, tickSpacing };
}

export async function getPoolPriceUsdcPerWeth(publicClient: PublicClient): Promise<number> {
  return (await getPoolState(publicClient)).priceUsdcPerWeth;
}

export async function quoteExactInput(publicClient: PublicClient, tokenIn: TokenSymbol, amountIn: bigint): Promise<bigint> {
  const data = encodeFunctionData({
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: tokenAddress(tokenIn),
        tokenOut: tokenAddress(oppositeToken(tokenIn)),
        amountIn,
        fee: WETH_USDC_FEE,
        sqrtPriceLimitX96: 0n
      }
    ]
  });
  const result = await publicClient.call({ to: ADDRESSES.quoterV2, data });
  const [amountOut] = decodeFunctionResult({
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    data: result.data ?? "0x"
  });
  return amountOut;
}

export async function buildSwapData(
  publicClient: PublicClient,
  recipient: Address,
  action: SwapAction,
  slippageBps: number
): Promise<Hex> {
  const amountIn = BigInt(action.amountIn);
  const quoted = await quoteExactInput(publicClient, action.tokenIn, amountIn);
  const amountOutMinimum = applySlippage(quoted, slippageBps);
  return encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: tokenAddress(action.tokenIn),
        tokenOut: tokenAddress(oppositeToken(action.tokenIn)),
        fee: WETH_USDC_FEE,
        recipient,
        deadline: deadline(),
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n
      }
    ]
  });
}

export async function buildLpActionData(publicClient: PublicClient, owner: Address, action: BundleActionItem, slippageBps: number): Promise<Hex> {
  if (action.type === "mintLiquidity") {
    const amount0Desired = BigInt(action.amountUsdcDesired);
    const amount1Desired = BigInt(action.amountWethDesired);
    const simulated = await publicClient.simulateContract({
      account: owner,
      address: ADDRESSES.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "mint",
      args: [
        {
          token0: ADDRESSES.usdc,
          token1: ADDRESSES.weth,
          fee: WETH_USDC_FEE,
          tickLower: action.tickLower,
          tickUpper: action.tickUpper,
          amount0Desired,
          amount1Desired,
          amount0Min: 0n,
          amount1Min: 0n,
          recipient: owner,
          deadline: deadline()
        }
      ]
    });
    const [, , amount0, amount1] = simulated.result;
    return encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "mint",
      args: [
        {
          token0: ADDRESSES.usdc,
          token1: ADDRESSES.weth,
          fee: WETH_USDC_FEE,
          tickLower: action.tickLower,
          tickUpper: action.tickUpper,
          amount0Desired,
          amount1Desired,
          amount0Min: applySlippage(amount0, slippageBps),
          amount1Min: applySlippage(amount1, slippageBps),
          recipient: owner,
          deadline: deadline()
        }
      ]
    });
  }

  if (action.type === "removeLiquidity") {
    return encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId: BigInt(action.tokenId),
          liquidity: BigInt(action.liquidity),
          amount0Min: BigInt(action.amountUsdcMin ?? "0"),
          amount1Min: BigInt(action.amountWethMin ?? "0"),
          deadline: deadline()
        }
      ]
    });
  }

  if (action.type === "collectFees") {
    return encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "collect",
      args: [
        {
          tokenId: BigInt(action.tokenId),
          recipient: owner,
          amount0Max: maxUint128,
          amount1Max: maxUint128
        }
      ]
    });
  }

  throw new Error(`Unsupported LP action: ${action.type}`);
}

export async function getLpPositions(publicClient: PublicClient, owner: Address, fairPriceUsdcPerWeth: number): Promise<LpPositionObservation[]> {
  const [{ tick }, balance] = await Promise.all([
    getPoolState(publicClient),
    publicClient.readContract({
      address: ADDRESSES.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "balanceOf",
      args: [owner]
    })
  ]);

  const positions: LpPositionObservation[] = [];
  for (let i = 0n; i < balance; i++) {
    const tokenId = await publicClient.readContract({
      address: ADDRESSES.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "tokenOfOwnerByIndex",
      args: [owner, i]
    });
    const position = await publicClient.readContract({
      address: ADDRESSES.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "positions",
      args: [tokenId]
    });
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] = position;
    if (!isWethUsdcPosition(token0, token1, fee)) continue;
    const amounts = liquidityToTokenAmounts({ liquidity, tick, tickLower, tickUpper });
    const value = valuePositionUsdc(amounts.amount1, amounts.amount0, tokensOwed1, tokensOwed0, fairPriceUsdcPerWeth);
    positions.push({
      tokenId: tokenId.toString(),
      tickLower,
      tickUpper,
      liquidity: liquidity.toString(),
      tokensOwedWethWei: tokensOwed1.toString(),
      tokensOwedUsdcUnits: tokensOwed0.toString(),
      amountWethWei: amounts.amount1.toString(),
      amountUsdcUnits: amounts.amount0.toString(),
      valueUsdc: value
    });
  }
  return positions;
}

export function liquidityToTokenAmounts(input: { liquidity: bigint; tick: number; tickLower: number; tickUpper: number }): { amount0: bigint; amount1: bigint } {
  const liquidity = Number(input.liquidity);
  const sqrtLower = Math.pow(1.0001, input.tickLower / 2);
  const sqrtUpper = Math.pow(1.0001, input.tickUpper / 2);
  const sqrtCurrent = Math.pow(1.0001, input.tick / 2);

  let amount0 = 0;
  let amount1 = 0;
  if (input.tick < input.tickLower) {
    amount0 = liquidity * (sqrtUpper - sqrtLower) / (sqrtUpper * sqrtLower);
  } else if (input.tick >= input.tickUpper) {
    amount1 = liquidity * (sqrtUpper - sqrtLower);
  } else {
    amount0 = liquidity * (sqrtUpper - sqrtCurrent) / (sqrtUpper * sqrtCurrent);
    amount1 = liquidity * (sqrtCurrent - sqrtLower);
  }

  return {
    amount0: BigInt(Math.max(0, Math.floor(amount0))),
    amount1: BigInt(Math.max(0, Math.floor(amount1)))
  };
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 3600);
}

function isWethUsdcPosition(token0: Address, token1: Address, fee: number): boolean {
  return token0.toLowerCase() === ADDRESSES.usdc.toLowerCase() && token1.toLowerCase() === ADDRESSES.weth.toLowerCase() && fee === WETH_USDC_FEE;
}

function valuePositionUsdc(amountWethWei: bigint, amountUsdcUnits: bigint, owedWethWei: bigint, owedUsdcUnits: bigint, fairPriceUsdcPerWeth: number): number {
  const weth = Number(formatUnits(amountWethWei + owedWethWei, 18));
  const usdc = Number(formatUnits(amountUsdcUnits + owedUsdcUnits, 6));
  return usdc + weth * fairPriceUsdcPerWeth;
}
