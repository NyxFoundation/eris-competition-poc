import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseUnits, type Abi, type Address, type Hex } from "viem";
import { accounts, deployerWallet, publicClient } from "../clients.js";
import { anvilChain } from "../config.js";
import { ROOT, waitTx, ok, info, assert } from "../util.js";
import { approve } from "../erc20.js";
import { setProtocol, token } from "../registry.js";

const dep = accounts.deployer;
const CURVE = resolve(ROOT, "vendor", "curve");

// vyper -f abi / -f bytecode|blueprint_bytecode で事前ビルドした artifact
function art(name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(resolve(CURVE, `${name}.json`), "utf8"));
  return {
    abi: j.abi as Abi,
    bytecode: (j.bytecode ?? j.blueprintBytecode) as Hex,
  };
}

async function deploy(
  label: string,
  name: string,
  args: unknown[],
): Promise<Address> {
  const a = art(name);
  const hash = await deployerWallet.deployContract({
    abi: a.abi,
    bytecode: a.bytecode,
    args,
    account: dep,
    chain: anvilChain,
  });
  const rc = await waitTx(hash);
  ok(label, rc.contractAddress as string);
  return rc.contractAddress as Address;
}

// deploy_plain_pool の安全なパラメータ (repo の tests/fixtures/pools.py 準拠)
const A = 2000n;
const FEE = 1_000_000n; // 0.01%
const OFFPEG = 20_000_000_000n;
const MA_EXP_TIME = 866n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export async function deployCurve({ seed }: { seed: boolean }) {
  info("Curve Stableswap-NG (factory + 実装群) をデプロイ");

  // 実装コントラクト
  const math = await deploy("Math 実装", "CurveStableSwapNGMath", []);
  const views = await deploy("Views 実装", "CurveStableSwapNGViews", []);
  const poolBlueprint = await deploy("Pool blueprint", "CurveStableSwapNG", []);

  // factory(__init__: fee_receiver, owner)
  const factory = await deploy(
    "StableSwapFactoryNG",
    "CurveStableSwapFactoryNG",
    [dep.address, dep.address],
  );
  const factoryAbi = art("CurveStableSwapFactoryNG").abi;

  // 実装を factory に配線
  for (const [fn, arg] of [
    ["set_math_implementation", math],
    ["set_views_implementation", views],
  ] as const) {
    const h = await deployerWallet.writeContract({
      address: factory,
      abi: factoryAbi,
      functionName: fn,
      args: [arg],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  }
  const h = await deployerWallet.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: "set_pool_implementations",
    args: [0n, poolBlueprint],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
  ok("実装配線", "math / views / pool[0]");

  setProtocol("curve", { factory, math, views, poolBlueprint });

  if (seed) {
    await seedPool(factory);
  }

  // poc の Curve venue は WETH<->stable の crypto pool (uint256 index get_dy/exchange) 前提。
  // stableswap(USDC/DAI)とは別に twocrypto-ng の WETH/USDC crypto pool を立てる。
  await deployTwocrypto({ seed });
}

// twocrypto-ng (lite-0.3.10) 標準パラメータ (tests/profiling/conftest.py 準拠)
const TC = {
  A: 400000n,
  gamma: 145000000000000n,
  midFee: 26000000n,
  outFee: 45000000n,
  feeGamma: 230000000000000n,
  allowedExtraProfit: 2000000000000n,
  adjustmentStep: 146000000000000n,
  maExpTime: 866n,
} as const;

/** twocrypto-ng (WETH/USDC crypto pool) をデプロイし add_liquidity で seed */
async function deployTwocrypto({ seed }: { seed: boolean }) {
  info("Curve Twocrypto-NG (crypto factory + 実装群) をデプロイ");
  const math = await deploy("Twocrypto Math", "CurveTwocryptoMath", []);
  const views = await deploy("Twocrypto Views", "CurveTwocryptoViews", []);
  const amm = await deploy("Twocrypto AMM blueprint", "CurveTwocrypto", []);
  const factory = await deploy("TwocryptoFactory", "CurveTwocryptoFactory", []);
  const factoryAbi = art("CurveTwocryptoFactory").abi;

  // __init__ は deployer(tx.origin) 記録のみ。所有権を初期化する。
  for (const [fn, args] of [
    ["initialise_ownership", [dep.address, dep.address]],
    ["set_math_implementation", [math]],
    ["set_views_implementation", [views]],
    ["set_pool_implementation", [amm, 0n]],
  ] as const) {
    const h = await deployerWallet.writeContract({
      address: factory,
      abi: factoryAbi,
      functionName: fn,
      args: args as never,
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  }
  ok("twocrypto 配線", "ownership / math / views / pool[0]");

  setProtocol("curve", {
    twocryptoFactory: factory,
    twocryptoMath: math,
    twocryptoViews: views,
    twocryptoAmm: amm,
  });

  if (seed) {
    await seedTwocrypto(factory);
    await seedTwocryptoWbtc(factory);
  }
}

/** WETH/USDC crypto pool を作成し add_liquidity ($3000/WETH・balanced) */
async function seedTwocrypto(factory: Address) {
  info("Curve: WETH/USDC crypto pool を作成し流動性投入");
  const factoryAbi = art("CurveTwocryptoFactory").abi;
  const usdc = token("USDC");
  const weth = token("WETH");
  // coin0 = USDC (numeraire), coin1 = WETH。initial_price = WETH の USDC 建て価格 (1e18 正規化)。
  const coins = [usdc, weth] as [Address, Address];
  const initialPrice = 3000n * 10n ** 18n;

  const deployHash = await deployerWallet.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: "deploy_pool",
    args: [
      "Eris WETH/USDC crypto",
      "ERISWETHUSDC",
      coins,
      0n, // implementation_id
      TC.A,
      TC.gamma,
      TC.midFee,
      TC.outFee,
      TC.feeGamma,
      TC.allowedExtraProfit,
      TC.adjustmentStep,
      TC.maExpTime,
      initialPrice,
    ],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(deployHash);

  const count = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "pool_count",
    args: [],
  })) as bigint;
  const pool = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "pool_list",
    args: [count - 1n],
  })) as Address;
  assert(pool !== ZERO, "crypto pool が作成されていない");
  ok("crypto pool 作成", pool);

  const poolAbi = art("CurveTwocrypto").abi;
  // balanced 初期流動性: 3M USDC + 1000 WETH (=$3M each @ $3000)。Uniswap/Balancer と同じ深さ。
  // crypto pool は price impact が非線形に大きく、浅いと flow の swap(最大 1 WETH)が
  // get_dy 見積り→実行間の価格移動で min_dy(slippage 1%)を割って revert する。深くして抑える。
  const usdcAmt = parseUnits("3000000", 6);
  const wethAmt = parseUnits("1000", 18);
  await approve(usdc, pool, usdcAmt);
  await approve(weth, pool, wethAmt);
  const addHash = await deployerWallet.writeContract({
    address: pool,
    abi: poolAbi,
    functionName: "add_liquidity",
    args: [[usdcAmt, wethAmt], 0n, dep.address],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(addHash);
  ok("add_liquidity", "3M USDC / 1000 WETH ($3000)");

  // poc 用 index: coin0=USDC(stable)=0, coin1=WETH=1
  setProtocol("curve", {
    wethUsdcCryptoPool: pool,
    cryptoWethIndex: 1,
    cryptoStableIndex: 0,
  });
}

/**
 * WBTC/USDC crypto pool を作成し add_liquidity ($60000/WBTC・balanced)。
 * factory は再デプロイ不要 (seedTwocrypto と同一 factory で deploy_pool をもう 1 回呼ぶ)。
 */
async function seedTwocryptoWbtc(factory: Address) {
  info("Curve: WBTC/USDC crypto pool を作成し流動性投入");
  const factoryAbi = art("CurveTwocryptoFactory").abi;
  const usdc = token("USDC");
  const wbtc = token("WBTC");
  // coin0 = USDC (numeraire), coin1 = WBTC。initial_price = WBTC の USDC 建て価格 (1e18 正規化)。
  const coins = [usdc, wbtc] as [Address, Address];
  const initialPrice = 60000n * 10n ** 18n;

  const deployHash = await deployerWallet.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: "deploy_pool",
    args: [
      "Eris WBTC/USDC crypto",
      "ERISWBTCUSDC",
      coins,
      0n, // implementation_id
      TC.A,
      TC.gamma,
      TC.midFee,
      TC.outFee,
      TC.feeGamma,
      TC.allowedExtraProfit,
      TC.adjustmentStep,
      TC.maExpTime,
      initialPrice,
    ],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(deployHash);

  const count = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "pool_count",
    args: [],
  })) as bigint;
  const pool = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "pool_list",
    args: [count - 1n],
  })) as Address;
  assert(pool !== ZERO, "WBTC crypto pool が作成されていない");
  ok("WBTC crypto pool 作成", pool);

  const poolAbi = art("CurveTwocrypto").abi;
  // balanced 初期流動性: 3M USDC + 50 WBTC (=$3M each @ $60000)。
  // 正規化後の量比 3,000,000 : 50 = 60000 = initial_price と一致させる
  // (乖離すると add_liquidity が revert する)。WBTC は 8 decimals。
  const usdcAmt = parseUnits("3000000", 6);
  const wbtcAmt = parseUnits("50", 8);
  await approve(usdc, pool, usdcAmt);
  await approve(wbtc, pool, wbtcAmt);
  const addHash = await deployerWallet.writeContract({
    address: pool,
    abi: poolAbi,
    functionName: "add_liquidity",
    args: [[usdcAmt, wbtcAmt], 0n, dep.address],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(addHash);
  ok("add_liquidity", "3M USDC / 50 WBTC ($60000)");

  // poc 用 index: coin0=USDC(stable)=0, coin1=WBTC=1
  setProtocol("curve", {
    wbtcUsdcCryptoPool: pool,
    cryptoWbtcIndex: 1,
    cryptoWbtcStableIndex: 0,
  });
}

/** USDC/DAI の plain pool を作成し add_liquidity → exchange を検証 */
async function seedPool(factory: Address) {
  info("Curve: USDC/DAI plain pool を作成し流動性投入");
  const factoryAbi = art("CurveStableSwapFactoryNG").abi;
  const usdc = token("USDC");
  const dai = token("DAI");
  const coins = [usdc, dai] as Address[];

  const deployHash = await deployerWallet.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: "deploy_plain_pool",
    args: [
      "Eris USDC/DAI", // _name: String[32]
      "USDCDAI", // _symbol: String[10]
      coins,
      A,
      FEE,
      OFFPEG,
      MA_EXP_TIME,
      0n, // implementation_idx
      [0, 0], // asset_types: Standard
      ["0x00000000", "0x00000000"], // method_ids
      [ZERO, ZERO], // oracles
    ],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(deployHash);

  // pool アドレスは factory.pool_list(pool_count-1) から取得
  const count = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "pool_count",
    args: [],
  })) as bigint;
  const pool = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "pool_list",
    args: [count - 1n],
  })) as Address;
  assert(pool !== ZERO, "pool が作成されていない");
  ok("plain pool 作成", pool);

  const poolAbi = art("CurveStableSwapNG").abi;

  // 初期流動性: 各 100,000 (デシマル考慮)
  const usdcAmt = parseUnits("100000", 6);
  const daiAmt = parseUnits("100000", 18);
  await approve(usdc, pool, usdcAmt);
  await approve(dai, pool, daiAmt);

  const addHash = await deployerWallet.writeContract({
    address: pool,
    abi: poolAbi,
    functionName: "add_liquidity",
    args: [[usdcAmt, daiAmt], 0n, dep.address],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(addHash);
  ok("add_liquidity", "100k USDC / 100k DAI");

  setProtocol("curve", { usdcDaiPool: pool });
}
