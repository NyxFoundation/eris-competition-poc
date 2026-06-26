import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  publicActions,
  walletActions,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { anvilChain, MNEMONIC, RPC_URL, ACCOUNT_INDEX } from "./config.js";

export const transport = http(RPC_URL, { timeout: 120_000, retryCount: 2 });

// mnemonic から各ロールのアカウントを導出
export const accounts = {
  deployer: mnemonicToAccount(MNEMONIC, {
    addressIndex: ACCOUNT_INDEX.deployer,
  }),
  keeper: mnemonicToAccount(MNEMONIC, { addressIndex: ACCOUNT_INDEX.keeper }),
  trader: mnemonicToAccount(MNEMONIC, { addressIndex: ACCOUNT_INDEX.trader }),
};

export const publicClient: PublicClient = createPublicClient({
  chain: anvilChain,
  transport,
});

// anvil チートコード (impersonate / setBalance / mine / snapshot ...)
export const testClient = createTestClient({
  chain: anvilChain,
  mode: "anvil",
  transport,
})
  .extend(publicActions)
  .extend(walletActions);

export function walletFor(
  account: (typeof accounts)[keyof typeof accounts],
): WalletClient {
  return createWalletClient({ account, chain: anvilChain, transport });
}

export const deployerWallet = walletFor(accounts.deployer);
export const keeperWallet = walletFor(accounts.keeper);
export const traderWallet = walletFor(accounts.trader);

export function impersonatedWallet(address: Address): WalletClient {
  return createWalletClient({ account: address, chain: anvilChain, transport });
}

export async function impersonate(address: Address, balanceWei = 10n ** 24n) {
  await testClient.impersonateAccount({ address });
  await testClient.setBalance({ address, value: balanceWei });
}

export async function stopImpersonate(address: Address) {
  await testClient.stopImpersonatingAccount({ address });
}

export async function advance(seconds = 2) {
  await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
}
