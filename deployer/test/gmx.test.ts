import { describe, it, expect, beforeAll } from "vitest";
import type { Address } from "viem";
import { accounts, publicClient, traderWallet } from "../src/clients.js";
import { balanceOf } from "../src/erc20.js";
import { gmxDeployment, getProto, sameAddr, ZERO } from "./support.js";
import {
  type GmxRegistry,
  deployMockOracleProvider,
  resolveKeeper,
  setupOracle,
  mintAndApprove,
  createDeposit,
  createIncreaseOrder,
  keeperExecute,
  getLongPosition,
} from "./gmx-e2e.js";

type Market = {
  marketToken: Address;
  indexToken: Address;
  longToken: Address;
  shortToken: Address;
};

const g = getProto<{
  Reader: Address;
  DataStore: Address;
  marketCount?: number;
  markets?: Market[];
}>("gmxV2");

describe.skipIf(!g)("GMX V2 (read-only)", () => {
  const readerAbi = () => gmxDeployment("Reader").abi;

  it("Reader.getMarkets が registry の marketCount と一致", async () => {
    const markets = (await publicClient.readContract({
      address: g!.Reader,
      abi: readerAbi(),
      functionName: "getMarkets",
      args: [g!.DataStore, 0n, 100n],
    })) as readonly Market[];
    expect(markets.length).toBeGreaterThan(0);
    if (typeof g!.marketCount === "number")
      expect(markets.length).toBe(g!.marketCount);
    // 全マーケットの marketToken は非ゼロ
    for (const m of markets) expect(m.marketToken).not.toBe(ZERO);
  });

  it("記録済み market が Reader.getMarket と整合", async () => {
    if (!g!.markets?.length) return;
    const sample = g!.markets[0];
    const m = (await publicClient.readContract({
      address: g!.Reader,
      abi: readerAbi(),
      functionName: "getMarket",
      args: [g!.DataStore, sample.marketToken],
    })) as Market;
    expect(sameAddr(m.marketToken, sample.marketToken)).toBe(true);
    expect(sameAddr(m.longToken, sample.longToken)).toBe(true);
    expect(sameAddr(m.shortToken, sample.shortToken)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 完全 E2E: GM 流動性 deposit → keeper 実行 → openPosition → keeper 実行
// trader (index 2) が create、keeper (index 1) が execute、価格は MockOracleProvider 制御。
// ---------------------------------------------------------------------------

const gx = getProto<GmxRegistry>("gmxV2");

// long==WETH / short==USDC の完全担保マーケットを選ぶ
function pickWethUsdcMarket(reg: GmxRegistry | undefined): {
  market: GmxRegistry["markets"][number];
  weth: Address;
  usdc: Address;
} | null {
  if (!reg?.markets?.length || !reg.tokens?.WETH || !reg.tokens?.USDC)
    return null;
  const weth = reg.tokens.WETH;
  const usdc = reg.tokens.USDC;
  const market = reg.markets.find(
    (m) =>
      m.longToken.toLowerCase() === weth.toLowerCase() &&
      m.shortToken.toLowerCase() === usdc.toLowerCase(),
  );
  return market ? { market, weth, usdc } : null;
}

const picked = pickWethUsdcMarket(gx);

describe.skipIf(!picked)("GMX V2 完全 E2E (deposit → openPosition)", () => {
  const reg = gx!;
  const { market, weth, usdc } = picked!;

  // GMX テストトークン: WETH=18d, USDC=6d
  const LONG_DEPOSIT = 50n * 10n ** 18n; // 50 WETH
  const SHORT_DEPOSIT = 150_000n * 10n ** 6n; // 150,000 USDC
  const COLLATERAL = 1n * 10n ** 18n; // 1 WETH
  const SIZE_DELTA_USD = 3_000n * 10n ** 30n; // $3,000 (1x)

  let mock: Address;
  let keeper: Awaited<ReturnType<typeof resolveKeeper>>;

  beforeAll(async () => {
    mock = await deployMockOracleProvider();
    keeper = await resolveKeeper(reg);
    await setupOracle(reg, mock, {
      [weth]: { usd: 3000, decimals: 18 },
      [usdc]: { usd: 1, decimals: 6 },
    });
    // trader へ deposit 用 + 担保用トークンを供給 + Router approve。
    // 共有 WETH9 は mint を持たないため wrap で供給する。
    await mintAndApprove(
      weth,
      accounts.trader,
      traderWallet,
      reg.Router,
      LONG_DEPOSIT + COLLATERAL,
      { wrap: true },
    );
    await mintAndApprove(
      usdc,
      accounts.trader,
      traderWallet,
      reg.Router,
      SHORT_DEPOSIT,
    );
  });

  it("GM 流動性 deposit → keeper 実行で GM トークンが発行される", async () => {
    const before = await balanceOf(market.marketToken, accounts.trader.address);
    const key = await createDeposit(reg, market, LONG_DEPOSIT, SHORT_DEPOSIT);
    await keeperExecute("deposit", keeper, reg.DepositHandler, key, mock, [
      weth,
      usdc,
    ]);
    const after = await balanceOf(market.marketToken, accounts.trader.address);
    expect(after).toBeGreaterThan(before); // GM トークン発行 = 流動性投入成功
  });

  it("openPosition (long) → keeper 実行でポジションが生成される", async () => {
    const key = await createIncreaseOrder(
      reg,
      market,
      weth,
      COLLATERAL,
      SIZE_DELTA_USD,
      true,
    );
    await keeperExecute("order", keeper, reg.OrderHandler, key, mock, [
      weth,
      usdc,
    ]);
    const pos = await getLongPosition(reg, market.marketToken);
    expect(pos, "long ポジションが存在しない").toBeDefined();
    expect(pos!.numbers.sizeInUsd).toBeGreaterThan(0n);
    expect(pos!.numbers.collateralAmount).toBeGreaterThan(0n);
  });
});
