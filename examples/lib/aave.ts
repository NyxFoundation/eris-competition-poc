/**
 * Aave V3 raw transaction builders.
 *
 * Builds unsigned tx objects ({ to, data }) for supply, withdraw,
 * and ERC-20 approval. No external CLI or dependencies beyond viem.
 */
import { encodeFunctionData } from "viem";

const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

const TOKENS: Record<string, { address: `0x${string}`; decimals: number }> = {
  USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  DAI:  { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
};

export type RawTx = { to: string; data: string; value?: string };

const erc20ApproveAbi = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

const poolSupplyAbi = [{
  type: "function", name: "supply", stateMutability: "nonpayable",
  inputs: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "onBehalfOf", type: "address" },
    { name: "referralCode", type: "uint16" },
  ],
  outputs: [],
}] as const;

const poolWithdrawAbi = [{
  type: "function", name: "withdraw", stateMutability: "nonpayable",
  inputs: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "to", type: "address" },
  ],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

function resolveToken(symbol: string) {
  const token = TOKENS[symbol.toUpperCase()];
  if (!token) throw new Error(`Unsupported token: ${symbol}. Supported: ${Object.keys(TOKENS).join(", ")}`);
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
  const amountBase = amount < 0
    ? 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn
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
