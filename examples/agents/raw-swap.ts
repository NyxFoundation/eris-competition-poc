import { createInterface } from "node:readline";
import { createPublicClient, encodeFunctionData, http } from "viem";
import { arbitrum } from "viem/chains";

// Arbitrum One アドレス
const SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const FEE = 500;

const rpcUrl = process.env.ERIS_RPC_URL;
const agentAddress = process.env.ERIS_AGENT_ADDRESS;
if (!rpcUrl || !agentAddress) {
  process.stderr.write("ERIS_RPC_URL and ERIS_AGENT_ADDRESS are required\n");
  process.exit(1);
}

const publicClient = createPublicClient({
  chain: arbitrum,
  transport: http(rpcUrl),
});

const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
] as const;

const swapRouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
  },
] as const;

const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

async function quoteExactInput(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const { result } = await publicClient.simulateContract({
    address: QUOTER_V2 as `0x${string}`,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: tokenIn as `0x${string}`,
        tokenOut: tokenOut as `0x${string}`,
        amountIn,
        fee: FEE,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return result[0];
}

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  try {
    const observation = JSON.parse(line);
    const pool = observation.protocols.uniswap.pool.priceUsdcPerWeth;
    const fair = observation.fairPriceUsdcPerWeth;
    const gap = fair / pool - 1;

    if (Math.abs(gap) < 0.0015) {
      process.stdout.write(
        `${JSON.stringify({ type: "noop", reason: "gap too small" })}\n`,
      );
      return;
    }

    const tokenIn = gap > 0 ? USDC : WETH;
    const tokenOut = gap > 0 ? WETH : USDC;
    const max = BigInt(
      tokenIn === WETH
        ? observation.limits.maxWethInWei
        : observation.limits.maxUsdcInUnits,
    );
    const sizeBps = Math.min(
      2500,
      Math.max(250, Math.floor(Math.abs(gap) * 200_000)),
    );
    const amountIn = (max * BigInt(sizeBps)) / 10_000n;

    const quoted = await quoteExactInput(tokenIn, tokenOut, amountIn);
    const amountOutMinimum = (quoted * 9950n) / 10000n; // 50 bps slippage

    const data = encodeFunctionData({
      abi: swapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: tokenIn as `0x${string}`,
          tokenOut: tokenOut as `0x${string}`,
          fee: FEE,
          recipient: agentAddress as `0x${string}`,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
          amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    process.stdout.write(
      `${JSON.stringify({
        type: "rawTx",
        tx: { to: SWAP_ROUTER, data },
        maxPriorityFeePerGasWei: observation.limits.defaultPriorityFeePerGasWei,
      })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: `error: ${error}` })}\n`,
    );
  }
});
