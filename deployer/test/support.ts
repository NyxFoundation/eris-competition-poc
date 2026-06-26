import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import type { Abi, Address, Hex } from "viem";
import { ROOT } from "../src/util.js";
import { getRegistry } from "../src/registry.js";

export const ZERO = "0x0000000000000000000000000000000000000000" as Address;

// ---------------------------------------------------------------------------
// ABI ローダ (各 deploy ファイルと同じ取得元から読む)
// ---------------------------------------------------------------------------

/** node_modules 内の {abi, bytecode} 形式 artifact (Uniswap) */
export function nmArtifact(pkgRelPath: string): { abi: Abi } {
  const json = JSON.parse(
    readFileSync(resolve(ROOT, "node_modules", pkgRelPath), "utf8"),
  );
  return { abi: json.abi as Abi };
}

const UNI = {
  factory:
    "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json",
  pool: "@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json",
  posManager:
    "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json",
  swapRouter:
    "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json",
  quoterV2:
    "@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json",
} as const;

export const uniAbi = (k: keyof typeof UNI): Abi => nmArtifact(UNI[k]).abi;

const BAL = "node_modules/@balancer-labs/v2-deployments/dist/tasks";

/** Balancer の結合 artifact (Vault 等) */
export function balCombined(task: string, name: string): Abi {
  const j = JSON.parse(
    readFileSync(resolve(ROOT, BAL, task, "artifact", `${name}.json`), "utf8"),
  );
  return j.abi as Abi;
}

/** Balancer の abi/ 分離 artifact (WeightedPool 等) */
export function balSplit(task: string, name: string): Abi {
  return JSON.parse(
    readFileSync(resolve(ROOT, BAL, task, "abi", `${name}.json`), "utf8"),
  ) as Abi;
}

export const vaultAbi = (): Abi => balCombined("20210418-vault", "Vault");
export const weightedPoolAbi = (): Abi =>
  balSplit("20210418-weighted-pool", "WeightedPool");

/** vendor/curve の vyper artifact */
export function curveAbi(name: string): Abi {
  const j = JSON.parse(
    readFileSync(resolve(ROOT, "vendor", "curve", `${name}.json`), "utf8"),
  );
  return j.abi as Abi;
}

/** vendor/<sub>/deployments/localhost の hardhat-deploy artifact */
function deploymentArtifact(
  sub: string,
  name: string,
): { address: Address; abi: Abi } {
  const j = JSON.parse(
    readFileSync(
      resolve(ROOT, "vendor", sub, "deployments", "localhost", `${name}.json`),
      "utf8",
    ),
  );
  return { address: j.address as Address, abi: j.abi as Abi };
}

export const aaveDeployment = (name: string) =>
  deploymentArtifact("aave", name);
export const gmxDeployment = (name: string) =>
  deploymentArtifact("gmx-src", name);

// ---------------------------------------------------------------------------
// registry アクセス (未デプロイなら undefined → describe.skip 判定に使う)
// ---------------------------------------------------------------------------

export function getProto<T extends Record<string, unknown>>(
  name: string,
): T | undefined {
  return getRegistry().protocols[name] as T | undefined;
}

export function tokenAddr(key: string): Address {
  return getRegistry().tokens[key];
}

// ---------------------------------------------------------------------------
// アサーションヘルパ
// ---------------------------------------------------------------------------

/** actual が expected の ±bps 以内かを判定 (bps = ベーシスポイント, 100 = 1%) */
export function expectApprox(
  actual: bigint,
  expected: bigint,
  bps: number,
  label = "value",
) {
  const diff = actual > expected ? actual - expected : expected - actual;
  const tolerance = (expected * BigInt(Math.round(bps))) / 10_000n;
  expect(
    diff <= tolerance,
    `${label}: actual=${actual} expected=${expected} diff=${diff} > tol(${bps}bps)=${tolerance}`,
  ).toBe(true);
}

/** simulateContract / read の Promise が revert (reject) することを確認 */
export async function expectRevert(p: Promise<unknown>, label = "call") {
  await expect(p, `${label} は revert すべき`).rejects.toThrow();
}

/** アドレス比較 (チェックサム差を無視) */
export function sameAddr(a?: string, b?: string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export const isAddress = (v: unknown): v is Address =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** 1 時間後の deadline (秒) */
export const deadline = (): bigint =>
  BigInt(Math.floor(Date.now() / 1000) + 3600);

export type { Abi, Address, Hex };
