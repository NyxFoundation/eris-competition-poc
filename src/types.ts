import type { Hex } from "viem";

export type TokenSymbol = "WETH" | "USDC";

export type ProtocolId = "uniswap" | "balancer" | "curve" | "gmx" | "aave";

// ---------------------------------------------------------------------------
// アクション型
// ---------------------------------------------------------------------------

// Uniswap
export type SwapAction = {
  type: "swap";
  tokenIn: TokenSymbol;
  amountIn: string;
  maxPriorityFeePerGasWei?: string;
  slippageBps?: number;
};

export type MintLiquidityAction = {
  type: "mintLiquidity";
  tickLower: number;
  tickUpper: number;
  amountWethDesired: string;
  amountUsdcDesired: string;
  slippageBps?: number;
  maxPriorityFeePerGasWei?: string;
};

export type RemoveLiquidityAction = {
  type: "removeLiquidity";
  tokenId: string;
  liquidity: string;
  amountWethMin?: string;
  amountUsdcMin?: string;
  maxPriorityFeePerGasWei?: string;
};

export type CollectFeesAction = {
  type: "collectFees";
  tokenId: string;
  maxPriorityFeePerGasWei?: string;
};

// Balancer v2 / Curve（spot swap）
export type BalancerSwapAction = {
  type: "balancerSwap";
  tokenIn: TokenSymbol;
  amountIn: string;
  slippageBps?: number;
  maxPriorityFeePerGasWei?: string;
};

export type CurveSwapAction = {
  type: "curveSwap";
  tokenIn: TokenSymbol;
  amountIn: string;
  slippageBps?: number;
  maxPriorityFeePerGasWei?: string;
};

// Aave v3
export type AaveSupplyAction = {
  type: "aaveSupply";
  asset: TokenSymbol;
  amount: string;
  maxPriorityFeePerGasWei?: string;
};
export type AaveWithdrawAction = {
  type: "aaveWithdraw";
  asset: TokenSymbol;
  amount: string; // 10 進整数 or "max"
  maxPriorityFeePerGasWei?: string;
};
export type AaveBorrowAction = {
  type: "aaveBorrow";
  asset: TokenSymbol;
  amount: string;
  maxPriorityFeePerGasWei?: string;
};
export type AaveRepayAction = {
  type: "aaveRepay";
  asset: TokenSymbol;
  amount: string; // 10 進整数 or "max"
  maxPriorityFeePerGasWei?: string;
};

// GMX v2（perp。keeper 実行が必要なため bundle 不可・単独のみ）
export type GmxIncreaseAction = {
  type: "gmxIncrease";
  isLong: boolean;
  collateral: TokenSymbol;
  collateralAmount: string; // token units
  sizeDeltaUsd: string; // GMX 1e30 スケール USD
  acceptablePrice?: string; // GMX 1e(30-decimals) スケール。省略時は LOOSE
  maxPriorityFeePerGasWei?: string;
};
export type GmxDecreaseAction = {
  type: "gmxDecrease";
  isLong: boolean;
  collateral: TokenSymbol;
  collateralDeltaAmount: string; // 引き出す担保(token units)。0 可
  sizeDeltaUsd: string; // GMX 1e30 スケール USD
  acceptablePrice?: string;
  maxPriorityFeePerGasWei?: string;
};

// bundle 可能な leaf（GMX を除く）
export type BundleActionItem =
  | SwapAction
  | MintLiquidityAction
  | RemoveLiquidityAction
  | CollectFeesAction
  | BalancerSwapAction
  | CurveSwapAction
  | AaveSupplyAction
  | AaveWithdrawAction
  | AaveBorrowAction
  | AaveRepayAction;

// 全 leaf アクション（GMX 含む。intent / buildTxs の単位）
export type LeafAction =
  | BundleActionItem
  | GmxIncreaseAction
  | GmxDecreaseAction;

export type RawTx = {
  to: string;
  data: string;
  value?: string;
};

export type RawTxAction = {
  type: "rawTx";
  tx: RawTx;
  maxPriorityFeePerGasWei?: string;
};

export type RawBundleAction = {
  type: "rawBundle";
  txs: RawTx[];
  maxPriorityFeePerGasWei?: string;
};

export type AgentAction =
  | { type: "noop"; reason?: string }
  | LeafAction
  | {
      type: "bundle";
      actions: BundleActionItem[];
      maxPriorityFeePerGasWei?: string;
    }
  | RawTxAction
  | RawBundleAction;

// ---------------------------------------------------------------------------
// 観測スキーマ（protocol 名前空間化）
// ---------------------------------------------------------------------------

export type LpPositionObservation = {
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  tokensOwedWethWei: string;
  tokensOwedUsdcUnits: string;
  amountWethWei: string;
  amountUsdcUnits: string;
  valueUsdc: number;
};

export type UniswapObservation = {
  pool: {
    pair: "WETH/USDC";
    fee: number;
    priceUsdcPerWeth: number;
    tick: number;
    tickSpacing: number;
  };
  positions: LpPositionObservation[];
};

export type AmmObservation = {
  priceUsdcPerWeth: number;
  reserves?: { weth: string; usdc: string };
};

export type GmxPositionObservation = {
  isLong: boolean;
  sizeUsd: string;
  sizeInTokens: string;
  collateral: TokenSymbol;
  collateralAmount: string;
  entryPriceUsd: number;
  pnlUsd: number;
};

export type GmxObservation = {
  marketPriceUsd: number;
  position?: GmxPositionObservation;
};

export type AaveObservation = {
  healthFactor: string;
  totalCollateralBase: string;
  totalDebtBase: string;
  availableBorrowsBase: string;
  supplied: Partial<Record<TokenSymbol, string>>;
  borrowed: Partial<Record<TokenSymbol, string>>;
};

export type ProtocolObservations = {
  uniswap?: UniswapObservation;
  balancer?: AmmObservation;
  curve?: AmmObservation;
  gmx?: GmxObservation;
  aave?: AaveObservation;
};

export type AgentObservation = {
  kind: "observation";
  runId: string;
  round: number;
  blockNumber: string;
  agentAddress: string;
  fairPriceUsdcPerWeth: number;
  oraclePrices: { wethUsd: number; usdcUsd: number };
  enabledProtocols: ProtocolId[];
  balances: {
    ethWei: string;
    wethWei: string;
    usdcUnits: string;
  };
  inventory: {
    valueUsdc: number;
    weth: number;
    usdc: number;
    eth: number;
  };
  history: Array<{
    round: number;
    poolPriceUsdcPerWeth: number;
    fairPriceUsdcPerWeth: number;
  }>;
  limits: {
    maxWethInWei: string;
    maxUsdcInUnits: string;
    defaultPriorityFeePerGasWei: string;
    maxPriorityFeePerGasWei: string;
    defaultSlippageBps: number;
    maxBundleActions: number;
    maxLpWethWei: string;
    maxLpUsdcUnits: string;
    maxOpenPositions: number;
    maxGmxSizeUsd: string;
    maxAaveSupplyWethWei: string;
    maxAaveBorrowUsdcUnits: string;
  };
  protocols: ProtocolObservations;
};

export type AgentSpec = {
  id: string;
  command: string;
  args?: string[];
  wallet: string;
  description?: string;
  env?: Record<string, string>;
};

export type AgentsFile = {
  agents: AgentSpec[];
};

export type WalletRole =
  | "agent"
  | "uninformed-flow"
  | "informed-flow"
  | "setup"
  | "admin"
  | "keeper";

export type SimWallet = {
  id: string;
  role: WalletRole;
  privateKey: Hex;
};

export type TxIntent = {
  ownerId: string;
  role: WalletRole;
  privateKey: Hex;
  protocol: ProtocolId;
  action: LeafAction;
  priorityFeeWei: bigint;
  bundleId?: string;
  bundleIndex?: number;
  gmxOrder?: boolean;
};

export type RawTxIntent = {
  ownerId: string;
  role: WalletRole;
  privateKey: Hex;
  rawTx: RawTx;
  priorityFeeWei: bigint;
  bundleId?: string;
  bundleIndex?: number;
};

export type BalanceSnapshot = {
  ethWei: bigint;
  wethWei: bigint;
  usdcUnits: bigint; // active stable の合算（表示/PnL 用）
  // stable トークンアドレス(小文字) -> 残高。検証は venue ごとの stable をこのマップで個別確認する。
  stables?: Record<string, bigint>;
};
