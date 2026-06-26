import { defineChain } from "viem";
import "dotenv/config";

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
export const RPC_PORT = Number(new URL(RPC_URL).port || "8545");

// anvil 既定 mnemonic。index 0 = deployer / owner。
export const MNEMONIC =
  process.env.MNEMONIC ??
  "test test test test test test test test test test test junk";

// deployer がanvilプロセス自体を起動・終了まで管理するか。
export const MANAGE_ANVIL =
  (process.env.MANAGE_ANVIL ?? "true").toLowerCase() === "true";

// 空の anvil の既定 chainId。
export const CHAIN_ID = 31337;

export const anvilChain = defineChain({
  id: CHAIN_ID,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

// アカウントのロール割当 (mnemonic からの index)
export const ACCOUNT_INDEX = {
  deployer: 0,
  keeper: 1,
  trader: 2,
} as const;

// 共有 mock トークンの仕様。Uniswap / Balancer / Curve / GMX が共有する。
// (Aave は deploy-v3 が自前のテストトークンを生成するため別管理)
export type TokenSpec = {
  key: string;
  name: string;
  symbol: string;
  decimals: number;
};

export const TOKEN_SPECS: TokenSpec[] = [
  { key: "WETH", name: "Wrapped Ether", symbol: "WETH", decimals: 18 }, // 特別扱い (WETH9)
  { key: "USDC", name: "USD Coin", symbol: "USDC", decimals: 6 },
  { key: "USDT", name: "Tether USD", symbol: "USDT", decimals: 6 },
  { key: "DAI", name: "Dai Stablecoin", symbol: "DAI", decimals: 18 },
  { key: "WBTC", name: "Wrapped BTC", symbol: "WBTC", decimals: 8 },
];

// deployer に最初に mint しておく各トークンの量 (human-readable)
export const INITIAL_MINT: Record<string, string> = {
  USDC: "100000000", // 1 億 USDC
  USDT: "100000000",
  DAI: "100000000",
  WBTC: "10000", // 1 万 WBTC
};
