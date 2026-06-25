/**
 * deployments.json (eris-app-deployer のローカルデプロイ出力) → src/constants.local.ts 生成。
 *
 * ローカル(非fork)anvil に全 protocol をデプロイした際の決定論アドレスを poc の
 * 定数へ橋渡しする。生成された LOCAL_DEPLOYMENT を constants.ts が ERIS_LOCAL_DEPLOY=1 の
 * ときだけ overlay する (fork 時は Arbitrum 既定を使う)。
 *
 * 使い方:
 *   DEPLOYMENTS_JSON=/path/to/eris-app-deployer/deployments/deployments.json \
 *     npm run gen:local-constants
 *
 * 既定の DEPLOYMENTS_JSON は隣接 repo ../eris-app-deployer/deployments/deployments.json。
 *
 * ADR 0013: deployments.json に WBTC（tokens.WBTC + 各 venue の wbtcUsdc* / gmx WBTC market）が
 * あれば TOKENS.WBTC と MARKET_LEGS の WBTC leg を生成する。無ければ WETH のみ（後方互換）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, type Address } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// anvil 既定 mnemonic の index0 = deployer。Aave の ACL admin = deployer。
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

type Deployments = {
  chainId: number;
  tokens: Record<string, string>;
  protocols: {
    common?: { multicall3?: string };
    uniswapV3?: Record<string, string>;
    balancerV2?: Record<string, string>;
    curve?: Record<string, string | number>;
    gmxV2?: Record<string, unknown> & {
      markets?: {
        marketToken: string;
        indexToken: string;
        longToken: string;
        shortToken: string;
      }[];
    };
    aaveV3?: Record<string, unknown>;
  };
};

type GmxMarketList = NonNullable<
  NonNullable<Deployments["protocols"]["gmxV2"]>["markets"]
>;

function loadDeployments(): { path: string; data: Deployments } {
  const path =
    process.env.DEPLOYMENTS_JSON ??
    resolve(ROOT, "..", "eris-app-deployer", "deployments", "deployments.json");
  const data = JSON.parse(readFileSync(path, "utf8")) as Deployments;
  return { path, data };
}

function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null)
    throw new Error(`deployments.json に ${what} がありません`);
  return v;
}

function ca(v: string | undefined, what: string): Address {
  return getAddress(need(v, what));
}

// ADR 0013: WBTC market 群（deployments.json に WBTC があれば構築。無ければ undefined）。
type WbtcInfo = {
  token: Address;
  uniPool?: Address;
  balPool?: Address;
  balPoolId?: string;
  balTokens?: Address[];
  curvePool?: Address;
  curveBaseIndex?: number;
  curveQuoteIndex?: number;
  gmxMarket?: Address;
};

function main() {
  const { path, data } = loadDeployments();
  const t = data.tokens;
  const p = data.protocols;

  const weth = ca(t.WETH, "tokens.WETH");
  const usdc = ca(t.USDC, "tokens.USDC");
  const usdt = t.USDT ? getAddress(t.USDT) : usdc;

  const uni = need(p.uniswapV3, "protocols.uniswapV3");
  const bal = need(p.balancerV2, "protocols.balancerV2");
  const gmx = need(p.gmxV2, "protocols.gmxV2") as Record<string, string> & {
    markets?: GmxMarketList;
  };
  const aave = need(p.aaveV3, "protocols.aaveV3") as Record<string, string>;
  const multicall3 = ca(p.common?.multicall3, "protocols.common.multicall3");

  // Balancer は昇順登録。deployer プールは [WETH, USDC] (80/20)。
  const balTokens = (
    weth.toLowerCase() < usdc.toLowerCase() ? [weth, usdc] : [usdc, weth]
  ) as Address[];

  // GMX ETH/USD マーケット = indexToken==WETH のもの。
  const markets = need(gmx.markets, "gmxV2.markets");
  const ethMarket = markets.find(
    (m) => m.indexToken.toLowerCase() === weth.toLowerCase(),
  );
  const ethUsdMarket = ca(
    ethMarket?.marketToken,
    "gmxV2 ETH/USD market (indexToken==WETH)",
  );

  // Curve: deployer が twocrypto-ng の WETH/USDC crypto pool を立てる (uint256 index)。
  // coin0=USDC(stable)=0, coin1=WETH=1。poc CURVE は WETH<->stable leg を使う。
  const curveP = p.curve as
    | (Record<string, string | number> & {
        wethUsdcCryptoPool?: string;
        cryptoWethIndex?: number;
        cryptoStableIndex?: number;
        wbtcUsdcCryptoPool?: string;
        cryptoWbtcIndex?: number;
        cryptoWbtcStableIndex?: number;
      })
    | undefined;
  const curve = {
    pool: ca(curveP?.wethUsdcCryptoPool as string, "curve.wethUsdcCryptoPool"),
    wethIndex: Number(need(curveP?.cryptoWethIndex, "curve.cryptoWethIndex")),
    usdtIndex: Number(
      need(curveP?.cryptoStableIndex, "curve.cryptoStableIndex"),
    ),
  };

  // ---- ADR 0013: WBTC（あれば各 venue の leg を集める。無ければ WETH のみ）----
  const wbtc = t.WBTC ? getAddress(t.WBTC) : undefined;
  let wbtcInfo: WbtcInfo | undefined;
  if (wbtc) {
    const wbtcMarket = markets.find(
      (m) => m.indexToken.toLowerCase() === wbtc.toLowerCase(),
    );
    const balWbtcTokens = (
      wbtc.toLowerCase() < usdc.toLowerCase() ? [wbtc, usdc] : [usdc, wbtc]
    ) as Address[];
    wbtcInfo = {
      token: wbtc,
      uniPool: uni.wbtcUsdcPool ? getAddress(uni.wbtcUsdcPool) : undefined,
      balPool: bal.wbtcUsdcPool ? getAddress(bal.wbtcUsdcPool) : undefined,
      balPoolId: bal.wbtcUsdcPoolId,
      balTokens: balWbtcTokens,
      curvePool: curveP?.wbtcUsdcCryptoPool
        ? getAddress(curveP.wbtcUsdcCryptoPool)
        : undefined,
      curveBaseIndex:
        curveP?.cryptoWbtcIndex !== undefined
          ? Number(curveP.cryptoWbtcIndex)
          : undefined,
      curveQuoteIndex:
        curveP?.cryptoWbtcStableIndex !== undefined
          ? Number(curveP.cryptoWbtcStableIndex)
          : undefined,
      gmxMarket: wbtcMarket?.marketToken
        ? getAddress(wbtcMarket.marketToken)
        : undefined,
    };
  }

  const out = render({
    deploymentsPath: path,
    chainId: data.chainId,
    weth,
    usdc,
    usdt,
    multicall3,
    uni: {
      pool: ca(uni.wethUsdcPool, "uniswapV3.wethUsdcPool"),
      swapRouter: ca(uni.swapRouter, "uniswapV3.swapRouter"),
      npm: ca(uni.positionManager, "uniswapV3.positionManager"),
      quoterV2: ca(uni.quoterV2, "uniswapV3.quoterV2"),
    },
    bal: {
      vault: ca(bal.vault, "balancerV2.vault"),
      queries: ca(bal.queries, "balancerV2.queries"),
      pool: ca(bal.wethUsdcPool, "balancerV2.wethUsdcPool"),
      poolId: need(bal.wethUsdcPoolId, "balancerV2.wethUsdcPoolId"),
      tokens: balTokens,
    },
    curve,
    gmx: {
      RoleStore: ca(gmx.RoleStore, "gmxV2.RoleStore"),
      DataStore: ca(gmx.DataStore, "gmxV2.DataStore"),
      Oracle: ca(gmx.Oracle, "gmxV2.Oracle"),
      EventEmitter: ca(gmx.EventEmitter, "gmxV2.EventEmitter"),
      Router: ca(gmx.Router, "gmxV2.Router"),
      ExchangeRouter: ca(gmx.ExchangeRouter, "gmxV2.ExchangeRouter"),
      OrderHandler: ca(gmx.OrderHandler, "gmxV2.OrderHandler"),
      OrderVault: ca(gmx.OrderVault, "gmxV2.OrderVault"),
      LiquidationHandler: ca(
        gmx.LiquidationHandler,
        "gmxV2.LiquidationHandler",
      ),
      Reader: ca(gmx.Reader, "gmxV2.Reader"),
      Config: ca(gmx.Config, "gmxV2.Config"),
    },
    ethUsdMarket,
    aave: {
      PoolAddressesProvider: ca(
        aave.poolAddressesProvider,
        "aaveV3.poolAddressesProvider",
      ),
      Pool: ca(aave.pool, "aaveV3.pool"),
      AaveOracle: ca(aave.aaveOracle, "aaveV3.aaveOracle"),
      AclAdmin: DEPLOYER,
      AclManager: ca(aave.aclManager, "aaveV3.aclManager"),
      PoolDataProvider: ca(aave.poolDataProvider, "aaveV3.poolDataProvider"),
    },
    wbtc: wbtcInfo,
  });

  const target = resolve(ROOT, "src", "constants.local.ts");
  writeFileSync(target, out);
  console.log(`✓ 生成: ${target}`);
  console.log(`  入力: ${path} (chainId=${data.chainId})`);
  console.log(`  WETH=${weth} USDC=${usdc} Multicall3=${multicall3}`);
  if (wbtcInfo) {
    console.log(
      `  WBTC=${wbtcInfo.token} (uni=${wbtcInfo.uniPool ?? "-"} bal=${wbtcInfo.balPool ?? "-"} curve=${wbtcInfo.curvePool ?? "-"} gmx=${wbtcInfo.gmxMarket ?? "-"})`,
    );
  } else {
    console.log(`  WBTC: なし（WETH のみ。MARKET_LEGS は WETH 単一）`);
  }
  console.log(`  ローカル run: ERIS_LOCAL_DEPLOY=1 を設定して使用`);
}

function render(d: {
  deploymentsPath: string;
  chainId: number;
  weth: Address;
  usdc: Address;
  usdt: Address;
  multicall3: Address;
  uni: { pool: Address; swapRouter: Address; npm: Address; quoterV2: Address };
  bal: {
    vault: Address;
    queries: Address;
    pool: Address;
    poolId: string;
    tokens: Address[];
  };
  curve: { pool: Address; wethIndex: number; usdtIndex: number };
  gmx: Record<string, Address>;
  ethUsdMarket: Address;
  aave: Record<string, Address>;
  wbtc?: WbtcInfo;
}): string {
  const a = (x: string) => `"${x}" as Address`;
  const w = d.wbtc;

  // ---- TOKENS の WBTC エントリ（あれば）----
  const tokensWbtc = w
    ? `\n    WBTC: { address: ${a(w.token)}, decimals: 8 },`
    : "";

  // ---- MARKET_LEGS（WETH + WBTC leg。WBTC leg は当該 venue のアドレスが揃っているものだけ）----
  const uniWbtc = w?.uniPool
    ? `\n      WBTC: { pool: ${a(w.uniPool)}, fee: 3000, tickSpacing: 60 },`
    : "";
  const balWbtc =
    w?.balPool && w?.balPoolId
      ? `\n      WBTC: { poolId: "${w.balPoolId}" as \`0x\${string}\`, tokens: [${w.balTokens!.map(a).join(", ")}], stable: ${a(d.usdc)} },`
      : "";
  const curveWbtc =
    w?.curvePool &&
    w?.curveBaseIndex !== undefined &&
    w?.curveQuoteIndex !== undefined
      ? `\n      WBTC: { pool: ${a(w.curvePool)}, baseIndex: ${w.curveBaseIndex}, quoteIndex: ${w.curveQuoteIndex}, stable: ${a(d.usdc)} },`
      : "";
  const gmxWbtc = w?.gmxMarket
    ? `\n      WBTC: { market: ${a(w.gmxMarket)} },`
    : "";
  const aaveWbtc = w ? `\n      WBTC: {},` : "";

  const marketLegs = `
  MARKET_LEGS: {
    uniswap: {
      WETH: { pool: ${a(d.uni.pool)}, fee: 3000, tickSpacing: 60 },${uniWbtc}
    },
    balancer: {
      WETH: { poolId: "${d.bal.poolId}" as \`0x\${string}\`, tokens: [${d.bal.tokens.map(a).join(", ")}], stable: ${a(d.usdc)} },${balWbtc}
    },
    curve: {
      WETH: { pool: ${a(d.curve.pool)}, baseIndex: ${d.curve.wethIndex}, quoteIndex: ${d.curve.usdtIndex}, stable: ${a(d.usdc)} },${curveWbtc}
    },
    gmx: {
      WETH: { market: ${a(d.ethUsdMarket)} },${gmxWbtc}
    },
    aave: {
      WETH: {},${aaveWbtc}
    },
  },`;

  return `// AUTO-GENERATED by scripts/genLocalConstants.ts — 手で編集しない。
// 入力: ${d.deploymentsPath}
// ローカル(非fork)anvil に全 protocol をデプロイした際の決定論アドレス。
// constants.ts が ERIS_LOCAL_DEPLOY=1 のときだけ overlay する。
import type { Address } from "viem";
import type { MarketLegs } from "./types.js";

export type LocalDeployment = {
  CHAIN_ID: number;
  TOKENS: {
    WETH: { address: Address; decimals: number };
    USDC: { address: Address; decimals: number };
    WBTC?: { address: Address; decimals: number };
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
    poolId: \`0x\${string}\`;
    tokens: Address[];
    usdcToken: Address;
    seedWethWei: bigint;
    seedUsdcUnits: bigint;
    seedUsdtUnits: bigint;
  };
  CURVE: { pool: Address; wethIndex: number; usdtIndex: number; usdcToken: Address };
  GMX: {
    RoleStore: Address; DataStore: Address; Oracle: Address; EventEmitter: Address;
    Router: Address; ExchangeRouter: Address; OrderHandler: Address; OrderVault: Address;
    LiquidationHandler: Address; Reader: Address; Config: Address;
  };
  GMX_MARKETS: { ETH_USD: Address };
  AAVE: {
    PoolAddressesProvider: Address; Pool: Address; AaveOracle: Address;
    AclAdmin: Address; AclManager: Address; PoolDataProvider: Address;
  };
  // ADR 0013: マルチアセット market leg（WBTC 等）。WBTC が deployments.json にあれば WBTC leg を含む。
  MARKET_LEGS?: MarketLegs;
};

export const LOCAL_DEPLOYMENT: LocalDeployment | null = {
  CHAIN_ID: ${d.chainId},
  TOKENS: {
    WETH: { address: ${a(d.weth)}, decimals: 18 },
    USDC: { address: ${a(d.usdc)}, decimals: 6 },${tokensWbtc}
  },
  // ローカルは単一 USDC/USDT。native/bridged は同一 USDC、usdt は USDT に対応。
  USDC_VARIANTS: {
    native: ${a(d.usdc)},
    bridged: ${a(d.usdc)},
    usdt: ${a(d.usdt)},
  },
  UNISWAP: {
    poolWethUsdc500: ${a(d.uni.pool)},
    swapRouter: ${a(d.uni.swapRouter)},
    nonfungiblePositionManager: ${a(d.uni.npm)},
    quoterV2: ${a(d.uni.quoterV2)},
    // deployer の WETH/USDC プールは fee=3000(0.3%) / tickSpacing=60。
    fee: 3000,
    tickSpacing: 60,
  },
  MULTICALL3: ${a(d.multicall3)},
  BALANCER: {
    vault: ${a(d.bal.vault)},
    queries: ${a(d.bal.queries)},
    pool: ${a(d.bal.pool)},
    poolId: "${d.bal.poolId}" as \`0x\${string}\`,
    // deployer プールは [WETH, USDC] の 2 トークン (80/20)。USDT leg は無い。
    tokens: [${d.bal.tokens.map((x) => a(x)).join(", ")}],
    usdcToken: ${a(d.usdc)},
    seedWethWei: 100_000_000_000_000_000_000n,
    seedUsdcUnits: 50_000_000_000n,
    seedUsdtUnits: 0n,
  },
  // Curve: twocrypto-ng の WETH/USDC crypto pool (uint256 index get_dy/exchange)。
  // coin0=USDC(stable)=${d.curve.usdtIndex}, coin1=WETH=${d.curve.wethIndex}。usdcToken は pool の stable=USDC。
  CURVE: {
    pool: ${a(d.curve.pool)},
    wethIndex: ${d.curve.wethIndex},
    usdtIndex: ${d.curve.usdtIndex},
    usdcToken: ${a(d.usdc)},
  },
  GMX: {
    RoleStore: ${a(d.gmx.RoleStore)},
    DataStore: ${a(d.gmx.DataStore)},
    Oracle: ${a(d.gmx.Oracle)},
    EventEmitter: ${a(d.gmx.EventEmitter)},
    Router: ${a(d.gmx.Router)},
    ExchangeRouter: ${a(d.gmx.ExchangeRouter)},
    OrderHandler: ${a(d.gmx.OrderHandler)},
    OrderVault: ${a(d.gmx.OrderVault)},
    LiquidationHandler: ${a(d.gmx.LiquidationHandler)},
    Reader: ${a(d.gmx.Reader)},
    Config: ${a(d.gmx.Config)},
  },
  GMX_MARKETS: { ETH_USD: ${a(d.ethUsdMarket)} },
  AAVE: {
    PoolAddressesProvider: ${a(d.aave.PoolAddressesProvider)},
    Pool: ${a(d.aave.Pool)},
    AaveOracle: ${a(d.aave.AaveOracle)},
    AclAdmin: ${a(d.aave.AclAdmin)},
    AclManager: ${a(d.aave.AclManager)},
    PoolDataProvider: ${a(d.aave.PoolDataProvider)},
  },${marketLegs}
};
`;
}

main();
