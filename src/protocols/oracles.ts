import { encodeFunctionData } from "viem";
import { TOKENS } from "../constants.js";
import { sendAndMine } from "../chain.js";
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
