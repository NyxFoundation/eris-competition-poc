import type { Address, Hex, PublicClient, WalletClient } from "viem";
import type { makeChain } from "../chain.js";
import type { SimConfig } from "../config.js";
import type { Rng } from "../rng.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  BundleActionItem,
  LeafAction,
  ProtocolId,
} from "../types.js";

export type FlowKind = "informed" | "uninformed";

export interface FlowWallet {
  id: string;
  address: Address;
  privateKey: Hex;
}

export interface BuiltTx {
  to: Address;
  data: Hex;
  value?: bigint;
}

export interface FlowOrder {
  kind: FlowKind;
  action: LeafAction;
  priorityFeeWei: bigint;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

// GMX / Aave のオラクル制御ハンドル（setupGlobal で確定）
export interface OracleHandles {
  gmxProvider?: Address;
  aaveAggregators: Record<string, Address>; // token address(lower) -> MockAggregator
}

export interface SimContext {
  publicClient: PublicClient;
  walletClient: WalletClient;
  chain: ReturnType<typeof makeChain>;
  config: SimConfig;
  rng: Rng;
  adminPk: Hex;
  keeperPk: Hex;
  oracle: OracleHandles;
  gmx: { mockProvider?: Address; market: Address };
  // 競争ブロックで作成された GMX 注文キー（keeper ブロックで実行）
  pendingGmxOrders: Hex[];
  // GMX mock オラクル更新（gmx.setupGlobal が設定。oracles.updateOracles から呼ぶ）
  // opts.noMine=true で realtime 用に mine せず mempool submit（priorityFeeWei で入札）。
  updateGmxOracle?: (
    ctx: SimContext,
    fairPrice: number,
    opts?: { noMine?: boolean; priorityFeeWei?: bigint },
  ) => Promise<void>;
  // protocol/kind ごとの flow ウォレット
  flowWallet(protocol: ProtocolId, kind: FlowKind): FlowWallet;
}

export interface ProtocolAdapter {
  id: ProtocolId;

  // この protocol が「USDC」として扱う stable トークン（stable 統一会計用）。
  // 未指定なら native USDC とみなす。
  stableToken?: Address;

  // ---- アクション parse/validate（純粋関数。clients 不要）----
  // 自分の type でなければ null
  parse(obj: Record<string, unknown>): LeafAction | null;
  // bundle 内で許可されるか（GMX は false）
  bundleable(action: LeafAction): boolean;
  validate(
    action: LeafAction,
    obs: AgentObservation,
    balances: BalanceSnapshot,
  ): ValidationResult;

  // ---- ラウンド毎の状態読取 ----
  readState(ctx: SimContext, fairPrice: number): Promise<unknown>;

  // ---- 観測寄与（obs.protocols[id] に入る）----
  observe(
    ctx: SimContext,
    state: unknown,
    agent: Address,
    fairPrice: number,
  ): Promise<unknown>;

  // ---- intent -> オンチェーン tx ----
  buildTxs(
    ctx: SimContext,
    owner: Address,
    action: LeafAction,
    state: unknown,
  ): Promise<BuiltTx[]>;

  // ---- mine 後フック（GMX keeper 実行）----
  afterMine?(ctx: SimContext): Promise<void>;

  // ---- PnL 寄与（USDC）----
  valueUsdc(
    ctx: SimContext,
    agent: Address,
    state: unknown,
    fairPrice: number,
  ): Promise<number>;

  // ---- wallet 毎 setup（approve 等の tx を返す。coordinator が owner 鍵で送信）----
  setupWallet?(ctx: SimContext, owner: Address): Promise<BuiltTx[]>;

  // ---- 全体 setup（mock deploy / role 付与 / oracle source 差替）----
  setupGlobal?(ctx: SimContext): Promise<void>;
}

// bundle leaf を LeafAction に widening するヘルパ型
export type { BundleActionItem };
