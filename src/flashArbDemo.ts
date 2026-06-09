// フラッシュ arb デモ(GitHub #3)。ERIS_FLASH_ARB=1 のときだけ coordinator から使う。
// 固定 deployer の nonce-0 デプロイで FlashArb のアドレスを決定論化し、agent 側でも
// getContractAddress で同じ値を計算できる(env 注入不要)。既定 off。
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import {
  getContractAddress,
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { accountAddress, mine, setEthBalance } from "./chain.js";
import { AAVE, BALANCER, TOKENS, UNISWAP } from "./constants.js";
import type { SimContext } from "./protocols/types.js";

const here = dirname(fileURLToPath(import.meta.url));

// デモ用の固定 deployer 鍵。FlashArb をこの鍵の最初の tx(nonce 0)としてデプロイするため、
// CREATE アドレスが決定論的になる。
export const FLASH_DEPLOYER_KEY: Hex = keccak256(
  toBytes("eris-flash-arb-deployer-v1"),
);
export const FLASH_DEPLOYER_ADDRESS: Address =
  accountAddress(FLASH_DEPLOYER_KEY);

// nonce 0 デプロイの決定論アドレス。agent も coordinator もこの値を使う。
export const FLASH_ARB_ADDRESS: Address = getContractAddress({
  from: FLASH_DEPLOYER_ADDRESS,
  nonce: 0n,
});

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const p = resolve(here, `../out/${name}.sol/${name}.json`);
  if (!existsSync(p)) {
    throw new Error(
      `forge artifact missing: ${p}. Run \`npm run build:contracts\`.`,
    );
  }
  const a = JSON.parse(readFileSync(p, "utf8"));
  return {
    abi: a.abi as Abi,
    bytecode: (a.bytecode?.object ?? a.bytecode) as Hex,
  };
}

// FlashArb を固定 deployer から(nonce 0 で)デプロイ。setup フェーズで 1 回。
export async function deployFlashArb(ctx: SimContext): Promise<Address> {
  const account = privateKeyToAccount(FLASH_DEPLOYER_KEY);
  await setEthBalance(
    ctx.publicClient,
    FLASH_DEPLOYER_ADDRESS,
    1_000_000_000_000_000_000n,
  );
  const { abi, bytecode } = artifact("FlashArb");
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hash = await ctx.walletClient.deployContract({
    abi,
    bytecode,
    args: [
      AAVE.Pool,
      UNISWAP.swapRouter,
      BALANCER.vault,
      BALANCER.poolId,
      TOKENS.WETH.address,
      TOKENS.USDC.address,
      UNISWAP.fee,
    ] as never,
    account,
    chain: ctx.chain,
    maxFeePerGas: baseFee + 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  await mine(ctx.publicClient);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("FlashArb deploy failed");
  if (
    receipt.contractAddress.toLowerCase() !== FLASH_ARB_ADDRESS.toLowerCase()
  ) {
    throw new Error(
      `FlashArb address mismatch: ${receipt.contractAddress} != ${FLASH_ARB_ADDRESS}`,
    );
  }
  return receipt.contractAddress;
}
