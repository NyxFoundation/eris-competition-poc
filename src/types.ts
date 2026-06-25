import type { Address, Hex } from "viem";

// トークンレジストリ（src/markets.ts の TOKENS）のキー。リテラル union を剥がし string 化
// （トークン追加を定数追加だけで行えるようにするため。ADR 0013）。実在は TOKENS で管理する。
export type TokenSymbol = string;
// base = USD 価格を持つ取引対象（WETH/WBTC…）、stable = $1 固定の決済通貨（USDC 相当）。
export type TokenKind = "base" | "stable";

export type ProtocolId = "uniswap" | "balancer" | "curve" | "gmx" | "aave";

// ---------------------------------------------------------------------------
// market leg（venue 固有メタ。ADR 0013）。protocol × base ごとに 1 つ。
// MARKET_LEGS（constants）が protocol→base→leg のテーブルを持ち、markets.ts が
// MarketConfig へ組み立てる。新トークンは leg を 1 つ足すだけで market が増える。
// ---------------------------------------------------------------------------
export type UniswapLeg = { pool: Address; fee: number; tickSpacing: number };
export type BalancerLeg = { poolId: Hex; tokens: Address[]; stable: Address };
export type CurveLeg = {
  pool: Address;
  baseIndex: number;
  quoteIndex: number;
  stable: Address;
};
export type GmxLeg = { market: Address };
export type AaveLeg = Record<string, never>;
export type MarketLegs = {
  uniswap: Record<TokenSymbol, UniswapLeg>;
  balancer: Record<TokenSymbol, BalancerLeg>;
  curve: Record<TokenSymbol, CurveLeg>;
  gmx: Record<TokenSymbol, GmxLeg>;
  aave: Record<TokenSymbol, AaveLeg>;
};

// ---------------------------------------------------------------------------
// アクション型
// ---------------------------------------------------------------------------

// Uniswap
export type SwapAction = {
  type: "swap";
  tokenIn: TokenSymbol;
  // 取引 market の base（既定 WETH。ADR 0013）。tokenIn は base か quote のどちらか。
  base?: TokenSymbol;
  amountIn: string;
  maxPriorityFeePerGasWei?: string;
  slippageBps?: number;
};

export type MintLiquidityAction = {
  type: "mintLiquidity";
  // ADR 0013: market の base（既定 WETH）。base 指定時は amountBase/QuoteDesired を使う。
  base?: TokenSymbol;
  tickLower: number;
  tickUpper: number;
  // WETH market 互換フィールド（base 未指定時に必須）。
  amountWethDesired: string;
  amountUsdcDesired: string;
  // 汎用フィールド（base 指定時に使用）。
  amountBaseDesired?: string;
  amountQuoteDesired?: string;
  slippageBps?: number;
  maxPriorityFeePerGasWei?: string;
};

export type RemoveLiquidityAction = {
  type: "removeLiquidity";
  base?: TokenSymbol; // ADR 0013: market の base（既定 WETH）。amountWethMin は base min。
  tokenId: string;
  liquidity: string;
  amountWethMin?: string;
  amountUsdcMin?: string;
  maxPriorityFeePerGasWei?: string;
};

export type CollectFeesAction = {
  type: "collectFees";
  base?: TokenSymbol; // ADR 0013: market の base（既定 WETH）
  tokenId: string;
  maxPriorityFeePerGasWei?: string;
};

// Balancer v2 / Curve（spot swap）
export type BalancerSwapAction = {
  type: "balancerSwap";
  tokenIn: TokenSymbol;
  base?: TokenSymbol; // ADR 0013: market の base（既定 WETH）
  amountIn: string;
  slippageBps?: number;
  maxPriorityFeePerGasWei?: string;
};

export type CurveSwapAction = {
  type: "curveSwap";
  tokenIn: TokenSymbol;
  base?: TokenSymbol; // ADR 0013: market の base（既定 WETH）
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
  base?: TokenSymbol; // ADR 0013: index market の base（既定 WETH = ETH/USD）
  collateral: TokenSymbol;
  collateralAmount: string; // token units
  sizeDeltaUsd: string; // GMX 1e30 スケール USD
  acceptablePrice?: string; // GMX 1e(30-decimals) スケール。省略時は LOOSE
  maxPriorityFeePerGasWei?: string;
};
export type GmxDecreaseAction = {
  type: "gmxDecrease";
  isLong: boolean;
  base?: TokenSymbol; // ADR 0013: index market の base（既定 WETH = ETH/USD）
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
  // 命名は WETH/USDC 互換のまま。WBTC market の position では base=WBTC 量・quote=USDC 量が入る。
  tokensOwedWethWei: string;
  tokensOwedUsdcUnits: string;
  amountWethWei: string;
  amountUsdcUnits: string;
  valueUsdc: number;
  // ADR 0013: WETH 以外の market（"WBTC/USDC" 等）。未指定は WETH/USDC。
  market?: string;
};

export type UniswapMarketObservation = {
  pair: string;
  fee: number;
  priceUsdcPerWeth: number; // base/USD（命名は WETH 互換のまま。値は当該 base の価格）
  tick: number;
  tickSpacing: number;
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
  // ADR 0013: WETH 以外の market（WBTC/USDC 等）。WETH market は pool/positions に載せ続ける。
  markets?: Record<string, UniswapMarketObservation>;
};

export type AmmObservation = {
  priceUsdcPerWeth: number;
  reserves?: { weth: string; usdc: string };
  // ADR 0013: WETH 以外の market（priceUsdcPerWeth は当該 base/USD）。
  markets?: Record<
    string,
    { priceUsdcPerWeth: number; reserves?: { weth: string; usdc: string } }
  >;
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
  // ADR 0013: WETH 以外の index market（BTC/USD 等）。
  markets?: Record<
    string,
    { marketPriceUsd: number; position?: GmxPositionObservation }
  >;
};

export type AaveObservation = {
  healthFactor: string;
  totalCollateralBase: string;
  totalDebtBase: string;
  availableBorrowsBase: string;
  supplied: Partial<Record<TokenSymbol, string>>;
  borrowed: Partial<Record<TokenSymbol, string>>;
  poolLiquidity?: Partial<Record<TokenSymbol, string>>;
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
  // ADR 0013: マルチアセット。WETH market は上記既存フィールドに載せ続け、追加 base はここに。
  // 既存戦略は未参照でも動く（後方互換）。WBTC を見る戦略だけ参照する。
  fairPricesUsd?: Record<TokenSymbol, number>;
  baseBalances?: Record<TokenSymbol, string>;
  markets?: string[];
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
  // 競争シグナル（ADR 0011。economicGas で priority-fee オークションを実力化する観測）。
  // direct モードで agent が直近ブロックから自己導出する（env 特権でなく、現実の MEV searcher が
  // 直近ブロックを見るのと同じ）。relay モードや観測初期は undefined。
  competition?: {
    // 直近ブロックで観測した「自分以外」の最高 priority fee（wei, decimal string）。
    // これを僅かに上回れば順序で勝てる目安。0 = 競合の入札 tx が無かった。
    maxCompetitorPriorityFeeWei: string;
    // 直近ブロック全体（自分含む）の最高 priority fee（wei）。
    maxBlockPriorityFeeWei: string;
    // 自分の直近 included tx の txIndex（0=先頭が理想。null=直近で included 無し）。
    lastTxIndex: number | null;
    // 直近 included tx の revert 率（先約定/slippage で失敗した割合 0..1）。高い=積み負けの兆候。
    recentRevertRate: number;
    // revert 率の母数（直近 included tx 数）。
    recentSampleSize: number;
  };
};

export type AgentSpec = {
  id: string;
  command: string;
  args?: string[];
  wallet: string;
  description?: string;
  env?: Record<string, string>;
  // 識別力判定(scripts/discrimination.ts)の物差し。true なら noop/random 等のベースライン。
  baseline?: boolean;
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
  // ADR 0013: base シンボル -> 残高（WETH/WBTC 等）。wethWei は bases["WETH"] と同値で互換維持。
  bases?: Record<string, bigint>;
  // stable トークンアドレス(小文字) -> 残高。検証は venue ごとの stable をこのマップで個別確認する。
  stables?: Record<string, bigint>;
};
