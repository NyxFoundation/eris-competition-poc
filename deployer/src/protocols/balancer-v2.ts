import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeEventLog,
  encodeAbiParameters,
  parseAbiParameters,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { accounts, deployerWallet, publicClient } from "../clients.js";
import { anvilChain } from "../config.js";
import { ROOT, waitTx, ok, info, assert } from "../util.js";
import { approve } from "../erc20.js";
import { setProtocol, token } from "../registry.js";

const dep = accounts.deployer;
const BAL = "node_modules/@balancer-labs/v2-deployments/dist/tasks";

/** authorizer / vault のような結合 artifact (_format hardhat) */
function combined(task: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(
    readFileSync(resolve(ROOT, BAL, task, "artifact", `${name}.json`), "utf8"),
  );
  return { abi: j.abi as Abi, bytecode: j.bytecode as Hex };
}

/** weighted-pool のような abi/ と bytecode/ が分離された task */
function split(task: string, name: string): { abi: Abi; bytecode: Hex } {
  const abi = JSON.parse(
    readFileSync(resolve(ROOT, BAL, task, "abi", `${name}.json`), "utf8"),
  ) as Abi;
  const bc = JSON.parse(
    readFileSync(resolve(ROOT, BAL, task, "bytecode", `${name}.json`), "utf8"),
  );
  return { abi, bytecode: bc.creationCode as Hex };
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
  ok(label, rc.contractAddress as string);
  return rc.contractAddress as Address;
}

const SWAP_FEE = 3_000_000_000_000_000n; // 0.3%
// WETH/USDC を 50/50 で組む。WETH↔USDC 裁定の主要 venue として両側に深い流動性を置き、
// poc の fair price (~$3000) と価格を揃える（80/20 だと USDC 側が浅く swap が limit 割れする）。
const W50 = 500_000_000_000_000_000n;

export async function deployBalancerV2({ seed }: { seed: boolean }) {
  info("Balancer V2 (Authorizer / Vault / WeightedPoolFactory) をデプロイ");
  const weth = token("WETH");

  const authorizerArt = combined("20210418-authorizer", "Authorizer");
  const authorizer = await deploy(
    "Authorizer",
    authorizerArt.abi,
    authorizerArt.bytecode,
    [dep.address],
  );

  // pauseWindow / bufferPeriod は 0 で可 (テスト用)
  const vaultArt = combined("20210418-vault", "Vault");
  const vault = await deploy("Vault", vaultArt.abi, vaultArt.bytecode, [
    authorizer,
    weth,
    0n,
    0n,
  ]);

  const factoryArt = split("20210418-weighted-pool", "WeightedPoolFactory");
  const weightedPoolFactory = await deploy(
    "WeightedPoolFactory",
    factoryArt.abi,
    factoryArt.bytecode,
    [vault],
  );

  // BalancerQueries: poc の balancer adapter が queryBatchSwap で見積りに使う。
  const queriesArt = combined("20220721-balancer-queries", "BalancerQueries");
  const queries = await deploy(
    "BalancerQueries",
    queriesArt.abi,
    queriesArt.bytecode,
    [vault],
  );

  setProtocol("balancerV2", {
    authorizer,
    vault,
    weightedPoolFactory,
    queries,
  });

  if (seed) {
    // WETH/USDC（既存。byte 互換のため引数・量は従来どおり）。
    await seedWeightedPool({
      vault,
      weightedPoolFactory,
      tokenAKey: "WETH",
      tokenBKey: "USDC",
      // 1000 WETH / 3,000,000 USDC = $3000/WETH (50/50・深い)。
      amountA: 1000n * 10n ** 18n,
      amountB: 3_000_000n * 10n ** 6n,
      name: "Eris WETH/USDC 50/50",
      symbol: "ERIS-50WETH-50USDC",
      poolKey: "wethUsdcPool",
      poolIdKey: "wethUsdcPoolId",
      summary: "1000 WETH / 3M USDC (50/50, $3000)",
    });
    // WBTC/USDC（ADR 0013 マルチアセット）。WBTC は 8 decimals。
    await seedWeightedPool({
      vault,
      weightedPoolFactory,
      tokenAKey: "WBTC",
      tokenBKey: "USDC",
      // 50 WBTC / 3,000,000 USDC = $60k/WBTC (50/50・深い)。
      amountA: 50n * 10n ** 8n,
      amountB: 3_000_000n * 10n ** 6n,
      name: "Eris WBTC/USDC 50/50",
      symbol: "ERIS-50WBTC-50USDC",
      poolKey: "wbtcUsdcPool",
      poolIdKey: "wbtcUsdcPoolId",
      summary: "50 WBTC / 3M USDC (50/50, $60000)",
    });
  }
}

/**
 * 50/50 加重プールを作成し初期流動性を投入する汎用 seed。
 * create → PoolCreated ログ抽出 → getPoolId → joinPool INIT の流れは共通。
 * Vault は scaling factor で 18 decimals に正規化するため raw 量をそのまま渡せば spot 正。
 */
async function seedWeightedPool({
  vault,
  weightedPoolFactory,
  tokenAKey,
  tokenBKey,
  amountA,
  amountB,
  name,
  symbol,
  poolKey,
  poolIdKey,
  summary,
}: {
  vault: Address;
  weightedPoolFactory: Address;
  tokenAKey: string;
  tokenBKey: string;
  amountA: bigint;
  amountB: bigint;
  name: string;
  symbol: string;
  poolKey: string;
  poolIdKey: string;
  summary: string;
}) {
  info(`Balancer V2: 50/50 ${tokenAKey}/${tokenBKey} プールを作成し流動性投入`);
  const tokenA = token(tokenAKey);
  const tokenB = token(tokenBKey);

  // Balancer はトークンを昇順登録する必要がある。
  const aFirst = tokenA.toLowerCase() < tokenB.toLowerCase();
  const tokens = (aFirst ? [tokenA, tokenB] : [tokenB, tokenA]) as Address[];
  const weights = [W50, W50]; // 50/50
  const amounts = aFirst ? [amountA, amountB] : [amountB, amountA];

  const factoryArt = split("20210418-weighted-pool", "WeightedPoolFactory");
  const createHash = await deployerWallet.writeContract({
    address: weightedPoolFactory,
    abi: factoryArt.abi,
    functionName: "create",
    args: [name, symbol, tokens, weights, SWAP_FEE, dep.address],
    account: dep,
    chain: anvilChain,
  });
  const createRc = await waitTx(createHash);

  // PoolCreated イベントから pool アドレスを取得
  let pool: Address | undefined;
  for (const log of createRc.logs) {
    try {
      const ev = decodeEventLog({ abi: factoryArt.abi, ...log });
      if (ev.eventName === "PoolCreated") {
        pool = (ev.args as unknown as { pool: Address }).pool;
        break;
      }
    } catch {
      /* 別コントラクトの log */
    }
  }
  assert(!!pool, "PoolCreated が取得できない");
  ok("WeightedPool 作成", pool!);

  // poolId 取得
  const poolAbi = split("20210418-weighted-pool", "WeightedPool").abi;
  const poolId = (await publicClient.readContract({
    address: pool!,
    abi: poolAbi,
    functionName: "getPoolId",
    args: [],
  })) as Hex;
  ok("poolId", poolId);

  await approve(tokenA, vault, amountA);
  await approve(tokenB, vault, amountB);

  // WeightedPool INIT join: userData = abi.encode(uint256 kind=0, uint256[] amountsIn)
  const userData = encodeAbiParameters(
    parseAbiParameters("uint256, uint256[]"),
    [0n, amounts],
  );

  const vaultArt = combined("20210418-vault", "Vault");
  const joinHash = await deployerWallet.writeContract({
    address: vault,
    abi: vaultArt.abi,
    functionName: "joinPool",
    args: [
      poolId,
      dep.address,
      dep.address,
      {
        assets: tokens,
        maxAmountsIn: amounts,
        userData,
        fromInternalBalance: false,
      },
    ],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(joinHash);
  ok("初期流動性 join", summary);

  setProtocol("balancerV2", { [poolKey]: pool, [poolIdKey]: poolId });
}
