import type { Address } from "viem";
import type { MarketLegs, TokenSymbol } from "./types.js";
import { LOCAL_DEPLOYMENT } from "./constants.local.js";

// ---------------------------------------------------------------------------
// Arbitrum One。単一フォーク上で全プロトコルを動かす。
// アドレスは anvil-oracle-fork/bot/src/config.ts および bot/src/aave/config.ts から移植。
//
// ERIS_LOCAL_DEPLOY=1 のときは同梱 deployer/ のローカルデプロイ済アドレス
// (scripts/genLocalConstants.ts が生成する constants.local.ts) を overlay する。
// それ以外 (fork) は下の Arbitrum 既定を使う。
// ---------------------------------------------------------------------------

const L = process.env.ERIS_LOCAL_DEPLOY === "1" ? LOCAL_DEPLOYMENT : null;

export const CHAIN_ID = L?.CHAIN_ID ?? 42161;

// TokenSymbol は types.ts の単一定義（=string、ADR 0013）に統一。constants 経由で import
// している既存箇所のため re-export する。
export type { TokenSymbol };

// ADR 0013: トークンレジストリ。Record<symbol,...> 型注釈で TokenSymbol(=string) による
// インデックスアクセスを許可する。local-deploy では WBTC 等が overlay で増える。
export const TOKENS: Record<string, { address: Address; decimals: number }> =
  L?.TOKENS ?? {
    WETH: {
      address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address,
      decimals: 18,
    },
    USDC: {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address,
      decimals: 6,
    },
  };

// stable 統一会計: native USDC / USDC.e / USDT(USD₮0) をすべて $1・6 桁の「USDC 相当」とみなす。
// Arbitrum では Balancer/Curve の深い WETH/stable プールが USDC.e / USDT ペアのため、
// venue ごとに異なる stable を使いつつ残高・PnL は合算する。
export const USDC_VARIANTS = L?.USDC_VARIANTS ?? {
  native: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address,
  bridged: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8" as Address, // USDC.e
  usdt: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Address, // USD₮0
};

export function tokenAddress(symbol: TokenSymbol): Address {
  return TOKENS[symbol].address;
}

export function tokenDecimals(symbol: TokenSymbol): number {
  return TOKENS[symbol].decimals;
}

export function oppositeToken(symbol: TokenSymbol): TokenSymbol {
  return symbol === "WETH" ? "USDC" : "WETH";
}

// venue ごとの stable 残高を引く。stables マップが無い場合は合算値にフォールバック。
export function stableBalanceOf(
  balances: { usdcUnits: bigint; stables?: Record<string, bigint> },
  token: Address,
): bigint {
  return balances.stables?.[token.toLowerCase()] ?? balances.usdcUnits;
}

export function symbolForAddress(addr: Address): TokenSymbol | undefined {
  const lower = addr.toLowerCase();
  if (lower === TOKENS.WETH.address.toLowerCase()) return "WETH";
  if (lower === TOKENS.USDC.address.toLowerCase()) return "USDC";
  return undefined;
}

// ---------------------------------------------------------------------------
// Uniswap V3 (Arbitrum)。SwapRouter(v1)/NPM/QuoterV2 は mainnet と同一アドレス。
// WETH/USDC(native) 0.05% プール。フォークブロックで存在を確認すること。
// 注: Arbitrum では WETH(0x82aF) < USDC(0xaf88) のため token0=WETH, token1=USDC。
// ---------------------------------------------------------------------------
export const UNISWAP = L?.UNISWAP ?? {
  poolWethUsdc500: "0xC6962004f452bE9203591991D15f6b388e09E8D0" as Address,
  swapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564" as Address,
  nonfungiblePositionManager:
    "0xC36442b4a4522E871399CD717aBDD847Ab11FE88" as Address,
  quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as Address,
  fee: 500,
  tickSpacing: 10,
};

// Multicall3。fork(Arbitrum)では全チェーン共通の標準デプロイ。ローカルでは deployer が
// 配置したアドレスを overlay。歴史ブロック断面の一括読取（ADR 0006 §4）に使う。
export const MULTICALL3 =
  L?.MULTICALL3 ?? ("0xcA11bde05977b3631167028862bE2a173976CA11" as Address);

export const WETH_USDC_FEE = UNISWAP.fee;
export const WETH_USDC_TICK_SPACING = UNISWAP.tickSpacing;
export const WETH_DECIMALS = 18;
export const USDC_DECIMALS = 6;
export const MAX_BUNDLE_ACTIONS = 5;

// ---------------------------------------------------------------------------
// Balancer v2。33/33/34 加重プール [WETH, native USDC, USDT]（poolId 確認済み）。
// フォーク時点では枯渇しているため setupGlobal で admin が joinPool して seed する。
// stable は native USDC を使用（プールに含まれる）。
// ---------------------------------------------------------------------------
export const BALANCER = L?.BALANCER ?? {
  vault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Address,
  queries: "0xE39B5e3B6D74016b2F6A9673D7d7493B6DF549d5" as Address,
  pool: "0x3b106b7ae88c3f8869b5221d2bbae398afc26737" as Address,
  poolId:
    "0x3b106b7ae88c3f8869b5221d2bbae398afc26737000100000000000000000534" as `0x${string}`,
  // Vault に登録されたトークン順（getPoolTokens 準拠）
  tokens: [
    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // native USDC
    "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
  ] as Address[],
  usdcToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address,
  // seed 投入量（admin が join）。ETH~$2100 想定で 33/33/34 にほぼ均衡。
  seedWethWei: 200_000_000_000_000_000_000n, // 200 WETH
  seedUsdcUnits: 420_000_000_000n, // 420,000 USDC
  seedUsdtUnits: 420_000_000_000n, // 420,000 USDT
};

// ---------------------------------------------------------------------------
// Curve (Arbitrum) tricrypto 0x960ea3: coins [USDT(0), WBTC(1), WETH(2)]（深い）。
// WETH<->USDT leg のみ使用。stable は USDT。
// ---------------------------------------------------------------------------
export const CURVE = L?.CURVE ?? {
  pool: "0x960ea3e3C7FB317332d990873d354E18d7645590" as Address,
  wethIndex: 2,
  usdtIndex: 0,
  usdcToken: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Address, // USDT
};

// ---------------------------------------------------------------------------
// GMX v2 (gmx-synthetics) Arbitrum One デプロイアドレス
// ---------------------------------------------------------------------------
export const GMX = L?.GMX ?? {
  RoleStore: "0x3c3d99FD298f679DBC2CEcd132b4eC4d0F5e6e72" as Address,
  DataStore: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8" as Address,
  Oracle: "0x7F01614cA5198Ec979B1aAd1DAF0DE7e0a215BDF" as Address,
  EventEmitter: "0xC8ee91A54287DB53897056e12D9819156D3822Fb" as Address,
  Router: "0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6" as Address,
  ExchangeRouter: "0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41" as Address,
  OrderHandler: "0x63492B775e30a9E6b4b4761c12605EB9d071d5e9" as Address,
  OrderVault: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5" as Address,
  LiquidationHandler: "0xaf157Eb8e2398A8E1Fc1dA929974652b9ba9BC25" as Address,
  Reader: "0x470fbC46bcC0f16532691Df360A07d8Bf5ee0789" as Address,
  Config: "0x0BBbbF9D0cbdE8069e926c859E530B00Bfe90072" as Address,
};

export const GMX_MARKETS = L?.GMX_MARKETS ?? {
  ETH_USD: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336" as Address, // ETH/USD [WETH-USDC]
};

// ---------------------------------------------------------------------------
// Aave v3 (Arbitrum)
// ---------------------------------------------------------------------------
export const AAVE = L?.AAVE ?? {
  PoolAddressesProvider:
    "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb" as Address,
  Pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as Address,
  AaveOracle: "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7" as Address,
  AclAdmin: "0xFF1137243698CaA18EE364Cc966CF0e02A4e6327" as Address,
  AclManager: "0xa72636CbcAa8F5FF95B2cc47F3CDEe83F3294a0B" as Address,
  PoolDataProvider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b" as Address,
};

// ---------------------------------------------------------------------------
// market leg レジストリ（ADR 0013）。protocol × base ごとの venue 固有 leg。
// fork 既定は WETH/USDC のみ（既存の venue 定数から構築）。local-deploy では
// genLocalConstants が WBTC 等を加えた MARKET_LEGS を overlay する（L?.MARKET_LEGS）。
// markets.ts がこれを MarketConfig へ組み立て、adapter が回す。新トークンは leg 追加で増える。
// ---------------------------------------------------------------------------
export const MARKET_LEGS: MarketLegs = L?.MARKET_LEGS ?? {
  uniswap: {
    WETH: {
      pool: UNISWAP.poolWethUsdc500,
      fee: UNISWAP.fee,
      tickSpacing: UNISWAP.tickSpacing,
    },
  },
  balancer: {
    WETH: {
      poolId: BALANCER.poolId,
      tokens: BALANCER.tokens,
      stable: BALANCER.usdcToken,
    },
  },
  curve: {
    WETH: {
      pool: CURVE.pool,
      baseIndex: CURVE.wethIndex,
      quoteIndex: CURVE.usdtIndex,
      stable: CURVE.usdcToken,
    },
  },
  gmx: {
    WETH: { market: GMX_MARKETS.ETH_USD },
  },
  aave: {
    WETH: {},
  },
};

// ---------------------------------------------------------------------------
// USDC 調達用 whale（フォークブロックで残高があるものを順に試す）
// ---------------------------------------------------------------------------
export const WHALES = {
  USDC: [
    "0x47c031236e19d024b42f8AE6780E44A573170703",
    "0x8b8149dd385955DC1cE77a4bE7700CCD6a212e65",
    "0x489ee077994B6658eAfA855C308275EAd8097C4A",
  ] as Address[],
} as const;

export const DEFAULT_ANVIL_PRIVATE_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
] as const;
