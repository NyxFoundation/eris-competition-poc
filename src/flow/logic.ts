// orderflow 生成の純粋ロジック。
//
// 以前は各 ProtocolAdapter.buildFlow に分散していたが、orderflow を独立プロセス
// (examples/flow/market-maker.ts) に切り出すため、RPC に触れない純粋関数として集約した。
// coordinator は flow ウォレットと tx 提出を引き続き所有し、bot は「どの注文を出すか」だけ決める。
//
// 決定論: bot は自前の Rng(flowSeed) を持ち、ここの関数を coordinator が渡す
// protocols 順（= enabledAdapters 順。既定は config.ALL_PROTOCOLS の
// uniswap, balancer, curve, gmx, aave で gmx が aave より前）で呼ぶ。
// 元の buildFlowIntents と RNG 消費順序を一致させるため、ロジックは旧 adapter から逐語移設している。
import type { Rng } from "../rng.js";
import type { LeafAction, ProtocolId, TokenSymbol } from "../types.js";
import type { FlowKind, FlowOrder } from "../protocols/types.js";

const FLOW_SLIPPAGE_BPS = 100;

// coordinator が文字列で渡す flow 関連の上限値（bigint 復元後の形）。
export type FlowLimits = {
  uninformedFlowMaxWethWei: bigint;
  informedFlowMaxWethWei: bigint;
  balancerFlowMaxWethWei: bigint;
  curveFlowMaxWethWei: bigint;
  gmxFlowMaxSizeUsd: bigint;
  aaveFlowMaxWethWei: bigint;
  maxAaveBorrowUsdcUnits: bigint;
  defaultPriorityFeeWei: bigint;
};

// FlowContext の wire 形（JSON。bigint は文字列）。
export type FlowContextWire = {
  round: number;
  fairPriceUsdcPerWeth: number;
  protocols: ProtocolId[];
  poolPrices: Partial<Record<"uniswap" | "balancer" | "curve", number>>;
  aaveReserves?: { wethSupplied: string; usdcBorrowed: string };
  limits: {
    uninformedFlowMaxWethWei: string;
    informedFlowMaxWethWei: string;
    balancerFlowMaxWethWei: string;
    curveFlowMaxWethWei: string;
    gmxFlowMaxSizeUsd: string;
    aaveFlowMaxWethWei: string;
    maxAaveBorrowUsdcUnits: string;
    defaultPriorityFeeWei: string;
  };
};

// bot が返す 1 注文（protocol タグ付き。coordinator が flow ウォレットを選ぶのに使う）。
export type FlowOrderOut = {
  protocol: ProtocolId;
  kind: FlowKind;
  action: LeafAction;
  priorityFeeWei: bigint;
};

function randomBigInt(
  rng: Rng,
  minInclusive: bigint,
  maxInclusive: bigint,
): bigint {
  const span = maxInclusive - minInclusive + 1n;
  return (
    minInclusive +
    (BigInt(Math.floor(rng.next() * 1_000_000)) * span) / 1_000_000n
  );
}

// AMM (uniswap/balancer/curve) の flow。uninformed ノイズ + informed(価格を fair に寄せる)。
export function buildAmmFlow(
  rng: Rng,
  protocol: "uniswap" | "balancer" | "curve",
  poolPrice: number,
  fairPrice: number,
  uninformedMaxWethWei: bigint,
  informedMaxWethWei: bigint,
  defaultPriorityFeeWei: bigint,
): FlowOrder[] {
  const orders: FlowOrder[] = [];
  const swapType =
    protocol === "uniswap"
      ? "swap"
      : protocol === "balancer"
        ? "balancerSwap"
        : "curveSwap";

  // uninformed
  const uninformedTokenIn: TokenSymbol = rng.bool() ? "WETH" : "USDC";
  const uninformedAmount =
    uninformedTokenIn === "WETH"
      ? randomBigInt(rng, uninformedMaxWethWei / 20n, uninformedMaxWethWei)
      : randomBigInt(rng, 100_000_000n, 2_500_000_000n);
  orders.push({
    kind: "uninformed",
    action: {
      type: swapType,
      tokenIn: uninformedTokenIn,
      amountIn: uninformedAmount.toString(),
      slippageBps: FLOW_SLIPPAGE_BPS,
    } as LeafAction,
    priorityFeeWei: defaultPriorityFeeWei + BigInt(rng.int(1, 50)) * 1_000_000n,
  });

  // informed: pool 価格を fairPrice に寄せる
  const informedTokenIn: TokenSymbol = poolPrice < fairPrice ? "USDC" : "WETH";
  const gap = Math.min(1, Math.abs(fairPrice / poolPrice - 1) * 20);
  const informedAmount =
    informedTokenIn === "WETH"
      ? (informedMaxWethWei * BigInt(Math.max(1, Math.floor(gap * 100)))) / 100n
      : BigInt(Math.max(100_000_000, Math.floor(gap * 5_000_000_000)));
  orders.push({
    kind: "informed",
    action: {
      type: swapType,
      tokenIn: informedTokenIn,
      amountIn: informedAmount.toString(),
      slippageBps: FLOW_SLIPPAGE_BPS,
    } as LeafAction,
    priorityFeeWei:
      defaultPriorityFeeWei + BigInt(rng.int(50, 100)) * 1_000_000n,
  });

  return orders;
}

// GMX perp orderflow: 小口のロング/ショートを開いて約定ボリュームを作る（keeper が約定）。
export function buildGmxFlow(
  rng: Rng,
  gmxFlowMaxSizeUsd: bigint,
  defaultPriorityFeeWei: bigint,
): FlowOrder[] {
  if (!rng.bool()) return []; // 約半数のラウンドは見送り（OI 過剰・実行負荷を抑制）
  const isLong = rng.bool();
  // size は gmxFlowMaxSizeUsd の 1/50 を基準（約 2x になるよう担保を size/2x で算出）
  const sizeUsd = gmxFlowMaxSizeUsd / 50n;
  // collateral(WETH wei) ≈ (sizeUsd/2) を USD->WETH 換算。oraclePrices は使えないため概算 fairPrice 相当で割る
  const sizeUsdNum = Number(sizeUsd) / 1e30;
  const collateralWei = BigInt(
    Math.max(1, Math.floor(((sizeUsdNum / 2) * 1e18) / 2100)),
  );
  const fee = defaultPriorityFeeWei + BigInt(rng.int(1, 60)) * 1_000_000n;
  const action = {
    type: "gmxIncrease",
    isLong,
    collateral: "WETH",
    collateralAmount: collateralWei.toString(),
    sizeDeltaUsd: sizeUsd.toString(),
  } as unknown as LeafAction;
  return [{ kind: "uninformed", action, priorityFeeWei: fee }];
}

// Aave: supply/borrow/repay の churn を生成し HF を動かす。
// 旧実装は flow ウォレットの reserve を RPC で読んでいたが、その読取は coordinator 側に移し、
// 結果を reserves 引数で受け取ることで純粋化した。
export function buildAaveFlow(
  rng: Rng,
  aaveFlowMaxWethWei: bigint,
  maxAaveBorrowUsdcUnits: bigint,
  defaultPriorityFeeWei: bigint,
  reserves: { wethSupplied: bigint; usdcBorrowed: bigint },
): FlowOrder[] {
  const fee = defaultPriorityFeeWei + BigInt(rng.int(1, 40)) * 1_000_000n;

  // 状態機械: supply -> (borrow <-> repay を反復) -> 債務0のとき確率で withdraw。
  //   - withdraw は borrowed===0 のときのみ（債務未返済での withdraw revert を回避）
  //   - 債務があれば必ず repay max（flow walletは初期USDCも保有するため利息込みで完済でき端数ループを回避）
  let action: LeafAction;
  if (reserves.wethSupplied === 0n) {
    const amount = aaveFlowMaxWethWei / 2n;
    action = {
      type: "aaveSupply",
      asset: "WETH",
      amount: amount.toString(),
    } as unknown as LeafAction;
  } else if (reserves.usdcBorrowed > 0n) {
    action = {
      type: "aaveRepay",
      asset: "USDC",
      amount: "max",
    } as unknown as LeafAction;
  } else if (rng.bool()) {
    // 債務0 → borrow（maxAaveBorrowUsdcUnits を尊重）
    const amount = maxAaveBorrowUsdcUnits / 5n;
    action = {
      type: "aaveBorrow",
      asset: "USDC",
      amount: (amount > 0n ? amount : 100_000_000n).toString(),
    } as unknown as LeafAction;
  } else {
    // 債務0 → 担保を引き上げてサイクルを閉じる
    action = {
      type: "aaveWithdraw",
      asset: "WETH",
      amount: "max",
    } as unknown as LeafAction;
  }
  return [{ kind: "informed", action, priorityFeeWei: fee }];
}

// wire の文字列 limits を bigint へ復元。
export function decodeFlowLimits(wire: FlowContextWire["limits"]): FlowLimits {
  return {
    uninformedFlowMaxWethWei: BigInt(wire.uninformedFlowMaxWethWei),
    informedFlowMaxWethWei: BigInt(wire.informedFlowMaxWethWei),
    balancerFlowMaxWethWei: BigInt(wire.balancerFlowMaxWethWei),
    curveFlowMaxWethWei: BigInt(wire.curveFlowMaxWethWei),
    gmxFlowMaxSizeUsd: BigInt(wire.gmxFlowMaxSizeUsd),
    aaveFlowMaxWethWei: BigInt(wire.aaveFlowMaxWethWei),
    maxAaveBorrowUsdcUnits: BigInt(wire.maxAaveBorrowUsdcUnits),
    defaultPriorityFeeWei: BigInt(wire.defaultPriorityFeeWei),
  };
}

// FlowContext から 1 ラウンド分の全注文を生成する。
// protocols は coordinator が渡す順（既定 uniswap, balancer, curve, gmx, aave）で反復し、その順で RNG を消費する。
export function buildFlowOrders(
  rng: Rng,
  ctx: FlowContextWire,
): FlowOrderOut[] {
  const limits = decodeFlowLimits(ctx.limits);
  const out: FlowOrderOut[] = [];
  const tag = (protocol: ProtocolId, orders: FlowOrder[]): void => {
    for (const o of orders) out.push({ protocol, ...o });
  };

  // AMM (uniswap/balancer/curve) ごとの [uninformedMax, informedMax]。
  // balancer/curve は単一上限を両方に使う。
  const ammMax: Record<"uniswap" | "balancer" | "curve", [bigint, bigint]> = {
    uniswap: [limits.uninformedFlowMaxWethWei, limits.informedFlowMaxWethWei],
    balancer: [limits.balancerFlowMaxWethWei, limits.balancerFlowMaxWethWei],
    curve: [limits.curveFlowMaxWethWei, limits.curveFlowMaxWethWei],
  };

  for (const protocol of ctx.protocols) {
    if (
      protocol === "uniswap" ||
      protocol === "balancer" ||
      protocol === "curve"
    ) {
      const [uninformedMax, informedMax] = ammMax[protocol];
      tag(
        protocol,
        buildAmmFlow(
          rng,
          protocol,
          ctx.poolPrices[protocol] ?? ctx.fairPriceUsdcPerWeth,
          ctx.fairPriceUsdcPerWeth,
          uninformedMax,
          informedMax,
          limits.defaultPriorityFeeWei,
        ),
      );
    } else if (protocol === "aave") {
      tag(
        "aave",
        buildAaveFlow(
          rng,
          limits.aaveFlowMaxWethWei,
          limits.maxAaveBorrowUsdcUnits,
          limits.defaultPriorityFeeWei,
          {
            wethSupplied: BigInt(ctx.aaveReserves?.wethSupplied ?? "0"),
            usdcBorrowed: BigInt(ctx.aaveReserves?.usdcBorrowed ?? "0"),
          },
        ),
      );
    } else if (protocol === "gmx") {
      tag(
        "gmx",
        buildGmxFlow(
          rng,
          limits.gmxFlowMaxSizeUsd,
          limits.defaultPriorityFeeWei,
        ),
      );
    }
  }
  return out;
}
