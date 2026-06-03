// dn-lp: Uniswap V3 で LP を mint し、その WETH エクスポージャを GMX short でヘッジする
// デルタニュートラル戦略。GMX は bundle 不可のため、LP の mint と GMX short をラウンドをまたいだ
// 状態機械で順に確立する。
//   State A: LP 未保有        → mintLiquidity(現在 tick 中心レンジ)
//   State B: LP 有り/short 無し → LP の WETH 評価額相当を gmxIncrease short でヘッジ
//   State C: 両方確立済み      → noop(維持)
//
// 注記: 完全なデルタ中立計算ではなく、LP ポジションの amountWethWei 合計から概算ヘッジサイズを
// 算出する簡略版。
//
// env:
//   HEDGE_FRACTION  ヘッジ比率 (default 1.0 = フルヘッジ)
import { createInterface } from "node:readline";
import { createEmitter } from "./lib/agentLog.js";

const HEDGE_FRACTION = Number(process.env.HEDGE_FRACTION ?? "1.0");
const SIZE_1E30 = 10n ** 30n;

const emit = createEmitter();

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const round = obs.round;
  const signals: Record<string, number> = {};
  const state: Record<string, unknown> = {};
  const uni = obs.protocols?.uniswap;
  const gmx = obs.protocols?.gmx;
  const fee = obs.limits.defaultPriorityFeePerGasWei;
  if (!uni?.pool) {
    emit(
      { type: "noop", reason: "uniswap disabled" },
      { round, signals, state },
    );
    return;
  }
  signals.positions = uni.positions?.length ?? 0;
  signals.tick = uni.pool.tick;
  signals.fair = obs.fairPriceUsdcPerWeth;
  state.hasGmx = !!gmx;

  // State A: LP が無ければ現在 tick 中心のレンジに mint
  if ((uni.positions?.length ?? 0) === 0) {
    state.phase = "A:mint-lp";
    const spacing = uni.pool.tickSpacing;
    const center = Math.floor(uni.pool.tick / spacing) * spacing;
    emit(
      {
        type: "mintLiquidity",
        tickLower: center - spacing * 20,
        tickUpper: center + spacing * 20,
        amountWethDesired: (BigInt(obs.limits.maxLpWethWei) / 2n).toString(),
        amountUsdcDesired: (BigInt(obs.limits.maxLpUsdcUnits) / 2n).toString(),
        maxPriorityFeePerGasWei: fee,
        slippageBps: 100,
      },
      { round, signals, state },
    );
    return;
  }

  // GMX が無効ならヘッジ不可。LP のみで維持。
  if (!gmx) {
    emit(
      { type: "noop", reason: "lp held (gmx disabled, no hedge)" },
      { round, signals, state },
    );
    return;
  }

  // State B: LP の WETH エクスポージャ相当を short でヘッジ
  if (!gmx.position) {
    state.phase = "B:hedge-short";
    const totalWethWei = (uni.positions as Array<{ amountWethWei: string }>)
      .map((p) => BigInt(p.amountWethWei ?? "0"))
      .reduce((a, b) => a + b, 0n);
    const wethEth = Number(totalWethWei) / 1e18;
    const marketPrice = gmx.marketPriceUsd;
    if (wethEth <= 0 || !Number.isFinite(marketPrice) || marketPrice <= 0) {
      emit(
        { type: "noop", reason: "no exposure to hedge" },
        { round, signals, state },
      );
      return;
    }
    const notionalUsd = wethEth * marketPrice * HEDGE_FRACTION;
    const sizeUsd = clampSizeUsd(notionalUsd, obs.limits.maxGmxSizeUsd);
    // collateral は USDC。約 2x レバレッジになるよう notional の半分を担保に。
    const collateralUsdc = clampUsdc(
      BigInt(Math.max(0, Math.round((notionalUsd / 2) * 1e6))),
      obs.limits.maxUsdcInUnits,
    );
    emit(
      {
        type: "gmxIncrease",
        isLong: false,
        collateral: "USDC",
        collateralAmount: collateralUsdc.toString(),
        sizeDeltaUsd: sizeUsd.toString(),
        maxPriorityFeePerGasWei: fee,
      },
      { round, signals, state },
    );
    return;
  }

  // State C: LP + short ヘッジ確立済み
  state.phase = "C:delta-neutral";
  emit(
    { type: "noop", reason: "delta-neutral established" },
    { round, signals, state },
  );
});

function clampSizeUsd(usd: number, maxStr: string): bigint {
  const size = BigInt(Math.max(0, Math.round(usd))) * SIZE_1E30;
  const max = BigInt(maxStr);
  return size > max ? max : size;
}

function clampUsdc(units: bigint, maxStr: string): bigint {
  const max = BigInt(maxStr);
  return units > max ? max : units;
}
