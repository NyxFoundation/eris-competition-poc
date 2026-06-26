import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Abi, Address } from "viem";
import { accounts, deployerWallet, publicClient } from "../clients.js";
import { anvilChain, RPC_URL } from "../config.js";
import { ROOT, waitTx, ok, info, assert } from "../util.js";
import { setProtocol, getRegistry } from "../registry.js";

const dep = accounts.deployer;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const AAVE_DIR = resolve(ROOT, "vendor", "aave");
const DEPLOYMENTS = resolve(AAVE_DIR, "deployments", "localhost");

function readDeployment(name: string): { address: Address; abi: Abi } {
  const j = JSON.parse(
    readFileSync(resolve(DEPLOYMENTS, `${name}.json`), "utf8"),
  );
  return { address: j.address as Address, abi: j.abi as Abi };
}

// 対象トークン (Aave のテストトークンキー)
const TOKEN_KEYS = ["WETH", "USDC", "WBTC", "USDT", "DAI"] as const;

export async function deployAaveV3({ seed }: { seed: boolean }) {
  info("Aave V3 フルマーケットを hardhat-deploy でデプロイ");

  // フレッシュな anvil に対応するため、前回の deployments を消す
  rmSync(DEPLOYMENTS, { recursive: true, force: true });

  const res = spawnSync(
    "npx",
    [
      "hardhat",
      "deploy",
      "--network",
      "localhost",
      "--tags",
      "market,periphery-post",
    ],
    {
      cwd: AAVE_DIR,
      env: { ...process.env, MARKET_NAME: "Aave", RPC_URL },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (res.status !== 0) {
    throw new Error(`aave hardhat deploy が失敗しました (exit ${res.status})`);
  }
  assert(
    existsSync(DEPLOYMENTS),
    "aave deployments/localhost が生成されていない",
  );

  // 主要コントラクトのアドレスを取り込む
  const core = {
    pool: readDeployment("Pool-Proxy-Aave").address,
    poolAddressesProvider: readDeployment("PoolAddressesProvider-Aave").address,
    poolConfigurator: readDeployment("PoolConfigurator-Proxy-Aave").address,
    aaveOracle: readDeployment("AaveOracle-Aave").address,
    poolDataProvider: readDeployment("PoolDataProvider-Aave").address,
    aclManager: readDeployment("ACLManager-Aave").address,
    faucet: readDeployment("Faucet-Aave").address,
  };

  // テストトークン + aToken アドレス
  const tokens: Record<string, Address> = {};
  const aTokens: Record<string, Address> = {};
  const files = readdirSync(DEPLOYMENTS);
  for (const key of TOKEN_KEYS) {
    const tFile = `${key}-TestnetMintableERC20-Aave`;
    const aFile = `${key}-AToken-Aave`;
    if (files.includes(`${tFile}.json`))
      tokens[key] = readDeployment(tFile).address;
    if (files.includes(`${aFile}.json`))
      aTokens[key] = readDeployment(aFile).address;
  }

  setProtocol("aaveV3", { ...core, tokens, aTokens });
  ok("Aave V3 デプロイ", `pool=${core.pool}`);
  ok("テストトークン", Object.keys(tokens).join(", "));

  // 共有 mock トークン (WETH/USDC) を reserve として追加登録する。
  // Aave deploy-v3 は自前テストトークンで reserve を作るため、cross-protocol で
  // 跨げる共有トークンの reserve を post-deploy で別途立てる。
  await registerSharedReserves();

  if (seed) {
    await seedSharedSupplyBorrow();
  }
}

// 共有トークンに reserve を追加する対象 (Aave 自前 reserve から設定を複製する)。
// WBTC は Aave 自前 reserve (LTV=7000/LT=7500/aggregator $60k) から設定を実測複製する。
const SHARED_RESERVE_KEYS = ["WETH", "USDC", "WBTC"] as const;

/**
 * deployer の共有 mock トークン (WETH=WETH9 / USDC=MockERC20) を Aave の reserve として
 * 後付け登録する。Aave 自前の同名 reserve から金利戦略・LTV/LT 等の設定を実測して複製し、
 * price source は Aave がデプロイ済みの MockAggregator (更新可能) を流用する。
 * deployer は POOL_ADMIN なので PoolConfigurator / AaveOracle を直接叩ける。
 */
async function registerSharedReserves() {
  const reg = getRegistry();
  const configuratorAddr = readDeployment(
    "PoolConfigurator-Proxy-Aave",
  ).address;
  const configuratorAbi = readDeployment("PoolConfigurator-Implementation").abi;
  const oracle = readDeployment("AaveOracle-Aave");
  const poolAbi = poolImplAbi();
  const pdpAddr = readDeployment("PoolDataProvider-Aave").address;
  const pdpAbi = readDeployment("PoolDataProvider-Aave").abi;
  const { pool } = aave();

  const aTokenImpl = readDeployment("AToken-Aave").address;
  const stableDebtImpl = readDeployment("StableDebtToken-Aave").address;
  const variableDebtImpl = readDeployment("VariableDebtToken-Aave").address;
  const treasury = readDeployment("TreasuryProxy").address;
  const incentives = readDeployment("IncentivesProxy").address;

  const inputs: Record<string, unknown>[] = [];
  const sources: { asset: Address; src: Address }[] = [];
  const configs: {
    asset: Address;
    ltv: bigint;
    lt: bigint;
    bonus: bigint;
    factor: bigint;
  }[] = [];

  for (const key of SHARED_RESERVE_KEYS) {
    const shared = reg.tokens[key];
    const aaveOwn = aave().tokens?.[key];
    if (!shared || !aaveOwn) {
      info(`共有 reserve ${key}: アドレス未解決のためスキップ`);
      continue;
    }
    // 既に reserve 化済みなら何もしない (再実行耐性)
    const existing = (await publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "getReserveData",
      args: [shared],
    })) as { aTokenAddress: Address };
    if (existing.aTokenAddress && existing.aTokenAddress !== ZERO_ADDRESS) {
      ok(`共有 reserve ${key}`, "既存のためスキップ");
      continue;
    }

    // Aave 自前 reserve から設定を実測複製する (magic number を避ける)
    const rd = (await publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "getReserveData",
      args: [aaveOwn],
    })) as { interestRateStrategyAddress: Address };
    const cfg = (await publicClient.readContract({
      address: pdpAddr,
      abi: pdpAbi,
      functionName: "getReserveConfigurationData",
      args: [aaveOwn],
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    const decimals = Number(cfg[0]);

    const aggName = `${key}-TestnetPriceAggregator-Aave`;
    sources.push({ asset: shared, src: readDeployment(aggName).address });
    inputs.push({
      aTokenImpl,
      stableDebtTokenImpl: stableDebtImpl,
      variableDebtTokenImpl: variableDebtImpl,
      underlyingAssetDecimals: decimals,
      interestRateStrategyAddress: rd.interestRateStrategyAddress,
      underlyingAsset: shared,
      treasury,
      incentivesController: incentives,
      aTokenName: `Aave Shared ${key}`,
      aTokenSymbol: `aSh${key}`,
      variableDebtTokenName: `Aave Shared Variable Debt ${key}`,
      variableDebtTokenSymbol: `variableDebtSh${key}`,
      stableDebtTokenName: `Aave Shared Stable Debt ${key}`,
      stableDebtTokenSymbol: `stableDebtSh${key}`,
      params: "0x10",
    });
    configs.push({
      asset: shared,
      ltv: cfg[1],
      lt: cfg[2],
      bonus: cfg[3],
      factor: cfg[4],
    });
  }

  if (inputs.length === 0) return;
  info("Aave V3: 共有トークンの reserve を登録");

  // 1. price source を AaveOracle に設定 (既存 MockAggregator を流用)
  let h = await deployerWallet.writeContract({
    address: oracle.address,
    abi: oracle.abi,
    functionName: "setAssetSources",
    args: [sources.map((s) => s.asset), sources.map((s) => s.src)],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);

  // 2. initReserves で reserve を作成
  h = await deployerWallet.writeContract({
    address: configuratorAddr,
    abi: configuratorAbi,
    functionName: "initReserves",
    args: [inputs],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);

  // 3. 担保有効化 + 借入有効化 + reserveFactor 設定 (Aave 自前 reserve と同値)
  const sharedATokens: Record<string, Address> = {};
  const sharedDebtTokens: Record<string, Address> = {};
  for (const c of configs) {
    h = await deployerWallet.writeContract({
      address: configuratorAddr,
      abi: configuratorAbi,
      functionName: "configureReserveAsCollateral",
      args: [c.asset, c.ltv, c.lt, c.bonus],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    h = await deployerWallet.writeContract({
      address: configuratorAddr,
      abi: configuratorAbi,
      functionName: "setReserveBorrowing",
      args: [c.asset, true],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    h = await deployerWallet.writeContract({
      address: configuratorAddr,
      abi: configuratorAbi,
      functionName: "setReserveFactor",
      args: [c.asset, c.factor],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  }

  // aToken / variableDebtToken アドレスを registry に記録 (poc / test 用)
  for (const key of SHARED_RESERVE_KEYS) {
    const shared = reg.tokens[key];
    if (!shared) continue;
    const toks = (await publicClient.readContract({
      address: pdpAddr,
      abi: pdpAbi,
      functionName: "getReserveTokensAddresses",
      args: [shared],
    })) as readonly [Address, Address, Address];
    sharedATokens[key] = toks[0];
    sharedDebtTokens[key] = toks[2];
  }
  setProtocol("aaveV3", {
    sharedReserves: {
      tokens: Object.fromEntries(
        SHARED_RESERVE_KEYS.map((k) => [k, reg.tokens[k]]).filter(([, v]) => v),
      ),
      aTokens: sharedATokens,
      variableDebtTokens: sharedDebtTokens,
    },
  });
  ok(
    "共有 reserve 登録",
    SHARED_RESERVE_KEYS.filter((k) => reg.tokens[k]).join(", "),
  );
}

/** Faucet 経由でテストトークンを deployer に mint */
async function faucetMint(token: Address, amount: bigint) {
  const faucet = readDeployment("Faucet-Aave");
  const h = await deployerWallet.writeContract({
    address: faucet.address,
    abi: faucet.abi,
    functionName: "mint",
    args: [token, dep.address, amount],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
}

const ERC20_MIN = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const satisfies Abi;

function poolImplAbi(): Abi {
  return readDeployment("Pool-Implementation").abi;
}

function aave(): { pool: Address; tokens: Record<string, Address> } {
  return getRegistry().protocols.aaveV3 as {
    pool: Address;
    tokens: Record<string, Address>;
  };
}

/** faucet で mint → approve → Pool.supply。token は Aave テストトークン。 */
async function supplyAsset(token: Address, amount: bigint, label: string) {
  const { pool } = aave();
  const poolAbi = poolImplAbi();
  await faucetMint(token, amount);
  let h = await deployerWallet.writeContract({
    address: token,
    abi: ERC20_MIN,
    functionName: "approve",
    args: [pool, amount],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
  h = await deployerWallet.writeContract({
    address: pool,
    abi: poolAbi,
    functionName: "supply",
    args: [token, amount, dep.address, 0],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
  ok("supply", label);
}

async function borrowAsset(token: Address, amount: bigint, label: string) {
  const { pool } = aave();
  const h = await deployerWallet.writeContract({
    address: pool,
    abi: poolImplAbi(),
    functionName: "borrow",
    args: [token, amount, 2n, 0, dep.address], // mode=2 (variable)
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
  ok("borrow", label);
}

async function accountData(): Promise<readonly bigint[]> {
  const { pool } = aave();
  return (await publicClient.readContract({
    address: pool,
    abi: poolImplAbi(),
    functionName: "getUserAccountData",
    args: [dep.address],
  })) as readonly bigint[];
}

/**
 * WETH を担保に、USDC を供給(=借入可能な流動性)し、USDC を借りる E2E。
 * 借入対象資産は事前に流動性が必要(aToken の裏付け)。faucet 上限(1万)内に収める。
 */
async function seedSupplyBorrow() {
  info("Aave V3: USDC/WETH 供給 → USDC 借入");
  const { tokens } = aave();
  await supplyAsset(tokens.USDC, 9000n * 10n ** 6n, "9000 USDC (流動性+担保)");
  await supplyAsset(tokens.WETH, 10n * 10n ** 18n, "10 WETH (担保)");
  await borrowAsset(tokens.USDC, 1000n * 10n ** 6n, "1000 USDC");

  const acct = await accountData(); // [collateralBase, debtBase, availableBorrowsBase, ...]
  assert(acct[0] > 0n, "担保が計上されていない");
  assert(acct[1] > 0n, "借入が計上されていない");
  ok("account data", `collateral=${acct[0]} debt=${acct[1]} (base units)`);
}

/** approve → Pool.supply。共有トークンは deployer が既に残高を持つため faucet 不要。 */
async function supplySharedAsset(
  token: Address,
  amount: bigint,
  label: string,
) {
  const { pool } = aave();
  let h = await deployerWallet.writeContract({
    address: token,
    abi: ERC20_MIN,
    functionName: "approve",
    args: [pool, amount],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
  h = await deployerWallet.writeContract({
    address: pool,
    abi: poolImplAbi(),
    functionName: "supply",
    args: [token, amount, dep.address, 0],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
  ok("supply (shared)", label);
}

/**
 * 共有 mock トークン (WETH/USDC) の reserve で supply → borrow を 1 往復し動作確認。
 * deployer は deployTokens で WETH(wrap)・USDC(mint) の残高を持つため faucet 不要。
 */
async function seedSharedSupplyBorrow() {
  const reg = getRegistry();
  const weth = reg.tokens.WETH;
  const usdc = reg.tokens.USDC;
  if (!weth || !usdc) {
    info("共有 seed: WETH/USDC 未デプロイのためスキップ");
    return;
  }
  info("Aave V3: 共有 USDC/WETH 供給 → 共有 USDC 借入");
  await supplySharedAsset(usdc, 9000n * 10n ** 6n, "9000 USDC (流動性+担保)");
  await supplySharedAsset(weth, 10n * 10n ** 18n, "10 WETH (担保)");
  await borrowAsset(usdc, 1000n * 10n ** 6n, "1000 USDC");

  const acct = await accountData();
  assert(acct[0] > 0n, "共有担保が計上されていない");
  assert(acct[1] > 0n, "共有借入が計上されていない");
  ok("account data (shared)", `collateral=${acct[0]} debt=${acct[1]}`);
}
