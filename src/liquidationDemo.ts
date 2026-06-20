// 清算デモ(GitHub #1)。ERIS_LIQUIDATION_DEMO=1 のときだけ coordinator から使う。
// victim ウォレットに過剰レバレッジの Aave ポジションを開かせ、shockRound 以降に Aave WETH
// オラクルを引き下げて HF<1 にし、liquidator agent が liquidationCall で清算できる状況を作る。
// 既定 off なので通常の run/テストには一切影響しない。
import {
  encodeFunctionData,
  keccak256,
  stringToBytes,
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

// ---------------------------------------------------------------------------
// realtime 一般化（ADR 0009 §4）: 清算を成立させる seed 由来 victim 群
//
// realtime（src/realtime/coordinator.ts）では同期 sim の applyOracleShock 後上書きは使わない。
// crash は effective price（base × wethMult）が Aave WETH オラクルへ mempool 経由で焼かれるため、
// victim の HF は自然に割れる（採点・PriceFeed と整合）。ここでは victim 群を setup フェーズで
// 建てるだけ（HF≈H0）。victim は採点対象外（liquidator agent の利益源）。
//
// 【ハード要件】full re-fork が必須: victim を毎 run 建てるため、soft-reset（anvil_reset []）だと
// 前 run の victim ポジが残留・スタックして HF 計算が壊れる（呼び側 coordinator が ARB_RPC_URL を
// 検査して fail-fast する）。
// ---------------------------------------------------------------------------

export type StressVictim = { id: string; privateKey: Hex; address: Address };

// seed 由来鍵の victim 群を導出（regime ごとに決定論再現。アドレスは seed で確定）。
export function deriveStressVictims(
  seed: number,
  count: number,
): StressVictim[] {
  const victims: StressVictim[] = [];
  for (let i = 0; i < count; i++) {
    const privateKey = keccak256(
      stringToBytes(`eris-stress-victim:${seed}:${i}`),
    );
    victims.push({
      id: `victim-${i}`,
      privateKey,
      address: accountAddress(privateKey),
    });
  }
  return victims;
}

// 各 victim に資金を入れ Aave Pool へ approve（setup フェーズで 1 回。interval mining 前）。
export async function setupStressVictims(
  ctx: SimContext,
  victims: StressVictim[],
): Promise<void> {
  const { publicClient, walletClient, chain, config } = ctx;
  for (const v of victims) {
    await fundWallet(
      publicClient,
      walletClient,
      chain,
      v.privateKey,
      1_000_000_000_000_000_000n, // 1 ETH(gas)
      config.stressVictimSupplyWethWei + 1_000_000_000_000_000_000n, // supply + buffer
      1_000_000n, // 1 USDC（端数。victim は USDC を借りるので初期在庫は不要）
    );
    for (const tx of [
      approveTx(TOKENS.WETH.address, AAVE.Pool),
      approveTx(AAVE_STABLE, AAVE.Pool),
    ]) {
      await sendAndMine(publicClient, walletClient, chain, v.privateKey, {
        to: tx.to,
        data: tx.data,
      });
    }
  }
}

// 各 victim が WETH を supply → 目標 HF（hf0）になるよう USDC を borrow する。
// 較正（ADR 0009 §4。自由パラメータではない）:
//   WETH 担保・USDC 債務の victim は HF = (W·P·LT)/D。目標債務 D* = C·LT/HF0 で建てると HF≈HF0。
//   crash 後の HF は HF0·(1−m) なので m > (HF0−1)/HF0 で清算。
//   ただし HF0 は LTV 上限（D ≤ C·LTV）を満たす必要があり HF0 > LT/LTV(≈1.04) でないと建てられない。
export async function openStressVictimPositions(
  ctx: SimContext,
  victims: StressVictim[],
  hf0: number,
): Promise<void> {
  const { publicClient, walletClient, chain, config } = ctx;
  const h0Bps = BigInt(Math.round(hf0 * 10_000));
  for (const v of victims) {
    await sendAndMine(publicClient, walletClient, chain, v.privateKey, {
      to: AAVE.Pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: "supply",
        args: [
          TOKENS.WETH.address,
          config.stressVictimSupplyWethWei,
          v.address,
          0,
        ],
      }),
    });
    const acc = (await publicClient.readContract({
      address: AAVE.Pool,
      abi: aavePoolAbi,
      functionName: "getUserAccountData",
      args: [v.address],
    })) as readonly bigint[];
    // acc: [totalCollateralBase, totalDebtBase, availableBorrowsBase,
    //       currentLiquidationThreshold(bps), ltv(bps), healthFactor(1e18)]（USD は 8 桁）
    const collateralUsd8 = acc[0];
    const availUsd8 = acc[2];
    const ltBps = acc[3];
    // 目標債務(USD8) = C·LT/HF0 → USDC(6桁)へ /1e2
    const targetUsdc = (collateralUsd8 * ltBps) / h0Bps / 100n;
    // LTV 上限（availableBorrowsBase）を 99% に抑えてクランプ（feasibility 保証）
    const maxUsdc = ((availUsd8 / 100n) * 99n) / 100n;
    const borrowUsdc = targetUsdc < maxUsdc ? targetUsdc : maxUsdc;
    if (borrowUsdc > 0n) {
      await sendAndMine(publicClient, walletClient, chain, v.privateKey, {
        to: AAVE.Pool,
        data: encodeFunctionData({
          abi: aavePoolAbi,
          functionName: "borrow",
          args: [AAVE_STABLE, borrowUsdc, VARIABLE_RATE, 0, v.address],
        }),
      });
    }
  }
}

export type VictimAccount = {
  id: string;
  address: Address;
  healthFactor: bigint; // 1e18 = 1.0
  totalCollateralBase: bigint; // USD 8 桁
  totalDebtBase: bigint; // USD 8 桁
};

// victim 群の口座状態を一括読取（HF / 担保 / 債務）。可視化・清算検知・stress 指標用。
export async function readVictimsAccount(
  ctx: SimContext,
  victims: StressVictim[],
): Promise<VictimAccount[]> {
  // 独立読取は batch transport が Multicall3/JSON-RPC batch に束ねる。
  const accounts = await Promise.all(
    victims.map(
      (v) =>
        ctx.publicClient.readContract({
          address: AAVE.Pool,
          abi: aavePoolAbi,
          functionName: "getUserAccountData",
          args: [v.address],
        }) as Promise<readonly bigint[]>,
    ),
  );
  return victims.map((v, i) => {
    const acc = accounts[i];
    return {
      id: v.id,
      address: v.address,
      healthFactor: acc[5],
      totalCollateralBase: acc[0],
      totalDebtBase: acc[1],
    };
  });
}
