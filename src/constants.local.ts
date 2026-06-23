// ローカル(非fork)デプロイ用アドレスの上書き定義。
// 既定はスタブ(null)で、fork(Arbitrum)モードでは constants.ts が Arbitrum 既定を使う。
// `npm run gen:local-constants` で eris-app-deployer の deployments.json から本ファイルを
// 再生成し、`ERIS_LOCAL_DEPLOY=1` で constants.ts がこの値を overlay する。
// 生成版はローカル run 専用なので通常コミットしない（git checkout で本スタブに戻せる）。
import type { Address } from "viem";

export type LocalDeployment = {
  CHAIN_ID: number;
  TOKENS: {
    WETH: { address: Address; decimals: number };
    USDC: { address: Address; decimals: number };
  };
  USDC_VARIANTS: { native: Address; bridged: Address; usdt: Address };
  UNISWAP: {
    poolWethUsdc500: Address;
    swapRouter: Address;
    nonfungiblePositionManager: Address;
    quoterV2: Address;
    fee: number;
    tickSpacing: number;
  };
  MULTICALL3: Address;
  BALANCER: {
    vault: Address;
    queries: Address;
    pool: Address;
    poolId: `0x${string}`;
    tokens: Address[];
    usdcToken: Address;
    seedWethWei: bigint;
    seedUsdcUnits: bigint;
    seedUsdtUnits: bigint;
  };
  CURVE: {
    pool: Address;
    wethIndex: number;
    usdtIndex: number;
    usdcToken: Address;
  };
  GMX: {
    RoleStore: Address;
    DataStore: Address;
    Oracle: Address;
    EventEmitter: Address;
    Router: Address;
    ExchangeRouter: Address;
    OrderHandler: Address;
    OrderVault: Address;
    LiquidationHandler: Address;
    Reader: Address;
    Config: Address;
  };
  GMX_MARKETS: { ETH_USD: Address };
  AAVE: {
    PoolAddressesProvider: Address;
    Pool: Address;
    AaveOracle: Address;
    AclAdmin: Address;
    AclManager: Address;
    PoolDataProvider: Address;
  };
};

export const LOCAL_DEPLOYMENT: LocalDeployment | null = null;
