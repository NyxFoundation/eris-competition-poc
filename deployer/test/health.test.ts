import { describe, it, expect } from "vitest";
import type { Address, Hex } from "viem";
import { publicClient } from "../src/clients.js";
import { getRegistry } from "../src/registry.js";
import {
  ZERO,
  uniAbi,
  vaultAbi,
  weightedPoolAbi,
  curveAbi,
  aaveDeployment,
  gmxDeployment,
  getProto,
  tokenAddr,
  isAddress,
  sameAddr,
} from "./support.js";

const FEE = 3000;

/** deployments.json を再帰走査してアドレス文字列を収集 (ZERO は除外) */
// bytecode 検査から除外するキー。GMX の markets はデプロイ済みコントラクトではなく
// トークン参照の一覧で、合成マーケットの indexToken は意図的に仮想アドレス
// (価格フィードのキー) を持ちコードを伴わないため対象外とする。
const SKIP_KEYS = new Set(["markets"]);

function collectAddresses(node: unknown, acc: Map<string, Address>): void {
  if (isAddress(node)) {
    if (node.toLowerCase() !== ZERO.toLowerCase())
      acc.set(node.toLowerCase(), node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectAddresses(v, acc);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (SKIP_KEYS.has(k)) continue;
      collectAddresses(v, acc);
    }
  }
}

describe("デプロイ健全性 (E)", () => {
  it("deployments.json の全アドレスに bytecode が存在する", async () => {
    const reg = getRegistry();
    const addrs = new Map<string, Address>();
    collectAddresses(reg.tokens, addrs);
    collectAddresses(reg.protocols, addrs);
    expect(addrs.size).toBeGreaterThan(0);

    const empty: string[] = [];
    for (const addr of addrs.values()) {
      const code = await publicClient.getBytecode({ address: addr });
      if (!code || code === "0x") empty.push(addr);
    }
    expect(empty, `bytecode 無し: ${empty.join(", ")}`).toEqual([]);
  });

  describe("Uniswap V3 配線", () => {
    const u = getProto<{
      factory: Address;
      positionManager: Address;
      swapRouter: Address;
      wethUsdcPool: Address;
    }>("uniswapV3");
    it.skipIf(!u)(
      "PositionManager / SwapRouter が factory を指す",
      async () => {
        const pmFactory = await publicClient.readContract({
          address: u!.positionManager,
          abi: uniAbi("posManager"),
          functionName: "factory",
        });
        const srFactory = await publicClient.readContract({
          address: u!.swapRouter,
          abi: uniAbi("swapRouter"),
          functionName: "factory",
        });
        expect(sameAddr(pmFactory as string, u!.factory)).toBe(true);
        expect(sameAddr(srFactory as string, u!.factory)).toBe(true);
      },
    );
    it.skipIf(!u)("factory.getPool が seed した pool を返す", async () => {
      const pool = (await publicClient.readContract({
        address: u!.factory,
        abi: uniAbi("factory"),
        functionName: "getPool",
        args: [tokenAddr("WETH"), tokenAddr("USDC"), FEE],
      })) as Address;
      expect(pool).not.toBe(ZERO);
      expect(sameAddr(pool, u!.wethUsdcPool)).toBe(true);
    });
  });

  describe("Balancer V2 配線", () => {
    const b = getProto<{
      authorizer: Address;
      vault: Address;
      wethUsdcPool: Address;
      wethUsdcPoolId: Hex;
    }>("balancerV2");
    it.skipIf(!b)("Vault.getAuthorizer / Pool.getVault が整合", async () => {
      const auth = await publicClient.readContract({
        address: b!.vault,
        abi: vaultAbi(),
        functionName: "getAuthorizer",
      });
      const poolVault = await publicClient.readContract({
        address: b!.wethUsdcPool,
        abi: weightedPoolAbi(),
        functionName: "getVault",
      });
      expect(sameAddr(auth as string, b!.authorizer)).toBe(true);
      expect(sameAddr(poolVault as string, b!.vault)).toBe(true);
    });
    it.skipIf(!b)("Vault.getPoolTokens が 2 トークン・残高 > 0", async () => {
      const res = (await publicClient.readContract({
        address: b!.vault,
        abi: vaultAbi(),
        functionName: "getPoolTokens",
        args: [b!.wethUsdcPoolId],
      })) as readonly [Address[], bigint[], bigint];
      expect(res[0].length).toBe(2);
      expect(res[1].every((x) => x > 0n)).toBe(true);
    });
  });

  describe("Aave V3 配線", () => {
    const a = getProto<{ pool: Address; aaveOracle: Address }>("aaveV3");
    it.skipIf(!a)("PoolAddressesProvider が pool/oracle を指す", async () => {
      const provider = aaveDeployment("PoolAddressesProvider-Aave");
      const pool = await publicClient.readContract({
        address: provider.address,
        abi: provider.abi,
        functionName: "getPool",
      });
      const oracle = await publicClient.readContract({
        address: provider.address,
        abi: provider.abi,
        functionName: "getPriceOracle",
      });
      expect(sameAddr(pool as string, a!.pool)).toBe(true);
      expect(sameAddr(oracle as string, a!.aaveOracle)).toBe(true);
    });
    it.skipIf(!a)("AaveOracle.getAssetPrice > 0", async () => {
      const oracleArt = aaveDeployment("AaveOracle-Aave");
      const tokens = getProto<{ tokens: Record<string, Address> }>(
        "aaveV3",
      )!.tokens;
      const price = (await publicClient.readContract({
        address: oracleArt.address,
        abi: oracleArt.abi,
        functionName: "getAssetPrice",
        args: [tokens.USDC],
      })) as bigint;
      expect(price).toBeGreaterThan(0n);
    });
  });

  describe("Curve 配線", () => {
    const c = getProto<{ factory: Address; usdcDaiPool: Address }>("curve");
    it.skipIf(!c)("factory に pool が登録され coins が一致", async () => {
      const fAbi = curveAbi("CurveStableSwapFactoryNG");
      const count = (await publicClient.readContract({
        address: c!.factory,
        abi: fAbi,
        functionName: "pool_count",
      })) as bigint;
      expect(count).toBeGreaterThanOrEqual(1n);
      const pool = (await publicClient.readContract({
        address: c!.factory,
        abi: fAbi,
        functionName: "pool_list",
        args: [0n],
      })) as Address;
      expect(sameAddr(pool, c!.usdcDaiPool)).toBe(true);

      const pAbi = curveAbi("CurveStableSwapNG");
      const coin0 = (await publicClient.readContract({
        address: c!.usdcDaiPool,
        abi: pAbi,
        functionName: "coins",
        args: [0n],
      })) as Address;
      const coin1 = (await publicClient.readContract({
        address: c!.usdcDaiPool,
        abi: pAbi,
        functionName: "coins",
        args: [1n],
      })) as Address;
      expect(sameAddr(coin0, tokenAddr("USDC"))).toBe(true);
      expect(sameAddr(coin1, tokenAddr("DAI"))).toBe(true);
    });
  });

  describe("GMX V2 配線", () => {
    const g = getProto<{
      Reader: Address;
      DataStore: Address;
      marketCount?: number;
    }>("gmxV2");
    it.skipIf(!g)("Reader.getMarkets の件数が記録値と一致", async () => {
      const reader = gmxDeployment("Reader");
      const markets = (await publicClient.readContract({
        address: g!.Reader,
        abi: reader.abi,
        functionName: "getMarkets",
        args: [g!.DataStore, 0n, 100n],
      })) as readonly unknown[];
      expect(markets.length).toBeGreaterThan(0);
      if (typeof g!.marketCount === "number")
        expect(markets.length).toBe(g!.marketCount);
    });
  });
});
