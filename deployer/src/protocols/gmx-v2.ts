import { spawnSync } from "node:child_process";
import {
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { getAddress, type Abi, type Address } from "viem";
import { publicClient } from "../clients.js";
import { ROOT, ok, info, assert, loadForgeArtifact } from "../util.js";
import { RPC_URL } from "../config.js";
import { setProtocol, getRegistry } from "../registry.js";
import { seedGmLiquidity, type GmDepositCore } from "./gmx-deposit.js";

const GMX_DIR = resolve(ROOT, "vendor", "gmx-src");
const DEPLOYMENTS = resolve(GMX_DIR, "deployments", "localhost");

function dep(name: string): { address: Address; abi: Abi } {
  const j = JSON.parse(
    readFileSync(resolve(DEPLOYMENTS, `${name}.json`), "utf8"),
  );
  return { address: j.address as Address, abi: j.abi as Abi };
}

// registry に取り込む主要コントラクト
const CORE = [
  "DataStore",
  "RoleStore",
  "EventEmitter",
  "Oracle",
  "Router",
  "ExchangeRouter",
  "Reader",
  "OrderHandler",
  "DepositHandler",
  "WithdrawalHandler",
  "LiquidationHandler",
  "MarketFactory",
  "OrderVault",
  "DepositVault",
  "WithdrawalVault",
  "Config",
];
const GMX_TOKENS = ["WETH", "GMX", "USDC", "WBTC", "USDT"];

// GMX と共有 mock を揃えるトークン (GMX 独自の GMX/ESGMX/SOL は除く)。
// WETH は WETH9 (wrappedNative)、それ以外は MockERC20。
const SHARED_TOKEN_KEYS = ["WETH", "USDC", "USDT", "WBTC"] as const;

/**
 * hardhat-deploy の deployments/localhost/<symbol>.json を**先置き**し、
 * deployTestTokens.ts の getOrNull 再利用パス (token を新規デプロイせず既存を流用) に乗せて
 * GMX が共有 mock トークンを採用するよう仕向ける。
 * rmSync 直後・hardhat deploy 実行前に呼ぶこと。
 */
function seedSharedTokenArtifacts() {
  const reg = getRegistry();
  mkdirSync(DEPLOYMENTS, { recursive: true });
  // hardhat-deploy はネットワークフォルダの .chainId を要求する
  writeFileSync(resolve(DEPLOYMENTS, ".chainId"), "31337");

  const weth9 = loadForgeArtifact("WETH9", "WETH9");
  const erc20 = loadForgeArtifact("MockERC20", "MockERC20");

  const shared: string[] = [];
  for (const key of SHARED_TOKEN_KEYS) {
    const raw = reg.tokens[key];
    if (!raw) continue; // 共有トークン未デプロイ (--only gmx 等) はスキップ
    // EIP-55 チェックサム必須: gmx.getTokens() はメモ化され、reused トークンの
    // address は checksum ループを通らないまま config に焼き付く。小文字のままだと
    // Reader.getMarkets が返す checksum 済アドレスと marketKey 文字列が不一致になり
    // deployAndConfigureMarkets が落ちる。
    const addr = getAddress(raw);
    const abi = key === "WETH" ? weth9.abi : erc20.abi;
    // hardhat-deploy の Deployment は最低限 {address, abi} で getOrNull が解決する。
    // bytecode は載せない (バイトコード一致検証を避ける)。
    writeFileSync(
      resolve(DEPLOYMENTS, `${key}.json`),
      JSON.stringify({ address: addr, abi }, null, 2),
    );
    shared.push(`${key}=${addr}`);
  }
  if (shared.length) ok("GMX 共有トークン先置き", shared.join(", "));
}

export async function deployGmxV2({ seed }: { seed: boolean }) {
  info("GMX V2 フルシステムを hardhat-deploy でデプロイ (重い: 数分かかる)");

  rmSync(DEPLOYMENTS, { recursive: true, force: true });
  seedSharedTokenArtifacts();

  const res = spawnSync(
    "npx",
    ["hardhat", "deploy", "--network", "localhost"],
    {
      cwd: GMX_DIR,
      env: { ...process.env, SKIP_AUTO_HANDLER_REDEPLOYMENT: "true", RPC_URL },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (res.status !== 0) {
    throw new Error(`gmx hardhat deploy が失敗しました (exit ${res.status})`);
  }
  assert(
    existsSync(DEPLOYMENTS),
    "gmx deployments/localhost が生成されていない",
  );

  const core: Record<string, Address> = {};
  for (const name of CORE) {
    if (existsSync(resolve(DEPLOYMENTS, `${name}.json`)))
      core[name] = dep(name).address;
  }
  const tokens: Record<string, Address> = {};
  for (const t of GMX_TOKENS) {
    if (existsSync(resolve(DEPLOYMENTS, `${t}.json`)))
      tokens[t] = dep(t).address;
  }

  setProtocol("gmxV2", { ...core, tokens });
  ok("GMX V2 デプロイ", `DataStore=${core.DataStore}`);
  ok("GMX トークン", Object.keys(tokens).join(", "));

  if (seed) {
    const markets = await recordMarkets();
    await seedGmMarket(core, tokens, markets);
  }
}

/**
 * 各 index market の GM プールへ流動性を投入する。空プールだと poc の GMX 取引 agent が
 * position を開けないため、deploy seed で deposit しておく。
 * ADR 0013: WETH(ETH/USD) に加え WBTC(BTC/USD) market も seed する。
 */
async function seedGmMarket(
  core: Record<string, Address>,
  tokens: Record<string, Address>,
  markets: GmMarketRecord[],
) {
  const weth = tokens.WETH;
  const usdc = tokens.USDC;
  const wbtc = tokens.WBTC;
  if (!weth || !usdc) return;

  const depositCore: GmDepositCore = {
    DataStore: core.DataStore,
    Oracle: core.Oracle,
    Router: core.Router,
    ExchangeRouter: core.ExchangeRouter,
    DepositVault: core.DepositVault,
    DepositHandler: core.DepositHandler,
  };

  // WETH/USDC: $3000/WETH で 200 WETH + 600k USDC を投入 ($1.2M, AMM venue と整合)
  const wethMarket = markets.find(
    (m) =>
      m.longToken.toLowerCase() === weth.toLowerCase() &&
      m.shortToken.toLowerCase() === usdc.toLowerCase(),
  );
  if (!wethMarket) {
    info("GM 流動性: WETH/USDC マーケットが無いためスキップ");
  } else {
    await seedGmLiquidity(
      depositCore,
      {
        marketToken: wethMarket.marketToken,
        longToken: wethMarket.longToken,
        shortToken: wethMarket.shortToken,
      },
      200n * 10n ** 18n,
      600_000n * 10n ** 6n,
      [
        { token: weth, usd: 3000, decimals: 18 },
        { token: usdc, usd: 1, decimals: 6 },
      ],
    );
  }

  // WBTC/USDC (BTC/USD market。ADR 0013)。index=WBTC で探す（long=WBTC, short=USDC）。
  // 無音 skip を防ぐため、WBTC トークンがあるのに market が見つからなければ throw。
  if (wbtc) {
    const wbtcMarket = markets.find(
      (m) =>
        m.indexToken.toLowerCase() === wbtc.toLowerCase() &&
        m.longToken.toLowerCase() === wbtc.toLowerCase() &&
        m.shortToken.toLowerCase() === usdc.toLowerCase(),
    );
    if (!wbtcMarket) {
      throw new Error(
        "GM 流動性: WBTC/USDC マーケットが見つからない (markets.ts localhost 配列に WBTC market が無い、または再 deploy 未実施)",
      );
    }
    // $60000/WBTC で 50 WBTC(decimals:8) + 3M USDC を投入。
    // 価格は toGmxPrice(60000, 8) 相当（WBTC decimals:8 を明示。18 のままだと 10^10 倍ずれて破綻）。
    await seedGmLiquidity(
      depositCore,
      {
        marketToken: wbtcMarket.marketToken,
        longToken: wbtcMarket.longToken,
        shortToken: wbtcMarket.shortToken,
      },
      50n * 10n ** 8n,
      3_000_000n * 10n ** 6n,
      [
        { token: wbtc, usd: 60000, decimals: 8 },
        { token: usdc, usd: 1, decimals: 6 },
      ],
    );
  }
}

type GmMarketRecord = {
  marketToken: Address;
  indexToken: Address;
  longToken: Address;
  shortToken: Address;
};

/** Reader.getMarkets でデプロイ済みマーケットを読み取り registry に記録し、配列を返す */
async function recordMarkets(): Promise<GmMarketRecord[]> {
  info("GMX V2: 作成済みマーケットを読み取り");
  const reader = dep("Reader");
  const dataStore = dep("DataStore").address;

  const markets = (await publicClient.readContract({
    address: reader.address,
    abi: reader.abi,
    functionName: "getMarkets",
    args: [dataStore, 0n, 100n],
  })) as readonly {
    marketToken: Address;
    indexToken: Address;
    longToken: Address;
    shortToken: Address;
  }[];

  assert(markets.length > 0, "マーケットが作成されていない");
  ok("マーケット数", String(markets.length));

  const recorded = markets.slice(0, 20).map((m) => ({
    marketToken: m.marketToken,
    indexToken: m.indexToken,
    longToken: m.longToken,
    shortToken: m.shortToken,
  }));
  setProtocol("gmxV2", { marketCount: markets.length, markets: recorded });
  // 代表として最初のマーケットを表示
  ok("先頭マーケット", recorded[0].marketToken);
  return recorded;
}
