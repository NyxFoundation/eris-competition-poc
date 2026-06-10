import { encodeFunctionData, type Hex } from "viem";
import { TOKENS } from "../constants.js";
import { sendAndMine, sendNoMine } from "../chain.js";
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
