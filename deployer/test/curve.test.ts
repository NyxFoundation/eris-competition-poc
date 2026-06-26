import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { accounts, deployerWallet, publicClient } from "../src/clients.js";
import { anvilChain } from "../src/config.js";
import { waitTx } from "../src/util.js";
import { approve, balanceOf } from "../src/erc20.js";
import {
  curveAbi,
  getProto,
  tokenAddr,
  expectApprox,
  expectRevert,
} from "./support.js";

const dep = accounts.deployer;
const c = getProto<{ usdcDaiPool: Address }>("curve");

// seed の coins 順: index0 = USDC(6d), index1 = DAI(18d)
describe.skipIf(!c)("Curve StableSwap-NG", () => {
  const pool = () => c!.usdcDaiPool;
  const poolAbi = curveAbi("CurveStableSwapNG");
  const usdc = () => tokenAddr("USDC");
  const dai = () => tokenAddr("DAI");

  const DX = 1_000n * 10n ** 6n; // 1000 USDC

  // A: 定量 ----------------------------------------------------------------
  it("get_dy が ~1:1 帯 (1000 USDC → 990〜1000 DAI)", async () => {
    const dy = (await publicClient.readContract({
      address: pool(),
      abi: poolAbi,
      functionName: "get_dy",
      args: [0n, 1n, DX],
    })) as bigint;
    expect(dy).toBeGreaterThan(990n * 10n ** 18n);
    expect(dy).toBeLessThanOrEqual(1_000n * 10n ** 18n);
  });

  it("実 exchange 出力が get_dy と ±0.1% 一致", async () => {
    const dy = (await publicClient.readContract({
      address: pool(),
      abi: poolAbi,
      functionName: "get_dy",
      args: [0n, 1n, DX],
    })) as bigint;
    await approve(usdc(), pool(), DX);
    const before = await balanceOf(dai(), dep.address);
    const h = await deployerWallet.writeContract({
      address: pool(),
      abi: poolAbi,
      functionName: "exchange",
      args: [0n, 1n, DX, 0n, dep.address],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    const gained = (await balanceOf(dai(), dep.address)) - before;
    expect(gained).toBeGreaterThan(0n);
    expectApprox(gained, dy, 10, "exchange 出力 vs get_dy");
  });

  // C: ネガティブ ----------------------------------------------------------
  it("過大な min_dy の exchange は revert する", async () => {
    await expectRevert(
      publicClient.simulateContract({
        address: pool(),
        abi: poolAbi,
        functionName: "exchange",
        args: [0n, 1n, DX, 10_000n * 10n ** 18n, dep.address], // 達成不可能
        account: dep,
      }),
      "exchange(過大 min_dy)",
    );
  });

  // B: ライフサイクル (add → remove) --------------------------------------
  it("add_liquidity で LP 増、remove_liquidity_one_coin で USDC 戻る", async () => {
    const usdcAmt = 10_000n * 10n ** 6n;
    const daiAmt = 10_000n * 10n ** 18n;
    await approve(usdc(), pool(), usdcAmt);
    await approve(dai(), pool(), daiAmt);

    const lpBefore = await balanceOf(pool(), dep.address);
    const add = await deployerWallet.writeContract({
      address: pool(),
      abi: poolAbi,
      functionName: "add_liquidity",
      args: [[usdcAmt, daiAmt], 0n, dep.address],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(add);
    const lpAfter = await balanceOf(pool(), dep.address);
    const minted = lpAfter - lpBefore;
    expect(minted).toBeGreaterThan(0n);

    const usdcBefore = await balanceOf(usdc(), dep.address);
    const rem = await deployerWallet.writeContract({
      address: pool(),
      abi: poolAbi,
      functionName: "remove_liquidity_one_coin",
      args: [minted / 2n, 0n, 0n, dep.address], // i=0 (USDC)
      account: dep,
      chain: anvilChain,
    });
    await waitTx(rem);
    expect(await balanceOf(usdc(), dep.address)).toBeGreaterThan(usdcBefore);
  });

  it("get_virtual_price が ~1e18", async () => {
    const vp = (await publicClient.readContract({
      address: pool(),
      abi: poolAbi,
      functionName: "get_virtual_price",
    })) as bigint;
    expect(vp).toBeGreaterThan(99n * 10n ** 16n); // 0.99e18
    expect(vp).toBeLessThan(101n * 10n ** 16n); // 1.01e18
  });
});
