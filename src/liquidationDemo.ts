// 清算デモ(GitHub #1)。ERIS_LIQUIDATION_DEMO=1 のときだけ coordinator から使う。
// victim ウォレットに過剰レバレッジの Aave ポジションを開かせ、shockRound 以降に Aave WETH
// オラクルを引き下げて HF<1 にし、liquidator agent が liquidationCall で清算できる状況を作る。
// 既定 off なので通常の run/テストには一切影響しない。
import {
  encodeFunctionData,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { accountAddress, fundWallet, mine, sendAndMine } from "./chain.js";
import { AAVE, TOKENS } from "./constants.js";
import {
  aavePoolAbi,
  mockAggregatorAbi,
  toAavePrice,
} from "./protocols/aave.js";
import { approveTx } from "./protocols/uniswap.js";
import type { SimContext } from "./protocols/types.js";

const AAVE_STABLE = TOKENS.USDC.address;
const VARIABLE_RATE = 2n;

// デモ用の固定鍵。アドレスが既知なので liquidator の env(ERIS_LIQUIDATION_VICTIMS)に
// ハードコード(既定値)できる。seed 非依存でよい(デモ専用・env gate 済み)。
export const VICTIM_PRIVATE_KEY: Hex = keccak256(
  toBytes("eris-liquidation-victim-v1"),
);
export const VICTIM_ADDRESS: Address = accountAddress(VICTIM_PRIVATE_KEY);

// victim に資金を入れ Aave Pool へ approve(setup フェーズで 1 回)。
export async function setupVictim(ctx: SimContext): Promise<void> {
  const { publicClient, walletClient, chain, config } = ctx;
  await fundWallet(
    publicClient,
    walletClient,
    chain,
    VICTIM_PRIVATE_KEY,
    1_000_000_000_000_000_000n, // 1 ETH (gas)
    config.liquidationVictimSupplyWethWei + 1_000_000_000_000_000_000n, // supply + buffer
    1_000_000n, // 1 USDC(端数)
  );
  for (const tx of [
    approveTx(TOKENS.WETH.address, AAVE.Pool),
    approveTx(AAVE_STABLE, AAVE.Pool),
  ]) {
    await sendAndMine(publicClient, walletClient, chain, VICTIM_PRIVATE_KEY, {
      to: tx.to,
      data: tx.data,
    });
  }
}

// victim が WETH を supply → 借入余力ほぼ満額の USDC を borrow(HF を 1 付近に置く)。
export async function openVictimPosition(ctx: SimContext): Promise<void> {
  const { publicClient, walletClient, chain, config } = ctx;
  await sendAndMine(publicClient, walletClient, chain, VICTIM_PRIVATE_KEY, {
    to: AAVE.Pool,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "supply",
      args: [
        TOKENS.WETH.address,
        config.liquidationVictimSupplyWethWei,
        VICTIM_ADDRESS,
        0,
      ],
    }),
  });
  const acc = (await publicClient.readContract({
    address: AAVE.Pool,
    abi: aavePoolAbi,
    functionName: "getUserAccountData",
    args: [VICTIM_ADDRESS],
  })) as readonly bigint[];
  // availableBorrowsBase は USD 8 桁。USDC(6 桁)へ: /1e2。安全側に 99%。
  const borrowUsdc = (acc[2] * 99n) / 10_000n;
  if (borrowUsdc > 0n) {
    await sendAndMine(publicClient, walletClient, chain, VICTIM_PRIVATE_KEY, {
      to: AAVE.Pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: "borrow",
        args: [AAVE_STABLE, borrowUsdc, VARIABLE_RATE, 0, VICTIM_ADDRESS],
      }),
    });
  }
}

// Aave WETH オラクルを fairPrice から shockBps 分だけ引き下げて victim を HF<1 にする。
// updateOracles が毎ラウンド fairPrice に戻すため、その直後に上書きする。
export async function applyOracleShock(
  ctx: SimContext,
  fairPrice: number,
): Promise<void> {
  const agg = ctx.oracle.aaveAggregators[TOKENS.WETH.address.toLowerCase()];
  if (!agg) return;
  const shocked = fairPrice * (1 - ctx.config.liquidationShockBps / 10_000);
  await sendAndMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: agg,
      data: encodeFunctionData({
        abi: mockAggregatorAbi,
        functionName: "setAnswer",
        args: [toAavePrice(shocked)],
      }),
    },
  );
  await mine(ctx.publicClient);
}

// victim の現在 HF(1e18 = 1.0)。可視化用。
export async function victimHealthFactor(ctx: SimContext): Promise<bigint> {
  const acc = (await ctx.publicClient.readContract({
    address: AAVE.Pool,
    abi: aavePoolAbi,
    functionName: "getUserAccountData",
    args: [VICTIM_ADDRESS],
  })) as readonly bigint[];
  return acc[5];
}
