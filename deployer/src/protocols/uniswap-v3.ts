import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pad, stringToHex, type Abi, type Address, type Hex } from "viem";
import { accounts, deployerWallet, publicClient } from "../clients.js";
import { anvilChain } from "../config.js";
import { ROOT, waitTx, ok, info, assert, encodeSqrtRatioX96 } from "../util.js";
import { setProtocol, token } from "../registry.js";
import { approve } from "../erc20.js";

const dep = accounts.deployer;

function art(pkgRelPath: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(
    readFileSync(resolve(ROOT, "node_modules", pkgRelPath), "utf8"),
  );
  return { abi: json.abi as Abi, bytecode: json.bytecode as Hex };
}

const A = {
  factory: () =>
    art(
      "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json",
    ),
  nftDescriptor: () =>
    art(
      "@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json",
    ),
  posDescriptor: () =>
    art(
      "@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json",
    ),
  posManager: () =>
    art(
      "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json",
    ),
  swapRouter: () =>
    art(
      "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json",
    ),
  quoterV2: () =>
    art(
      "@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json",
    ),
  tickLens: () =>
    art(
      "@uniswap/v3-periphery/artifacts/contracts/lens/TickLens.sol/TickLens.json",
    ),
};

/** linkReferences のプレースホルダ __$..$__ をデプロイ済みライブラリアドレスで埋める */
function linkLibrary(bytecode: Hex, libAddress: Address): Hex {
  const addr = libAddress.toLowerCase().replace("0x", "");
  return bytecode.replace(/__\$[0-9a-fA-F]+\$__/g, addr) as Hex;
}

async function deploy(
  label: string,
  abi: Abi,
  bytecode: Hex,
  args: unknown[],
): Promise<Address> {
  const hash = await deployerWallet.deployContract({
    abi,
    bytecode,
    args,
    account: dep,
    chain: anvilChain,
  });
  const rc = await waitTx(hash);
  const addr = rc.contractAddress as Address;
  ok(label, addr);
  return addr;
}

export async function deployUniswapV3({ seed }: { seed: boolean }) {
  info("Uniswap V3 コア/ペリフェリをデプロイ");
  const weth = token("WETH");

  const factory = await deploy(
    "UniswapV3Factory",
    A.factory().abi,
    A.factory().bytecode,
    [],
  );

  const nftDescriptorLib = await deploy(
    "NFTDescriptor (lib)",
    A.nftDescriptor().abi,
    A.nftDescriptor().bytecode,
    [],
  );

  const posDescArt = A.posDescriptor();
  // nativeCurrencyLabel "ETH" を bytes32 (右詰め) に
  const labelBytes = pad(stringToHex("ETH"), { dir: "right", size: 32 });
  const posDescriptor = await deploy(
    "NonfungibleTokenPositionDescriptor",
    posDescArt.abi,
    linkLibrary(posDescArt.bytecode, nftDescriptorLib),
    [weth, labelBytes],
  );

  const posManager = await deploy(
    "NonfungiblePositionManager",
    A.posManager().abi,
    A.posManager().bytecode,
    [factory, weth, posDescriptor],
  );

  const swapRouter = await deploy(
    "SwapRouter",
    A.swapRouter().abi,
    A.swapRouter().bytecode,
    [factory, weth],
  );

  const quoterV2 = await deploy(
    "QuoterV2",
    A.quoterV2().abi,
    A.quoterV2().bytecode,
    [factory, weth],
  );

  const tickLens = await deploy(
    "TickLens",
    A.tickLens().abi,
    A.tickLens().bytecode,
    [],
  );

  setProtocol("uniswapV3", {
    factory,
    nftDescriptorLib,
    positionDescriptor: posDescriptor,
    positionManager: posManager,
    swapRouter,
    quoterV2,
    tickLens,
  });

  if (seed) {
    // WETH/USDC（既存。1000 WETH / 3M USDC = $3000）
    await seedV3Pool({
      posManager,
      tokenAKey: "WETH",
      tokenBKey: "USDC",
      amountA: 1000n * 10n ** 18n,
      amountB: 3_000_000n * 10n ** 6n,
      registryKey: "wethUsdcPool",
      label: "1000 WETH / 3M USDC (full range, $3000)",
    });
    // WBTC/USDC（ADR 0013。50 WBTC / 3M USDC = $60k anchor。WBTC は 8 decimals）。
    // POC quoter がペア別 fee を持たないため fee=3000 で WETH/USDC と統一する。
    await seedV3Pool({
      posManager,
      tokenAKey: "WBTC",
      tokenBKey: "USDC",
      amountA: 50n * 10n ** 8n,
      amountB: 3_000_000n * 10n ** 6n,
      registryKey: "wbtcUsdcPool",
      label: "50 WBTC / 3M USDC (full range, $60000)",
    });
  }
}

const FEE = 3000;
const TICK_SPACING = 60;
const MIN_TICK = -887220; // -887272 を tickSpacing(60) に丸めた値
const MAX_TICK = 887220;

/**
 * base/quote プールを作成し、フルレンジ流動性を投入する汎用版。
 * token0 < token1 昇順ソート / encodeSqrtRatioX96(raw amount 比。decimals 内包) /
 * full-range mint / getPool 検証は WETH/USDC と共通。tokenAKey/amount を引数化し、
 * WETH/USDC・WBTC/USDC を同じ経路で seed する（ADR 0013）。
 */
async function seedV3Pool({
  posManager,
  tokenAKey,
  tokenBKey,
  amountA,
  amountB,
  registryKey,
  label,
}: {
  posManager: Address;
  tokenAKey: string;
  tokenBKey: string;
  amountA: bigint;
  amountB: bigint;
  registryKey: string;
  label: string;
}) {
  info(`Uniswap V3: ${tokenAKey}/${tokenBKey} プールを作成し流動性投入`);
  const tokenA = token(tokenAKey);
  const tokenB = token(tokenBKey);

  // token0 < token1 (アドレス昇順)
  const aIsToken0 = tokenA.toLowerCase() < tokenB.toLowerCase();
  const token0 = aIsToken0 ? tokenA : tokenB;
  const token1 = aIsToken0 ? tokenB : tokenA;
  const amount0Desired = aIsToken0 ? amountA : amountB;
  const amount1Desired = aIsToken0 ? amountB : amountA;

  // encodeSqrtRatioX96 は raw amount 比なので decimals は raw に内包され無改修で正しい。
  const sqrtPriceX96 = encodeSqrtRatioX96(amount1Desired, amount0Desired);

  const npmAbi = A.posManager().abi;

  // pool 作成 + 初期化
  const h1 = await deployerWallet.writeContract({
    address: posManager,
    abi: npmAbi,
    functionName: "createAndInitializePoolIfNecessary",
    args: [token0, token1, FEE, sqrtPriceX96],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h1);
  ok("pool 作成+初期化", `${tokenAKey}/${tokenBKey} fee=${FEE}`);

  // approve
  await approve(tokenA, posManager, amountA);
  await approve(tokenB, posManager, amountB);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const h2 = await deployerWallet.writeContract({
    address: posManager,
    abi: npmAbi,
    functionName: "mint",
    args: [
      {
        token0,
        token1,
        fee: FEE,
        tickLower: MIN_TICK,
        tickUpper: MAX_TICK,
        amount0Desired,
        amount1Desired,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: dep.address,
        deadline,
      },
    ],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h2);
  ok("流動性 mint", label);

  // 健全性: プールが factory に登録されているか
  const { factory } = (await import("../registry.js")).getRegistry().protocols
    .uniswapV3 as { factory: Address };
  const pool = (await publicClient.readContract({
    address: factory,
    abi: A.factory().abi,
    functionName: "getPool",
    args: [token0, token1, FEE],
  })) as Address;
  assert(
    pool !== "0x0000000000000000000000000000000000000000",
    `${tokenAKey}/${tokenBKey} pool が作成されていない`,
  );
  setProtocol("uniswapV3", { [registryKey]: pool });
  ok("pool アドレス", `${registryKey}=${pool}`);
}
