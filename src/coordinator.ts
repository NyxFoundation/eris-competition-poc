// 同期ラウンド方式（runSimulation）は ADR 0006 で退役済み。本ファイルは観測/flow/採点の
// 共有関数のみ（observationFor / buildFlowContext / submit* / initialFairPrice* 等。realtime
// coordinator と directShim が利用する）。
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import type { SimConfig } from "./config.js";
import { accountAddress, getBalances } from "./chain.js";
import { balanceToInventory } from "./pnl.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  ProtocolId,
  ProtocolObservations,
  RawTxIntent,
  TxIntent,
  WalletRole,
} from "./types.js";
import { baseTokens, tokenInfo } from "./markets.js";
import { enabledAdapters } from "./protocols/registry.js";
import type { FlowKind, FlowWallet, SimContext } from "./protocols/types.js";
import { FlowProcess, type FlowOrderWire } from "./flowProcess.js";
import type { FlowContextWire } from "./flow/logic.js";
import { readAaveFlowReserves } from "./protocols/aave.js";

// ---------------------------------------------------------------------------
// 観測 / flow / submit
// ---------------------------------------------------------------------------

export async function observationFor(
  ctx: SimContext,
  adapters: ReturnType<typeof enabledAdapters>,
  stateById: Map<ProtocolId, unknown>,
  runId: string,
  round: number,
  blockNumber: bigint,
  agentAddress: Address,
  fairPrice: number,
  balances: BalanceSnapshot,
  history: AgentObservation["history"],
  config: SimConfig,
  enabledIds: ProtocolId[],
): Promise<AgentObservation> {
  // protocol ごとの観測は独立した読取なので並列に発行する。direct モードの agent クライアント
  // （batch=true）では同一 tick の読取が Multicall3 1 本に自動集約されるため、並列発行が
  // そのまま往復回数の削減になる。
  const protocols: ProtocolObservations = {};
  await Promise.all(
    adapters.map(async (adapter) => {
      const obs = await adapter.observe(
        ctx,
        stateById.get(adapter.id),
        agentAddress,
        fairPrice,
      );
      (protocols as Record<string, unknown>)[adapter.id] = obs;
    }),
  );
  return {
    kind: "observation",
    runId,
    round,
    blockNumber: blockNumber.toString(),
    agentAddress,
    fairPriceUsdcPerWeth: fairPrice,
    oraclePrices: { wethUsd: fairPrice, usdcUsd: 1 },
    // ADR 0013: 全 base の USD 価格・残高。WETH のみのとき fairPricesUsd={WETH:fairPrice} で
    // 既存フィールドと一致（後方互換）。WBTC を見る戦略だけ参照する。
    fairPricesUsd: ctx.fairPrices ?? { WETH: fairPrice },
    ...(balances.bases
      ? {
          baseBalances: Object.fromEntries(
            Object.entries(balances.bases).map(([k, v]) => [k, v.toString()]),
          ),
        }
      : {}),
    // ADR 0013: 各 base の decimals。プロセス分離 agent の base 量換算用（WETH のみなら {WETH:18}）。
    baseDecimals: Object.fromEntries(
      Object.keys(ctx.fairPrices ?? { WETH: fairPrice }).map((b) => [
        b,
        tokenInfo(b).decimals,
      ]),
    ),
    enabledProtocols: enabledIds,
    balances: {
      ethWei: balances.ethWei.toString(),
      wethWei: balances.wethWei.toString(),
      usdcUnits: balances.usdcUnits.toString(),
    },
    inventory: balanceToInventory(balances, fairPrice),
    history: history.slice(-20),
    limits: {
      maxWethInWei: config.maxAgentWethInWei.toString(),
      maxUsdcInUnits: config.maxAgentUsdcInUnits.toString(),
      defaultPriorityFeePerGasWei: config.defaultPriorityFeeWei.toString(),
      // 経済化（ADR 0011 §2）: priority-fee 上限執行を退役するので、agent へ提示する上限も
      // 実質撤廃する（入札は機会価値で自己制限する = realistic priority gas auction）。validateAction の
      // 提出前チェックもこの値を見るため、ここを上げないと高入札が黙って弾かれる。10^18 wei/gas は
      // 事実上無制限の guard（壊れた巨大入札だけ弾く。実 spend は EIP-1559 残高制約で endowment に縛られる）。
      maxPriorityFeePerGasWei: (config.economicGas
        ? 1_000_000_000_000_000_000n
        : config.maxPriorityFeeWei
      ).toString(),
      defaultSlippageBps: 50,
      maxBundleActions: config.maxBundleActions,
      maxLpWethWei: config.maxLpWethWei.toString(),
      maxLpUsdcUnits: config.maxLpUsdcUnits.toString(),
      maxOpenPositions: config.maxOpenPositions,
      maxGmxSizeUsd: config.maxGmxSizeUsd.toString(),
      maxAaveSupplyWethWei: config.maxAaveSupplyWethWei.toString(),
      maxAaveBorrowUsdcUnits: config.maxAaveBorrowUsdcUnits.toString(),
      // ADR 0013: per-base 上限を露出。WETH は既存値、追加 base は config の per-base マップ（既定 0）。
      baseLimits: buildBaseLimits(config),
    },
    protocols,
  };
}

// ADR 0013: base シンボル -> per-round 上限のマップを config から組む。WETH は既存の WETH 専用
// 上限を流用し（byte 互換）、追加 base は MAX_AGENT/MAX_LP/MAX_AAVE_SUPPLY の per-base 値（既定 0）。
function buildBaseLimits(
  config: SimConfig,
): NonNullable<AgentObservation["limits"]["baseLimits"]> {
  const out: NonNullable<AgentObservation["limits"]["baseLimits"]> = {};
  const bases = new Set<string>([
    "WETH",
    ...Object.keys(config.maxAgentBaseIn),
    ...Object.keys(config.maxLpBase),
    ...Object.keys(config.maxAaveSupplyBase),
  ]);
  for (const base of bases) {
    const maxSwap =
      base === "WETH"
        ? config.maxAgentWethInWei
        : (config.maxAgentBaseIn[base] ?? 0n);
    const maxLp =
      base === "WETH" ? config.maxLpWethWei : (config.maxLpBase[base] ?? 0n);
    const maxAave =
      base === "WETH"
        ? config.maxAaveSupplyWethWei
        : (config.maxAaveSupplyBase[base] ?? 0n);
    out[base] = {
      maxSwapInBaseWei: maxSwap.toString(),
      maxLpBaseWei: maxLp.toString(),
      maxAaveSupplyBaseWei: maxAave.toString(),
    };
  }
  return out;
}

// orderflow bot プロセスに FlowContext を渡して FlowOrder[] を受け取り、TxIntent に変換する。
// flow ウォレットの選択と tx 提出は coordinator が所有（bot は注文を決めるだけ）。
// FlowContext を組み立てる（poolPrices / aave reserves / limits）。realtime でも毎ブロック再利用する。
export async function buildFlowContext(
  ctx: SimContext,
  enabledIds: ProtocolId[],
  stateById: Map<ProtocolId, unknown>,
  fairPrice: number,
  round: number,
): Promise<FlowContextWire> {
  const poolPrices: Partial<Record<"uniswap" | "balancer" | "curve", number>> =
    {};
  for (const id of ["uniswap", "balancer", "curve"] as const) {
    if (!enabledIds.includes(id)) continue;
    const s = stateById.get(id) as { priceUsdcPerWeth?: number } | undefined;
    if (s && typeof s.priceUsdcPerWeth === "number")
      poolPrices[id] = s.priceUsdcPerWeth;
  }

  // aave flow は flow ウォレットの reserve に依存する。RPC 読取は coordinator 側で行い渡す。
  let aaveReserves: FlowContextWire["aaveReserves"];
  if (enabledIds.includes("aave")) {
    const wallet = ctx.flowWallet("aave", "informed");
    const r = await readAaveFlowReserves(ctx.publicClient, wallet.address);
    aaveReserves = {
      wethSupplied: r.wethSupplied.toString(),
      usdcBorrowed: r.usdcBorrowed.toString(),
    };
  }
  const flowBalances: FlowContextWire["flowBalances"] = {};
  for (const protocol of enabledIds) {
    for (const kind of ["informed", "uninformed", "spread"] as FlowKind[]) {
      const wallet = ctx.flowWallet(protocol, kind);
      const b = await getBalances(ctx.publicClient, wallet.address);
      flowBalances[`${protocol}:${kind}`] = {
        wethWei: b.wethWei.toString(),
        usdcUnits: b.usdcUnits.toString(),
      };
    }
  }

  // ADR 0013 Phase 8: WETH 以外の base の AMM flow context。flow max>0 かつ価格が揃う base のみ
  // 載せる（max=0/未設定なら省略 → buildFlowOrders が当該 base を反復せず RNG 非消費 = byte 互換）。
  const extraBases: NonNullable<FlowContextWire["extraBases"]> = [];
  for (const t of baseTokens()) {
    if (t.symbol === "WETH") continue;
    const max = ctx.config.baseFlowMax?.[t.symbol] ?? 0n;
    if (max <= 0n) continue;
    const basePoolPrices: NonNullable<
      FlowContextWire["extraBases"]
    >[number]["poolPrices"] = {};
    for (const id of ["uniswap", "balancer", "curve"] as const) {
      if (!enabledIds.includes(id)) continue;
      const s = stateById.get(id) as
        | {
            markets?: Array<{
              market: { base: string };
              priceUsdcPerWeth: number;
            }>;
          }
        | undefined;
      const ms = s?.markets?.find((m) => m.market.base === t.symbol);
      if (
        ms &&
        typeof ms.priceUsdcPerWeth === "number" &&
        ms.priceUsdcPerWeth > 0
      )
        basePoolPrices[id] = ms.priceUsdcPerWeth;
    }
    const fairPriceUsd = ctx.fairPrices?.[t.symbol] ?? 0;
    if (fairPriceUsd <= 0 || Object.keys(basePoolPrices).length === 0) continue;
    const maxStr = max.toString();
    extraBases.push({
      base: t.symbol,
      poolPrices: basePoolPrices,
      fairPriceUsd,
      uninformedFlowMaxBaseWei: maxStr,
      informedFlowMaxBaseWei: maxStr,
      balancerFlowMaxBaseWei: maxStr,
      curveFlowMaxBaseWei: maxStr,
    });
  }

  return {
    round,
    fairPriceUsdcPerWeth: fairPrice,
    protocols: enabledIds,
    poolPrices,
    aaveReserves,
    flowBalances,
    usdcOnlyFlow: ctx.config.initialWethWei === 0n,
    ...(extraBases.length > 0 ? { extraBases } : {}),
    limits: {
      uninformedFlowMaxWethWei: ctx.config.uninformedFlowMaxWethWei.toString(),
      informedFlowMaxWethWei: ctx.config.informedFlowMaxWethWei.toString(),
      balancerFlowMaxWethWei: ctx.config.balancerFlowMaxWethWei.toString(),
      curveFlowMaxWethWei: ctx.config.curveFlowMaxWethWei.toString(),
      gmxFlowMaxSizeUsd: ctx.config.gmxFlowMaxSizeUsd.toString(),
      aaveFlowMaxWethWei: ctx.config.aaveFlowMaxWethWei.toString(),
      maxAaveBorrowUsdcUnits: ctx.config.maxAaveBorrowUsdcUnits.toString(),
      crossVenueSpreadFlowMaxWethWei:
        ctx.config.crossVenueSpreadFlowMaxWethWei.toString(),
      defaultPriorityFeeWei: ctx.config.defaultPriorityFeeWei.toString(),
    },
  };
}

// bot が返した FlowOrder[] を flow ウォレット紐付けの TxIntent[] に変換する。
export function flowOrdersToIntents(
  ctx: SimContext,
  orders: FlowOrderWire[],
): TxIntent[] {
  const intents: TxIntent[] = [];
  for (const order of orders) {
    const wallet = ctx.flowWallet(
      order.walletProtocol ?? order.protocol,
      order.kind,
    );
    intents.push({
      ownerId: wallet.id,
      role: order.kind === "informed" ? "informed-flow" : "uninformed-flow",
      privateKey: wallet.privateKey,
      protocol: order.protocol,
      action: order.action,
      priorityFeeWei: BigInt(order.priorityFeeWei),
      gmxOrder: order.protocol === "gmx",
    });
  }
  return intents;
}

// orderflow bot プロセスに FlowContext を渡して FlowOrder[] を受け取り、TxIntent に変換する。
// flow ウォレットの選択と tx 提出は coordinator が所有（bot は注文を決めるだけ）。
export async function requestFlowIntents(
  ctx: SimContext,
  flowProcess: FlowProcess,
  enabledIds: ProtocolId[],
  stateById: Map<ProtocolId, unknown>,
  fairPrice: number,
  round: number,
  timeoutMs: number,
): Promise<TxIntent[]> {
  const context = await buildFlowContext(
    ctx,
    enabledIds,
    stateById,
    fairPrice,
    round,
  );
  const orders = await flowProcess.requestOrders(context, timeoutMs);
  return flowOrdersToIntents(ctx, orders);
}

export async function submitIntent(
  ctx: SimContext,
  intent: TxIntent,
  stateById: Map<ProtocolId, unknown>,
): Promise<Hex[]> {
  const adapter = enabledAdapters().find((a) => a.id === intent.protocol);
  if (!adapter) throw new Error(`adapter not enabled: ${intent.protocol}`);
  const owner = accountAddress(intent.privateKey);
  const txs = await adapter.buildTxs(
    ctx,
    owner,
    intent.action,
    stateById.get(intent.protocol),
  );
  const account = privateKeyToAccount(intent.privateKey);
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hashes: Hex[] = [];
  for (const tx of txs) {
    const hash = await ctx.walletClient.sendTransaction({
      account,
      chain: ctx.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
      maxFeePerGas: baseFee + intent.priorityFeeWei,
      maxPriorityFeePerGas: intent.priorityFeeWei,
    });
    hashes.push(hash);
  }
  return hashes;
}

export async function submitRawTxIntent(
  ctx: SimContext,
  intent: RawTxIntent,
): Promise<Hex> {
  const account = privateKeyToAccount(intent.privateKey);
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  return ctx.walletClient.sendTransaction({
    account,
    chain: ctx.chain,
    to: intent.rawTx.to as Address,
    data: intent.rawTx.data as Hex,
    value: intent.rawTx.value ? BigInt(intent.rawTx.value) : 0n,
    maxFeePerGas: baseFee + intent.priorityFeeWei,
    maxPriorityFeePerGas: intent.priorityFeeWei,
  });
}

export async function initialFairPrice(
  ctx: SimContext,
  enabledIds: ProtocolId[],
): Promise<number> {
  if (enabledIds.includes("uniswap")) {
    const { getPoolPriceUsdcPerWeth } = await import("./protocols/uniswap.js");
    return getPoolPriceUsdcPerWeth(ctx.publicClient);
  }
  return 3000;
}

// ADR 0013: 追加 base（WBTC 等）の初期 fair price。uniswap の当該 market pool 価格を採用し、
// 無ければ既定（WBTC=60000）。WETH は従来の initialFairPrice にフォールバック。
export async function initialFairPriceFor(
  ctx: SimContext,
  base: string,
  enabledIds: ProtocolId[],
): Promise<number> {
  if (base === "WETH") return initialFairPrice(ctx, enabledIds);
  if (enabledIds.includes("uniswap")) {
    const { getPoolState } = await import("./protocols/uniswap.js");
    const s = await getPoolState(ctx.publicClient);
    const m = s.markets.find((ms) => ms.market.base === base);
    if (m) return m.priceUsdcPerWeth;
  }
  return base === "WBTC" ? 60000 : 3000;
}
