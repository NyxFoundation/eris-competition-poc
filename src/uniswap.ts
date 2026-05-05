import {
  decodeFunctionResult,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient
} from "viem";
import { quoterV2Abi, poolAbi, swapRouterAbi } from "./abis.js";
import { ADDRESSES, WETH_USDC_FEE } from "./constants.js";
import type { AgentAction, TokenSymbol } from "./types.js";

export function tokenAddress(symbol: TokenSymbol): Address {
  return symbol === "WETH" ? ADDRESSES.weth : ADDRESSES.usdc;
}

export function oppositeToken(symbol: TokenSymbol): TokenSymbol {
  return symbol === "WETH" ? "USDC" : "WETH";
}

export async function getPoolPriceUsdcPerWeth(publicClient: PublicClient): Promise<number> {
  const [sqrtPriceX96] = await publicClient.readContract({
    address: ADDRESSES.uniswapV3PoolWethUsdc500,
    abi: poolAbi,
    functionName: "slot0"
  });
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const rawToken1PerToken0 = ratio * ratio;
  return 10 ** 12 / rawToken1PerToken0;
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
  action: AgentAction & { type: "swap" },
  slippageBps: number
): Promise<Hex> {
  const amountIn = BigInt(action.amountIn);
  const quoted = await quoteExactInput(publicClient, action.tokenIn, amountIn);
  const amountOutMinimum = (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
  return encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: tokenAddress(action.tokenIn),
        tokenOut: tokenAddress(oppositeToken(action.tokenIn)),
        fee: WETH_USDC_FEE,
        recipient,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n
      }
    ]
  });
}
