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
import { tokenInfo } from "../markets.js";

// 会計上の quote（USDC 相当）の decimals。base→quote 換算の桁差に使う。
const QUOTE_DECIMALS = tokenInfo("USDC").decimals;

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
  crossVenueSpreadFlowMaxWethWei: bigint;
  defaultPriorityFeeWei: bigint;
};

// FlowContext の wire 形（JSON。bigint は文字列）。
export type FlowContextWire = {
  round: number;
  fairPriceUsdcPerWeth: number;
  protocols: ProtocolId[];
  poolPrices: Partial<Record<"uniswap" | "balancer" | "curve", number>>;
  aaveReserves?: { wethSupplied: string; usdcBorrowed: string };
  flowBalances?: Record<string, { wethWei: string; usdcUnits: string }>;
  usdcOnlyFlow?: boolean;
  // ADR 0013 Phase 8: WETH 以外の base ごとの AMM flow。WETH-only run では未設定（既定 off）で、
  // この場合 buildFlowOrders は追加 base ループに入らず RNG を一切消費しない（byte 互換）。
  // coordinator が WBTC 等を有効化したときだけ埋まる。各 base の max が "0" なら early-continue。
  extraBases?: Array<{
    base: TokenSymbol;
    // protocol -> その venue の当該 base/USD pool 価格。揃わない venue は省略。
    poolPrices: Partial<Record<"uniswap" | "balancer" | "curve", number>>;
    fairPriceUsd: number;
    // base 1e(decimals) 単位の AMM flow 上限。"0"/未設定で当該 base の flow は off（RNG 非消費）。
    uninformedFlowMaxBaseWei?: string;
    informedFlowMaxBaseWei?: string;
    balancerFlowMaxBaseWei?: string;
    curveFlowMaxBaseWei?: string;
  }>;
  limits: {
    uninformedFlowMaxWethWei: string;
    informedFlowMaxWethWei: string;
    balancerFlowMaxWethWei: string;
    curveFlowMaxWethWei: string;
    gmxFlowMaxSizeUsd: string;
    aaveFlowMaxWethWei: string;
    maxAaveBorrowUsdcUnits: string;
    crossVenueSpreadFlowMaxWethWei: string;
    defaultPriorityFeeWei: string;
  };
};

// bot が返す 1 注文（protocol タグ付き。coordinator が flow ウォレットを選ぶのに使う）。
export type FlowOrderOut = {
  protocol: ProtocolId;
  walletProtocol?: ProtocolId;
  kind: FlowKind;
  action: LeafAction;
  priorityFeeWei: bigint;
};

type FlowBalance = { wethWei: bigint; usdcUnits: bigint };

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

// base amount(base decimals) を price(USDC/base) で quote units(USDC decimals) へ換算。
// flow の base 上限を quote 側の注文サイズにも適用し、両側を同じ強度ノブで制御するため。
// WETH 経路は (wethWei * round(price*100)) / (100 * 10^(18-6)) で従来式と byte 一致する。
function baseToQuoteUnits(
  baseAmount: bigint,
  base: TokenSymbol,
  price: number,
): bigint {
  const scale = 10n ** BigInt(tokenInfo(base).decimals - QUOTE_DECIMALS);
  return (baseAmount * BigInt(Math.round(price * 100))) / (100n * scale);
}

// 後方互換ラッパ（WETH base 専用）。既存呼び出し箇所の値を変えない。
function wethToUsdcUnits(wethWei: bigint, fairPrice: number): bigint {
  return baseToQuoteUnits(wethWei, "WETH", fairPrice);
}

function flowBalance(
  ctx: FlowContextWire,
  protocol: ProtocolId,
  kind: FlowKind,
): FlowBalance | null {
  const raw = ctx.flowBalances?.[`${protocol}:${kind}`];
  if (!raw) return null;
  return {
    wethWei: BigInt(raw.wethWei),
    usdcUnits: BigInt(raw.usdcUnits),
  };
}

function capUsdc(amount: bigint, balance: FlowBalance | null): bigint {
  if (!balance) return amount;
  return amount > balance.usdcUnits ? balance.usdcUnits : amount;
}

// AMM (uniswap/balancer/curve) の flow。uninformed ノイズ + informed(価格を fair に寄せる)。
// base 既定 WETH。base!=="WETH" のとき tokenIn に当該 base シンボルを使い、action.base を付けて
// adapter が WBTC/USDC market を解決できるようにする。WETH 経路は従来と byte 一致（base 未付与・
// tokenIn="WETH"・wethToUsdcUnits 同値・RNG 消費列不変）。
export function buildAmmFlow(
  rng: Rng,
  protocol: "uniswap" | "balancer" | "curve",
  poolPrice: number,
  fairPrice: number,
  uninformedMaxWethWei: bigint,
  informedMaxWethWei: bigint,
  defaultPriorityFeeWei: bigint,
  balances?: {
    uninformed?: FlowBalance | null;
    informed?: FlowBalance | null;
  },
  usdcOnlyFlow = false,
  base: TokenSymbol = "WETH",
): FlowOrder[] {
  const orders: FlowOrder[] = [];
  const swapType =
    protocol === "uniswap"
      ? "swap"
      : protocol === "balancer"
        ? "balancerSwap"
        : "curveSwap";
  // WETH 経路は action.base を付けない（旧出力と同形）。WBTC 等のみ base を付与する。
  const baseField = base === "WETH" ? {} : { base };

  // uninformed: pool を fair から押しのけて gap(裁定の餌)を作る。base/USDC とも同じ
  // base 相当のランダム量にして、uninformedMaxWethWei が両側を一様に制御する（rng 消費は不変）。
  let uninformedTokenIn: TokenSymbol = rng.bool() ? base : "USDC";
  const uninformedWethEquiv = randomBigInt(
    rng,
    uninformedMaxWethWei / 20n,
    uninformedMaxWethWei,
  );
  if (
    uninformedTokenIn === base &&
    (usdcOnlyFlow ||
      (balances?.uninformed &&
        balances.uninformed.wethWei < uninformedWethEquiv))
  ) {
    uninformedTokenIn = "USDC";
  }
  const uninformedAmount =
    uninformedTokenIn === base
      ? uninformedWethEquiv
      : capUsdc(
          baseToQuoteUnits(uninformedWethEquiv, base, fairPrice),
          balances?.uninformed ?? null,
        );
  const uninformedFee =
    defaultPriorityFeeWei + BigInt(rng.int(1, 50)) * 1_000_000n;
  if (uninformedAmount > 0n) {
    orders.push({
      kind: "uninformed",
      action: {
        type: swapType,
        tokenIn: uninformedTokenIn,
        amountIn: uninformedAmount.toString(),
        slippageBps: FLOW_SLIPPAGE_BPS,
        ...baseField,
      } as LeafAction,
      priorityFeeWei: uninformedFee,
    });
  }

  // informed: pool 価格を fairPrice に寄せる（gap を閉じる側＝arb agent と競合する）。
  // 両側を informedMaxWethWei × gap で揃え、USDC 側も base 上限で制御する。
  // informedMaxWethWei を下げると flow bot が gap を潰さなくなり、arb の取り分が増える。
  let informedTokenIn: TokenSymbol = poolPrice < fairPrice ? "USDC" : base;
  const gap = Math.min(1, Math.abs(fairPrice / poolPrice - 1) * 20);
  const informedWethEquiv =
    (informedMaxWethWei * BigInt(Math.max(1, Math.floor(gap * 100)))) / 100n;
  if (
    informedTokenIn === base &&
    (usdcOnlyFlow ||
      (balances?.informed && balances.informed.wethWei < informedWethEquiv))
  ) {
    // USDC-only runs start flow wallets with no base token. Buy base first so a later
    // sell-side informed flow can use the same wallet instead of reverting.
    informedTokenIn = "USDC";
  }
  const informedAmount =
    informedTokenIn === base
      ? informedWethEquiv
      : capUsdc(
          baseToQuoteUnits(informedWethEquiv, base, fairPrice),
          balances?.informed ?? null,
        );
  const informedFee =
    defaultPriorityFeeWei + BigInt(rng.int(50, 100)) * 1_000_000n;
  if (informedAmount > 0n) {
    orders.push({
      kind: "informed",
      action: {
        type: swapType,
        tokenIn: informedTokenIn,
        amountIn: informedAmount.toString(),
        slippageBps: FLOW_SLIPPAGE_BPS,
        ...baseField,
      } as LeafAction,
      priorityFeeWei: informedFee,
    });
  }

  return orders;
}

// GMX perp orderflow: 小口のロング/ショートを開いて約定ボリュームを作る（keeper が約定）。
export function buildGmxFlow(
  rng: Rng,
  gmxFlowMaxSizeUsd: bigint,
  defaultPriorityFeeWei: bigint,
  fairPrice: number,
  balance?: FlowBalance | null,
  canPrepareWeth = false,
): FlowOrderOut[] {
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
  if (balance && balance.wethWei < collateralWei * (canPrepareWeth ? 2n : 1n)) {
    if (!canPrepareWeth) return [];
    const usdcIn = capUsdc(wethToUsdcUnits(collateralWei, fairPrice), balance);
    if (usdcIn <= 0n) return [];
    return [
      {
        protocol: "uniswap",
        walletProtocol: "gmx",
        kind: "uninformed",
        action: {
          type: "swap",
          tokenIn: "USDC",
          amountIn: usdcIn.toString(),
          slippageBps: FLOW_SLIPPAGE_BPS,
        } as LeafAction,
        priorityFeeWei: fee,
      },
    ];
  }
  const action = {
    type: "gmxIncrease",
    isLong,
    collateral: "WETH",
    collateralAmount: collateralWei.toString(),
    sizeDeltaUsd: sizeUsd.toString(),
  } as unknown as LeafAction;
  return [{ protocol: "gmx", kind: "uninformed", action, priorityFeeWei: fee }];
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
  fairPrice: number,
  balance?: FlowBalance | null,
  canPrepareWeth = false,
): FlowOrderOut[] {
  const fee = defaultPriorityFeeWei + BigInt(rng.int(1, 40)) * 1_000_000n;

  // 状態機械: supply -> (borrow <-> repay を反復) -> 債務0のとき確率で withdraw。
  //   - withdraw は borrowed===0 のときのみ（債務未返済での withdraw revert を回避）
  //   - 債務があれば必ず repay max（flow walletは初期USDCも保有するため利息込みで完済でき端数ループを回避）
  let action: LeafAction;
  if (reserves.wethSupplied === 0n) {
    const amount = aaveFlowMaxWethWei / 2n;
    if (balance && balance.wethWei < amount * (canPrepareWeth ? 2n : 1n)) {
      if (!canPrepareWeth) return [];
      const usdcIn = capUsdc(wethToUsdcUnits(amount, fairPrice), balance);
      if (usdcIn <= 0n) return [];
      return [
        {
          protocol: "uniswap",
          walletProtocol: "aave",
          kind: "informed",
          action: {
            type: "swap",
            tokenIn: "USDC",
            amountIn: usdcIn.toString(),
            slippageBps: FLOW_SLIPPAGE_BPS,
          } as LeafAction,
          priorityFeeWei: fee,
        },
      ];
    }
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
  return [{ protocol: "aave", kind: "informed", action, priorityFeeWei: fee }];
}

// delta-neutral cross-venue スプレッド注入（α 機会の構造的生成）。
//
// 動機（discrimination-needs-delta-neutral / selfimprove-validation-synthesis）:
// この市場の支配的利益源は α(裁定)でなく β(方向)で、優劣が「市場スタイル適合(β)」で決まり
// 真のスキル選別ができない。原因は (1) 方向 β が大きい、(2) 取れる α(cross-venue スプレッド)が薄い。
// この注入は (2) を構造的に増やす: 毎ブロック有効 AMM venue から 2 つを選び、一方で WETH を
// 買い上げ(価格↑)・他方で同 WETH 相当を売り下げる(価格↓)。fair price 周りに対称な spread を開けるので:
//   - 方向シグナル(β)も fair 乖離も注入しない（2 leg の市場インパクトが相殺 = delta-neutral）
//   - その spread は「安い venue で買い・高い venue で売る」2-leg 裁定(α)だけが取れる。
//     単発 swap の random は片側しか取れず逆 leg の戻りで損になり得る → α を運で拾えない。
//   - 単 venue β-carrier も各 venue が fair から半分しかズレない上、2 venue が逆方向なので取り分小。
// rng 消費は「2 venue 選択 + サイズ + fee」の固定回数。maxWethWei<=0 / venue<2 の時のみ消費せず空返し。
export function buildCrossVenueSpreadFlow(
  rng: Rng,
  protocols: ProtocolId[],
  poolPrices: Partial<Record<"uniswap" | "balancer" | "curve", number>>,
  fairPrice: number,
  maxWethWei: bigint,
  defaultPriorityFeeWei: bigint,
): FlowOrderOut[] {
  if (maxWethWei <= 0n) return [];
  const swapTypeOf: Record<
    "uniswap" | "balancer" | "curve",
    "swap" | "balancerSwap" | "curveSwap"
  > = { uniswap: "swap", balancer: "balancerSwap", curve: "curveSwap" };
  const venues = (["uniswap", "balancer", "curve"] as const).filter(
    (v) => protocols.includes(v) && (poolPrices[v] ?? 0) > 0,
  );
  if (venues.length < 2) return [];

  // 2 venue を決定論的に選ぶ（up=買い上げる venue、down=売り下げる venue）。
  const iUp = rng.int(0, venues.length);
  let iDown = rng.int(0, venues.length - 1);
  if (iDown >= iUp) iDown += 1; // iUp を除いた残りから一様に選ぶ
  const upVenue = venues[iUp];
  const downVenue = venues[iDown];

  // 両 leg を同じ WETH 相当にして delta-neutral に保つ（市場全体への方向インパクト ≈ 0）。
  const wethEquiv = randomBigInt(rng, maxWethWei / 4n, maxWethWei);
  // 低 fee: agent が翌ブロックで spread を取りに来られるよう、informed より控えめに置く。
  const fee = defaultPriorityFeeWei + BigInt(rng.int(1, 30)) * 1_000_000n;
  // 注入は意図的に価格を動かす（spread を開く）ので slippage を広く取り revert を避ける。
  const SPREAD_SLIPPAGE_BPS = 1000;

  return [
    {
      // up leg: USDC→WETH（買い）→ upVenue の価格を押し上げる
      protocol: upVenue,
      kind: "spread",
      action: {
        type: swapTypeOf[upVenue],
        tokenIn: "USDC",
        amountIn: wethToUsdcUnits(wethEquiv, fairPrice).toString(),
        slippageBps: SPREAD_SLIPPAGE_BPS,
      } as LeafAction,
      priorityFeeWei: fee,
    },
    {
      // down leg: WETH→USDC（売り）→ downVenue の価格を押し下げる
      protocol: downVenue,
      kind: "spread",
      action: {
        type: swapTypeOf[downVenue],
        tokenIn: "WETH",
        amountIn: wethEquiv.toString(),
        slippageBps: SPREAD_SLIPPAGE_BPS,
      } as LeafAction,
      priorityFeeWei: fee,
    },
  ];
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
    crossVenueSpreadFlowMaxWethWei: BigInt(
      wire.crossVenueSpreadFlowMaxWethWei ?? "0",
    ),
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
          {
            uninformed: flowBalance(ctx, protocol, "uninformed"),
            informed: flowBalance(ctx, protocol, "informed"),
          },
          ctx.usdcOnlyFlow === true,
        ),
      );
    } else if (protocol === "aave") {
      out.push(
        ...buildAaveFlow(
          rng,
          limits.aaveFlowMaxWethWei,
          limits.maxAaveBorrowUsdcUnits,
          limits.defaultPriorityFeeWei,
          {
            wethSupplied: BigInt(ctx.aaveReserves?.wethSupplied ?? "0"),
            usdcBorrowed: BigInt(ctx.aaveReserves?.usdcBorrowed ?? "0"),
          },
          ctx.fairPriceUsdcPerWeth,
          flowBalance(ctx, "aave", "informed"),
          ctx.protocols.includes("uniswap"),
        ),
      );
    } else if (protocol === "gmx") {
      out.push(
        ...buildGmxFlow(
          rng,
          limits.gmxFlowMaxSizeUsd,
          limits.defaultPriorityFeeWei,
          ctx.fairPriceUsdcPerWeth,
          flowBalance(ctx, "gmx", "uninformed"),
          ctx.protocols.includes("uniswap"),
        ),
      );
    }
  }

  // ADR 0013 Phase 8: WETH 以外の base（WBTC 等）の AMM flow。WETH を上で先に処理し終えた後に
  // 後置する。ctx.extraBases が未設定（WETH-only run）なら反復ゼロ = RNG 非消費 = byte 互換。
  // 各 base × venue で max=0/未設定なら early-continue し、その base/venue の RNG を消費しない
  // （WBTC 既定 off で WETH-only の RNG 消費列・出力が一切変わらない）。
  for (const extra of ctx.extraBases ?? []) {
    const extraMax: Record<"uniswap" | "balancer" | "curve", bigint> = {
      uniswap: BigInt(extra.uninformedFlowMaxBaseWei ?? "0"),
      balancer: BigInt(extra.balancerFlowMaxBaseWei ?? "0"),
      curve: BigInt(extra.curveFlowMaxBaseWei ?? "0"),
    };
    const informedMax = BigInt(extra.informedFlowMaxBaseWei ?? "0");
    for (const protocol of ctx.protocols) {
      if (
        protocol !== "uniswap" &&
        protocol !== "balancer" &&
        protocol !== "curve"
      )
        continue;
      const uninformedMax = extraMax[protocol];
      // off（uninformed と informed の両上限が 0）なら RNG を一切消費せず skip。
      const venueInformedMax =
        protocol === "uniswap" ? informedMax : extraMax[protocol];
      if (uninformedMax <= 0n && venueInformedMax <= 0n) continue;
      const poolPrice = extra.poolPrices[protocol];
      if (poolPrice === undefined || poolPrice <= 0) continue;
      tag(
        protocol,
        buildAmmFlow(
          rng,
          protocol,
          poolPrice,
          extra.fairPriceUsd,
          uninformedMax,
          venueInformedMax,
          limits.defaultPriorityFeeWei,
          {
            uninformed: flowBalance(ctx, protocol, "uninformed"),
            informed: flowBalance(ctx, protocol, "informed"),
          },
          ctx.usdcOnlyFlow === true,
          extra.base,
        ),
      );
    }
  }

  // 最後に cross-venue スプレッド注入（α 機会）。per-protocol ループの後に置くことで、
  // 無効時(max=0)は rng を一切消費せず既存 flow と byte 互換を保つ。
  out.push(
    ...buildCrossVenueSpreadFlow(
      rng,
      ctx.protocols,
      ctx.poolPrices,
      ctx.fairPriceUsdcPerWeth,
      limits.crossVenueSpreadFlowMaxWethWei,
      limits.defaultPriorityFeeWei,
    ),
  );
  return out;
}
