/**
 * Aave V3 raw transaction builders.
 *
 * Builds unsigned tx objects ({ to, data }) for supply, withdraw,
 * and ERC-20 approval. Pool/トークンアドレスは src/constants.ts(Arbitrum)を参照。
 */
import { encodeFunctionData } from "viem";
import { AAVE, TOKENS as ARB_TOKENS } from "../../src/constants.js";

// sim は Arbitrum フォーク。Pool/トークンは src/constants.ts の Arbitrum 値を使う
// （mainnet ハードコードだとフォーク上の存在しないコントラクトに当たり機能しない）。
const AAVE_V3_POOL: `0x${string}` = AAVE.Pool;

const TOKENS: Record<string, { address: `0x${string}`; decimals: number }> = {
  USDC: {
    address: ARB_TOKENS.USDC.address,
    decimals: ARB_TOKENS.USDC.decimals,
  },
  WETH: {
    address: ARB_TOKENS.WETH.address,
    decimals: ARB_TOKENS.WETH.decimals,
  },
};

export type RawTx = { to: string; data: string; value?: string };

const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const poolSupplyAbi = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
] as const;

const poolWithdrawAbi = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function resolveToken(symbol: string) {
  const token = TOKENS[symbol.toUpperCase()];
  if (!token)
    throw new Error(
      `Unsupported token: ${symbol}. Supported: ${Object.keys(TOKENS).join(", ")}`,
    );
  return token;
}

function toBaseUnits(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * 10 ** decimals));
}

/**
 * Build approval + supply transactions for Aave V3.
 * Returns 2 txs: [approval, supply].
 */
export function buildAaveSupply(
  asset: string,
  amount: number,
  onBehalfOf: string,
): RawTx[] {
  const token = resolveToken(asset);
  const amountBase = toBaseUnits(amount, token.decimals);

  const approval: RawTx = {
    to: token.address,
    data: encodeFunctionData({
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [AAVE_V3_POOL as `0x${string}`, amountBase],
    }),
  };

  const supply: RawTx = {
    to: AAVE_V3_POOL,
    data: encodeFunctionData({
      abi: poolSupplyAbi,
      functionName: "supply",
      args: [token.address, amountBase, onBehalfOf as `0x${string}`, 0],
    }),
  };

  return [approval, supply];
}

/**
 * Build withdraw transaction for Aave V3.
 * Use amount = -1 for max withdrawal (type(uint256).max).
 */
export function buildAaveWithdraw(
  asset: string,
  amount: number,
  to: string,
): RawTx {
  const token = resolveToken(asset);
  const amountBase =
    amount < 0
      ? 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn
      : toBaseUnits(amount, token.decimals);

  return {
    to: AAVE_V3_POOL,
    data: encodeFunctionData({
      abi: poolWithdrawAbi,
      functionName: "withdraw",
      args: [token.address, amountBase, to as `0x${string}`],
    }),
  };
}
