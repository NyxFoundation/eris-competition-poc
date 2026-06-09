/**
 * Aave + Uniswap 複合戦略エージェント
 *
 * - 価格差が小さい (< 0.15%) → 遊休 USDC を Aave に supply して利回りを稼ぐ
 * - 価格差が大きい (>= 0.15%) → Aave から withdraw して Uniswap で swap
 *
 * 外部 CLI 不要。viem + examples/lib/aave.ts + src/constants.ts(Arbitrum アドレス)で完結。
 */
import { createInterface } from "node:readline";
import { createPublicClient, encodeFunctionData, http } from "viem";
import { mainnet } from "viem/chains";
import { TOKENS, UNISWAP } from "../../src/constants.js";
import { buildAaveSupply, buildAaveWithdraw } from "../lib/aave.js";

const agentAddress = process.env.ERIS_AGENT_ADDRESS ?? "";
const rpcUrl = process.env.ERIS_RPC_URL ?? "";
if (!agentAddress || !rpcUrl) {
  process.stderr.write("ERIS_AGENT_ADDRESS and ERIS_RPC_URL are required\n");
  process.exit(1);
}

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(rpcUrl),
});

// sim は Arbitrum フォーク。アドレスは src/constants.ts の Arbitrum 値を使う
// （mainnet ハードコードだと raw tx が存在しないコントラクトに当たり機能しない）。
const SWAP_ROUTER = UNISWAP.swapRouter;
const WETH_ADDR = TOKENS.WETH.address;
const USDC_ADDR = TOKENS.USDC.address;
const QUOTER_V2 = UNISWAP.quoterV2;
const FEE = UNISWAP.fee;

const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
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
  },
] as const;

const swapRouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
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
  },
] as const;

async function buildSwapRawTx(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<{ to: string; data: string } | null> {
  try {
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
    const amountOutMin = (result[0] * 9950n) / 10000n;
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
          amountOutMinimum: amountOutMin,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return { to: SWAP_ROUTER, data };
  } catch (error) {
    process.stderr.write(`swap build failed: ${error}\n`);
    return null;
  }
}

type RawTx = { to: string; data: string; value?: string };

let suppliedUsdc = 0;

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  try {
    const obs = JSON.parse(line);
    // プール価格は protocols.uniswap.pool 配下。uniswap が無効なら裁定できないので noop。
    const poolPrice: number | undefined =
      obs.protocols?.uniswap?.pool?.priceUsdcPerWeth;
    const fairPrice: number = obs.fairPriceUsdcPerWeth;
    if (typeof poolPrice !== "number" || !(poolPrice > 0)) {
      process.stdout.write(
        `${JSON.stringify({ type: "noop", reason: "uniswap pool price unavailable" })}\n`,
      );
      return;
    }
    const gap = fairPrice / poolPrice - 1;
    const absGap = Math.abs(gap);
    const usdcBalance = Number(BigInt(obs.balances.usdcUnits)) / 1e6;

    // 価格差が小さい → Aave に USDC を供給
    if (absGap < 0.0015) {
      const supplyAmount = Math.floor(usdcBalance * 0.5);
      if (supplyAmount < 10) {
        process.stdout.write(
          `${JSON.stringify({ type: "noop", reason: "gap small, insufficient USDC to supply" })}\n`,
        );
        return;
      }

      const txs = buildAaveSupply("USDC", supplyAmount, agentAddress);
      suppliedUsdc += supplyAmount;
      process.stdout.write(
        `${JSON.stringify({
          type: "rawBundle",
          txs,
          maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
        })}\n`,
      );
      return;
    }

    // 価格差が大きい → Aave から withdraw して swap
    const allTxs: RawTx[] = [];

    if (suppliedUsdc > 0) {
      allTxs.push(buildAaveWithdraw("USDC", -1, agentAddress));
      suppliedUsdc = 0;
    }

    // Swap
    const tokenInAddr = gap > 0 ? USDC_ADDR : WETH_ADDR;
    const tokenOutAddr = gap > 0 ? WETH_ADDR : USDC_ADDR;
    const maxLimit = BigInt(
      tokenInAddr === WETH_ADDR
        ? obs.limits.maxWethInWei
        : obs.limits.maxUsdcInUnits,
    );
    const sizeBps = Math.min(2500, Math.max(250, Math.floor(absGap * 200_000)));
    const amountIn = (maxLimit * BigInt(sizeBps)) / 10_000n;

    if (amountIn <= 0n) {
      process.stdout.write(
        `${JSON.stringify({ type: "noop", reason: "computed swap amount is zero" })}\n`,
      );
      return;
    }

    const swapTx = await buildSwapRawTx(tokenInAddr, tokenOutAddr, amountIn);
    if (!swapTx) {
      if (allTxs.length > 0) {
        process.stdout.write(
          `${JSON.stringify({
            type: allTxs.length === 1 ? "rawTx" : "rawBundle",
            ...(allTxs.length === 1 ? { tx: allTxs[0] } : { txs: allTxs }),
            maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
          })}\n`,
        );
        return;
      }
      process.stdout.write(
        `${JSON.stringify({ type: "noop", reason: "swap build failed" })}\n`,
      );
      return;
    }

    allTxs.push(swapTx);

    if (allTxs.length === 1) {
      process.stdout.write(
        `${JSON.stringify({
          type: "rawTx",
          tx: allTxs[0],
          maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
        })}\n`,
      );
    } else {
      process.stdout.write(
        `${JSON.stringify({
          type: "rawBundle",
          txs: allTxs,
          maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
        })}\n`,
      );
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: `error: ${error}` })}\n`,
    );
  }
});
