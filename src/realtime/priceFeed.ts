// fair price のオンチェーン配布（ADR 0006 §3）。
// 環境が専用 PriceFeed コントラクトをデプロイし、毎ブロック fair price を書き込む。
// agent は stdin push の代わりにこれを読む（書込 tx は次ブロック着弾なので情報は 1 ブロック遅れる。
// 全 agent に等しく作用するため公平性は保たれる — ADR 0006 §3 に明記済みの仕様）。
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { bigintToStorageWord, sendNoMine, setStorageAt } from "../chain.js";
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
  // ADR 0013: 追加 base（WBTC 等）の per-asset 価格。WETH は上の setPrice/latestAnswer を使う。
  {
    type: "function",
    name: "setPriceFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "answer", type: "int256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "answerOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
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

// PriceFeed.sol のストレージ slot。`address public immutable owner` は immutable のため
// バイトコードに格納され slot を消費しない → `int256 private _answer` = slot 0、
// `uint256 private _updatedAtBlock` = slot 1（`uint8 public constant decimals` も slot を消費しない）。
const ANSWER_SLOT = `0x${"0".repeat(64)}` as Hex;
const UPDATED_AT_BLOCK_SLOT = `0x${"0".repeat(63)}1` as Hex;

// ADR 0011 §1: fair price を mempool tx でなく PriceFeed の storage へ直接書く（cheatcode）。
// 価格は block 境界で storage に在るため block 内に env の price tx が無く、agent が
// front-run する対象が機構的に消える（priority-fee 上限に依存しない順序保証）。価格配布は env
// 機構であり agent 動作ではないため cheatcode 利用は現実性を毀損しない。agent の読み口
// （readFairPrice = latestAnswer）は不変なので体験・submission 互換は変わらない。
export async function writePriceFeedStorage(
  publicClient: PublicClient,
  address: Address,
  fairPrice: number,
  blockNumber: bigint,
): Promise<void> {
  await setStorageAt(
    publicClient,
    address,
    ANSWER_SLOT,
    bigintToStorageWord(toPriceFeedAnswer(fairPrice)),
  );
  await setStorageAt(
    publicClient,
    address,
    UPDATED_AT_BLOCK_SLOT,
    bigintToStorageWord(blockNumber),
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

// ---------------------------------------------------------------------------
// ADR 0013: 追加 base（WBTC 等）の価格配布。WETH は上の WETH 専用 API を使い続ける。
// ---------------------------------------------------------------------------

// 追加 base の mempool 書込（setPriceFor）。WETH は updatePriceFeedMempool を使う。
export async function updatePriceFeedForMempool(
  ctx: SimContext,
  address: Address,
  token: Address,
  price: number,
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
        functionName: "setPriceFor",
        args: [token, toPriceFeedAnswer(price)],
      }),
      gas: SETTER_GAS,
    },
    priorityFeeWei,
  );
}

// _answers(slot 2) / _answerUpdatedAtBlock(slot 3) の mapping 要素 slot = keccak256(token ++ mapSlot)。
function answerSlotFor(token: Address, mapSlot: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [token, mapSlot],
    ),
  );
}

// ADR 0011 §1 と同様の storage 直書きを追加 base にも適用（mapping slot 2/3）。
export async function writePriceFeedStorageFor(
  publicClient: PublicClient,
  address: Address,
  token: Address,
  price: number,
  blockNumber: bigint,
): Promise<void> {
  await setStorageAt(
    publicClient,
    address,
    answerSlotFor(token, 2n),
    bigintToStorageWord(toPriceFeedAnswer(price)),
  );
  await setStorageAt(
    publicClient,
    address,
    answerSlotFor(token, 3n),
    bigintToStorageWord(blockNumber),
  );
}

// 追加 base の fair price を読む（answerOf）。WETH は readFairPrice(latestAnswer)。
export async function readFairPriceFor(
  publicClient: PublicClient,
  address: Address,
  token: Address,
  blockNumber?: bigint,
): Promise<number> {
  const answer = (await publicClient.readContract({
    address,
    abi: priceFeedAbi,
    functionName: "answerOf",
    args: [token],
    blockNumber,
  })) as bigint;
  return fromPriceFeedAnswer(answer);
}
