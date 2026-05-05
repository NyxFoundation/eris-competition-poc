import type { Hex } from "viem";

export type TokenSymbol = "WETH" | "USDC";

export type AgentAction =
  | { type: "noop"; reason?: string }
  | {
      type: "swap";
      tokenIn: TokenSymbol;
      amountIn: string;
      maxPriorityFeePerGasWei?: string;
      slippageBps?: number;
    };

export type AgentObservation = {
  kind: "observation";
  runId: string;
  round: number;
  blockNumber: string;
  pool: {
    pair: "WETH/USDC";
    fee: 500;
    priceUsdcPerWeth: number;
  };
  fairPriceUsdcPerWeth: number;
  balances: {
    ethWei: string;
    wethWei: string;
    usdcUnits: string;
  };
  inventory: {
    valueUsdc: number;
    weth: number;
    usdc: number;
    eth: number;
  };
  history: Array<{
    round: number;
    poolPriceUsdcPerWeth: number;
    fairPriceUsdcPerWeth: number;
  }>;
  limits: {
    maxWethInWei: string;
    maxUsdcInUnits: string;
    defaultPriorityFeePerGasWei: string;
    maxPriorityFeePerGasWei: string;
    defaultSlippageBps: number;
  };
};

export type AgentSpec = {
  id: string;
  command: string;
  args?: string[];
  wallet: string;
};

export type AgentsFile = {
  agents: AgentSpec[];
};

export type WalletRole = "agent" | "uninformed-flow" | "informed-flow" | "setup";

export type SimWallet = {
  id: string;
  role: WalletRole;
  privateKey: Hex;
};

export type TxIntent = {
  ownerId: string;
  role: WalletRole;
  privateKey: Hex;
  action: AgentAction;
  priorityFeeWei: bigint;
};

export type BalanceSnapshot = {
  ethWei: bigint;
  wethWei: bigint;
  usdcUnits: bigint;
};
