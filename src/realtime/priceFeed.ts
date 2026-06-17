// fair price のオンチェーン配布（ADR 0006 §3）。
// 環境が専用 PriceFeed コントラクトをデプロイし、毎ブロック fair price を書き込む。
// agent は stdin push の代わりにこれを読む（書込 tx は次ブロック着弾なので情報は 1 ブロック遅れる。
// 全 agent に等しく作用するため公平性は保たれる — ADR 0006 §3 に明記済みの仕様）。
import {
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { sendNoMine } from "../chain.js";
import { deployContract } from "../protocols/deploy.js";
import type { SimContext } from "../protocols/types.js";

export const priceFeedAbi = [
  {
    type: "function",
    name: "setPrice",
    stateMutability: "nonpayable",
    inputs: [{ name: "answer", type: "int256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "latestAnswer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int256" }],
  },
] as const;

const PRICE_DECIMALS = 1e8; // USD 8 桁固定小数（Chainlink/Aave と同じ慣習）

export function toPriceFeedAnswer(price: number): bigint {
  return BigInt(Math.round(price * PRICE_DECIMALS));
}

export function fromPriceFeedAnswer(answer: bigint): number {
  return Number(answer) / PRICE_DECIMALS;
}

// 環境 setup で admin 鍵からデプロイ（owner=admin。agent は書き込めない）。
export async function deployPriceFeed(
  ctx: SimContext,
  initialPrice: number,
): Promise<Address> {
  return deployContract(ctx, "PriceFeed", [toPriceFeedAnswer(initialPrice)]);
}

// 単純な setter の固定 gas。明示して estimateGas（EVM 実行待ち）を省く。
const SETTER_GAS = 300_000n;

// 毎ブロックの fair price 書込（mempool submit。oracle と同じく agent 上限超の fee で先頭に置く）。
export async function updatePriceFeedMempool(
  ctx: SimContext,
  address: Address,
  fairPrice: number,
  priorityFeeWei: bigint,
): Promise<Hex> {
  return sendNoMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: address,
      data: encodeFunctionData({
        abi: priceFeedAbi,
        functionName: "setPrice",
        args: [toPriceFeedAnswer(fairPrice)],
      }),
      gas: SETTER_GAS,
    },
    priorityFeeWei,
  );
}

// agent / 再構成が読む fair price。blockNumber 指定で歴史ブロック断面も読める（ADR 0006 §4）。
export async function readFairPrice(
  publicClient: PublicClient,
  address: Address,
  blockNumber?: bigint,
): Promise<number> {
  const answer = (await publicClient.readContract({
    address,
    abi: priceFeedAbi,
    functionName: "latestAnswer",
    blockNumber,
  })) as bigint;
  return fromPriceFeedAnswer(answer);
}
