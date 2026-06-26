import { describe, it, expect } from "vitest";
import {
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { accounts, deployerWallet, publicClient } from "../src/clients.js";
import { anvilChain } from "../src/config.js";
import { waitTx } from "../src/util.js";
import { approve, balanceOf } from "../src/erc20.js";
import {
  vaultAbi,
  getProto,
  tokenAddr,
  expectApprox,
  expectRevert,
  deadline,
} from "./support.js";

const dep = accounts.deployer;
const ONE_WETH = 10n ** 18n;

const b = getProto<{
  vault: Address;
  wethUsdcPool: Address;
  wethUsdcPoolId: Hex;
}>("balancerV2");

describe.skipIf(!b)("Balancer V2", () => {
  const vault = () => b!.vault;
  const poolId = () => b!.wethUsdcPoolId;
  const weth = () => tokenAddr("WETH");
  const usdc = () => tokenAddr("USDC");

  const funds = () => ({
    sender: dep.address,
    fromInternalBalance: false,
    recipient: dep.address,
    toInternalBalance: false,
  });

  // A: 定量 (queryBatchSwap の見積り vs 実 swap) -----------------------------
  it("queryBatchSwap の見積りと実 swap が ±0.5% 一致 (WETH→USDC)", async () => {
    const assets = [weth(), usdc()] as Address[];
    const { result } = await publicClient.simulateContract({
      address: vault(),
      abi: vaultAbi(),
      functionName: "queryBatchSwap",
      args: [
        0, // GIVEN_IN
        [
          {
            poolId: poolId(),
            assetInIndex: 0n,
            assetOutIndex: 1n,
            amount: ONE_WETH,
            userData: "0x" as Hex,
          },
        ],
        assets,
        funds(),
      ],
      account: dep,
    });
    const deltas = result as readonly bigint[];
    // deltas[1] は vault から出る量なので負。期待 USDC 出力 = -deltas[1]
    const expectedOut = -deltas[1];
    expect(expectedOut).toBeGreaterThan(0n);

    await approve(weth(), vault(), ONE_WETH);
    const before = await balanceOf(usdc(), dep.address);
    const h = await deployerWallet.writeContract({
      address: vault(),
      abi: vaultAbi(),
      functionName: "swap",
      args: [
        {
          poolId: poolId(),
          kind: 0,
          assetIn: weth(),
          assetOut: usdc(),
          amount: ONE_WETH,
          userData: "0x" as Hex,
        },
        funds(),
        0n,
        deadline(),
      ],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    const gained = (await balanceOf(usdc(), dep.address)) - before;
    expect(gained).toBeGreaterThan(0n);
    expectApprox(gained, expectedOut, 50, "swap 出力 vs queryBatchSwap");
  });

  // C: ネガティブ ----------------------------------------------------------
  it("過大な limit(minOut) の swap は revert する", async () => {
    await expectRevert(
      publicClient.simulateContract({
        address: vault(),
        abi: vaultAbi(),
        functionName: "swap",
        args: [
          {
            poolId: poolId(),
            kind: 0,
            assetIn: weth(),
            assetOut: usdc(),
            amount: ONE_WETH,
            userData: "0x" as Hex,
          },
          funds(),
          1_000_000n * 10n ** 6n, // 達成不可能な minOut
          deadline(),
        ],
        account: dep,
      }),
      "swap(過大 limit)",
    );
  });

  // B: ライフサイクル (exitPool で流動性を引き出す) ------------------------
  it("exitPool で BPT が減りトークンが戻る", async () => {
    // 登録順 (昇順) の assets を vault から取得
    const pt = (await publicClient.readContract({
      address: vault(),
      abi: vaultAbi(),
      functionName: "getPoolTokens",
      args: [poolId()],
    })) as readonly [Address[], bigint[], bigint];
    const assets = pt[0];

    const bptBefore = await balanceOf(b!.wethUsdcPool, dep.address);
    expect(bptBefore).toBeGreaterThan(0n);
    const wethBefore = await balanceOf(weth(), dep.address);
    const usdcBefore = await balanceOf(usdc(), dep.address);

    // EXACT_BPT_IN_FOR_TOKENS_OUT (kind=1): userData = abi.encode(uint256 kind, uint256 bptAmountIn)
    const bptIn = bptBefore / 10n; // 10%
    const userData = encodeAbiParameters(
      parseAbiParameters("uint256, uint256"),
      [1n, bptIn],
    );
    const h = await deployerWallet.writeContract({
      address: vault(),
      abi: vaultAbi(),
      functionName: "exitPool",
      args: [
        poolId(),
        dep.address,
        dep.address,
        {
          assets,
          minAmountsOut: assets.map(() => 0n),
          userData,
          toInternalBalance: false,
        },
      ],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);

    expect(await balanceOf(b!.wethUsdcPool, dep.address)).toBeLessThan(
      bptBefore,
    );
    const wethAfter = await balanceOf(weth(), dep.address);
    const usdcAfter = await balanceOf(usdc(), dep.address);
    expect(wethAfter > wethBefore && usdcAfter > usdcBefore).toBe(true);
  });
});
