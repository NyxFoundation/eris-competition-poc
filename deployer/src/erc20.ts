import type { Abi, Address } from "viem";
import { accounts, deployerWallet, publicClient } from "./clients.js";
import { anvilChain } from "./config.js";
import { waitTx } from "./util.js";

// 最小 ERC20 ABI (mock トークン・各プロトコルのトークン双方で使える)
export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "o", type: "address" },
      { name: "s", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "s", type: "address" },
      { name: "v", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "t", type: "address" },
      { name: "v", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "t", type: "address" },
      { name: "v", type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

export async function approve(
  tokenAddr: Address,
  spender: Address,
  amount: bigint,
) {
  const hash = await deployerWallet.writeContract({
    address: tokenAddr,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, amount],
    account: accounts.deployer,
    chain: anvilChain,
  });
  await waitTx(hash);
}

export async function balanceOf(
  tokenAddr: Address,
  owner: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: tokenAddr,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  }) as Promise<bigint>;
}

export async function allowance(
  tokenAddr: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: tokenAddr,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  }) as Promise<bigint>;
}
