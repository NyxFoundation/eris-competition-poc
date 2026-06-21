import { encodeFunctionData, type Hex } from "viem";
import { TOKENS } from "../constants.js";
import {
  bigintToStorageWord,
  sendAndMine,
  sendNoMine,
  setStorageAt,
} from "../chain.js";
import type { SimContext } from "./types.js";
import { mockAggregatorAbi, toAavePrice } from "./aave.js";

// 毎ラウンド先頭で GMX/Aave の mock 価格を fairPrice に追従させる。
// 価格更新は coordinator 特権 tx（競争ブロックとは別ブロック）で行う。
export async function updateOracles(
  ctx: SimContext,
  fairPrice: number,
): Promise<boolean> {
  let wrote = false;

  // Aave: MockAggregator.setAnswer（USD 8 桁）
  const wethAgg = ctx.oracle.aaveAggregators[TOKENS.WETH.address.toLowerCase()];
  const usdcAgg = ctx.oracle.aaveAggregators[TOKENS.USDC.address.toLowerCase()];
  if (wethAgg) {
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: wethAgg,
        data: encodeFunctionData({
          abi: mockAggregatorAbi,
          functionName: "setAnswer",
          args: [toAavePrice(fairPrice)],
        }),
      },
    );
    wrote = true;
  }
  if (usdcAgg) {
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: usdcAgg,
        data: encodeFunctionData({
          abi: mockAggregatorAbi,
          functionName: "setAnswer",
          args: [toAavePrice(1)],
        }),
      },
    );
    wrote = true;
  }

  // GMX: MockOracleProvider.setPrice（Phase 5 で gmx モジュールが拡張）
  if (ctx.oracle.gmxProvider && ctx.updateGmxOracle) {
    await ctx.updateGmxOracle(ctx, fairPrice);
    wrote = true;
  }

  return wrote;
}

// 単純な setter の固定 gas。明示して estimateGas（EVM 実行待ち）を省く。
const SETTER_GAS = 300_000n;

// 実時間モード用：oracle 更新を mine せず mempool へ submit する。interval mining 下で
// 次ブロックに取り込まれる。priorityFeeWei は agent 上限超を渡し、--order fees により
// oracle 更新が agent より前（txIndex 0 付近）に来るようにする。提出した tx hash を返す。
export async function updateOraclesMempool(
  ctx: SimContext,
  fairPrice: number,
  priorityFeeWei: bigint,
): Promise<Hex[]> {
  const hashes: Hex[] = [];
  const wethAgg = ctx.oracle.aaveAggregators[TOKENS.WETH.address.toLowerCase()];
  const usdcAgg = ctx.oracle.aaveAggregators[TOKENS.USDC.address.toLowerCase()];
  if (wethAgg) {
    hashes.push(
      await sendNoMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        ctx.adminPk,
        {
          to: wethAgg,
          data: encodeFunctionData({
            abi: mockAggregatorAbi,
            functionName: "setAnswer",
            args: [toAavePrice(fairPrice)],
          }),
          gas: SETTER_GAS,
        },
        priorityFeeWei,
      ),
    );
  }
  if (usdcAgg) {
    hashes.push(
      await sendNoMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        ctx.adminPk,
        {
          to: usdcAgg,
          data: encodeFunctionData({
            abi: mockAggregatorAbi,
            functionName: "setAnswer",
            args: [toAavePrice(1)],
          }),
          gas: SETTER_GAS,
        },
        priorityFeeWei,
      ),
    );
  }
  if (ctx.oracle.gmxProvider && ctx.updateGmxOracle) {
    // GMX は内部で2本（WETH/USDC）submit する。hash は追えないが mempool には載る。
    await ctx.updateGmxOracle(ctx, fairPrice, { noMine: true, priorityFeeWei });
  }
  return hashes;
}

// MockAggregator.sol のストレージ slot。`int256 private _answer` = slot 0
// （`uint8 public constant decimals` は slot を消費せず、_roundId/_updatedAt は slot1/2 だが
// AaveOracle.getAssetPrice は latestAnswer() のみ参照するため answer 直書きで十分）。
const AGG_ANSWER_SLOT = `0x${"0".repeat(64)}` as Hex;

// ADR 0011 §1: Aave WETH/USDC オラクル価格を mempool tx でなく storage 直書きで確定する。
// PriceFeed と同じく block 境界で在るため front-run 対象が消え、priority-fee 上限に依存しない。
// 経済化プロファイル（economicGas）でのみ使う。aggregator 未デプロイ（aave 無効）なら no-op。
export async function writeAaveOraclesStorage(
  ctx: SimContext,
  fairPrice: number,
): Promise<void> {
  const wethAgg = ctx.oracle.aaveAggregators[TOKENS.WETH.address.toLowerCase()];
  const usdcAgg = ctx.oracle.aaveAggregators[TOKENS.USDC.address.toLowerCase()];
  if (wethAgg) {
    await setStorageAt(
      ctx.publicClient,
      wethAgg,
      AGG_ANSWER_SLOT,
      bigintToStorageWord(toAavePrice(fairPrice)),
    );
  }
  if (usdcAgg) {
    await setStorageAt(
      ctx.publicClient,
      usdcAgg,
      AGG_ANSWER_SLOT,
      bigintToStorageWord(toAavePrice(1)),
    );
  }
}
