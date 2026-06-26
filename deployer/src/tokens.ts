import { parseUnits, type Address } from "viem";
import { deployerWallet, publicClient, accounts } from "./clients.js";
import { anvilChain, TOKEN_SPECS, INITIAL_MINT } from "./config.js";
import { loadForgeArtifact, waitTx, ok, info } from "./util.js";
import { setTokens, setProtocol } from "./registry.js";

/**
 * 共有 mock トークンをデプロイする。
 * - WETH (key=WETH) は WETH9 をデプロイ (deposit/withdraw 可能)
 * - それ以外は MockERC20 をデプロイし deployer へ初期 mint
 * 戻り値はトークン key -> address のマップ。
 */
export async function deployTokens(): Promise<Record<string, Address>> {
  info("共有 mock トークンをデプロイ");
  const weth9 = loadForgeArtifact("WETH9", "WETH9");
  const erc20 = loadForgeArtifact("MockERC20", "MockERC20");
  const result: Record<string, Address> = {};

  for (const spec of TOKEN_SPECS) {
    if (spec.key === "WETH") {
      const hash = await deployerWallet.deployContract({
        abi: weth9.abi,
        bytecode: weth9.bytecode,
        account: accounts.deployer,
        chain: anvilChain,
        args: [],
      });
      const rc = await waitTx(hash);
      result.WETH = rc.contractAddress as Address;
      ok("WETH9", result.WETH);
      continue;
    }

    const hash = await deployerWallet.deployContract({
      abi: erc20.abi,
      bytecode: erc20.bytecode,
      account: accounts.deployer,
      chain: anvilChain,
      args: [spec.name, spec.symbol, spec.decimals],
    });
    const rc = await waitTx(hash);
    const addr = rc.contractAddress as Address;
    result[spec.key] = addr;

    const mintHuman = INITIAL_MINT[spec.key];
    if (mintHuman) {
      const amount = parseUnits(mintHuman, spec.decimals);
      const mh = await deployerWallet.writeContract({
        address: addr,
        abi: erc20.abi,
        functionName: "mint",
        args: [accounts.deployer.address, amount],
        account: accounts.deployer,
        chain: anvilChain,
      });
      await waitTx(mh);
    }
    ok(`${spec.symbol} (${spec.decimals}d)`, addr);
  }

  // deployer の WETH を確保: ETH を一部 wrap しておく
  await wrapWeth(result.WETH, parseUnits("10000", 18));

  setTokens(result);

  // Multicall3 を配置する。fork では canonical 0xcA11.. が既存だが、空 anvil には
  // 無いため自前デプロイし registry に記録する (poc の採点 reconstruct / viem multicall 用)。
  await deployMulticall3();

  return result;
}

/** Multicall3 をデプロイし registry.common.multicall3 に記録 */
async function deployMulticall3() {
  const mc = loadForgeArtifact("Multicall3", "Multicall3");
  const hash = await deployerWallet.deployContract({
    abi: mc.abi,
    bytecode: mc.bytecode,
    account: accounts.deployer,
    chain: anvilChain,
    args: [],
  });
  const rc = await waitTx(hash);
  const addr = rc.contractAddress as Address;
  setProtocol("common", { multicall3: addr });
  ok("Multicall3", addr);
}

/** deployer の ETH を WETH9 に deposit する */
export async function wrapWeth(weth: Address, amount: bigint) {
  const weth9 = loadForgeArtifact("WETH9", "WETH9");
  const hash = await deployerWallet.writeContract({
    address: weth,
    abi: weth9.abi,
    functionName: "deposit",
    value: amount,
    account: accounts.deployer,
    chain: anvilChain,
  });
  await waitTx(hash);
}

export async function balanceOf(
  tokenAddr: Address,
  owner: Address,
): Promise<bigint> {
  const erc20 = loadForgeArtifact("MockERC20", "MockERC20");
  return publicClient.readContract({
    address: tokenAddr,
    abi: erc20.abi,
    functionName: "balanceOf",
    args: [owner],
  }) as Promise<bigint>;
}
