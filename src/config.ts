import { readFileSync, existsSync } from "node:fs";
import type { Hex } from "viem";
import { DEFAULT_ANVIL_PRIVATE_KEYS } from "./constants.js";
import type { AgentSpec, AgentsFile } from "./types.js";

export type SimConfig = {
  rpcUrl: string;
  chainId: number;
  rounds: number;
  seed: number;
  runDirRoot: string;
  agentTimeoutMs: number;
  agentsConfigPath: string;
  initialEthWei: bigint;
  initialWethWei: bigint;
  initialSwapWethWei: bigint;
  defaultPriorityFeeWei: bigint;
  maxPriorityFeeWei: bigint;
  maxAgentWethInWei: bigint;
  maxAgentUsdcInUnits: bigint;
  uninformedFlowMaxWethWei: bigint;
  informedFlowMaxWethWei: bigint;
  privateKeys: {
    agent0: Hex;
    agent1: Hex;
    agent2: Hex;
    uninformedFlow: Hex;
    informedFlow: Hex;
    setup: Hex;
  };
};

export function loadConfig(env = process.env): SimConfig {
  const anvilPort = env.ANVIL_PORT ?? "8545";
  return {
    rpcUrl: env.ANVIL_RPC_URL ?? `http://127.0.0.1:${anvilPort}`,
    chainId: intEnv(env.CHAIN_ID, 31337),
    rounds: intEnv(env.ROUNDS, 50),
    seed: intEnv(env.SEED, 1),
    runDirRoot: env.REPORT_DIR ?? "./runs",
    agentTimeoutMs: intEnv(env.AGENT_TIMEOUT_MS, 5000),
    agentsConfigPath: env.AGENTS_CONFIG ?? "agents.local.json",
    initialEthWei: bigintEnv(env.INITIAL_ETH_WEI, 100_000_000_000_000_000_000n),
    initialWethWei: bigintEnv(env.INITIAL_WETH_WEI, 10_000_000_000_000_000_000n),
    initialSwapWethWei: bigintEnv(env.INITIAL_SWAP_WETH_WEI, 5_000_000_000_000_000_000n),
    defaultPriorityFeeWei: bigintEnv(env.DEFAULT_PRIORITY_FEE_WEI, 100_000_000n),
    maxPriorityFeeWei: bigintEnv(env.MAX_PRIORITY_FEE_WEI, 5_000_000_000n),
    maxAgentWethInWei: bigintEnv(env.MAX_AGENT_WETH_IN_WEI, 1_000_000_000_000_000_000n),
    maxAgentUsdcInUnits: bigintEnv(env.MAX_AGENT_USDC_IN_UNITS, 5_000_000_000n),
    uninformedFlowMaxWethWei: bigintEnv(env.UNINFORMED_FLOW_MAX_WETH_WEI, 1_000_000_000_000_000_000n),
    informedFlowMaxWethWei: bigintEnv(env.INFORMED_FLOW_MAX_WETH_WEI, 2_000_000_000_000_000_000n),
    privateKeys: {
      agent0: hexEnv(env.AGENT0_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[0]),
      agent1: hexEnv(env.AGENT1_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[1]),
      agent2: hexEnv(env.AGENT2_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[2]),
      uninformedFlow: hexEnv(env.FLOW_UNINFORMED_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[7]),
      informedFlow: hexEnv(env.FLOW_INFORMED_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[8]),
      setup: hexEnv(env.SETUP_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[9])
    }
  };
}

export function loadAgents(path: string): AgentSpec[] {
  if (!existsSync(path)) {
    return [
      { id: "noop", command: "node", args: ["--import", "tsx", "examples/agents/noop.ts"], wallet: "AGENT0_PRIVATE_KEY" },
      { id: "random", command: "node", args: ["--import", "tsx", "examples/agents/random.ts"], wallet: "AGENT1_PRIVATE_KEY" },
      { id: "simple", command: "node", args: ["--import", "tsx", "examples/agents/simple-rule.ts"], wallet: "AGENT2_PRIVATE_KEY" }
    ];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as AgentsFile;
  if (!Array.isArray(parsed.agents) || parsed.agents.length === 0) {
    throw new Error(`${path} must contain a non-empty "agents" array`);
  }
  return parsed.agents;
}

export function privateKeyForWalletName(config: SimConfig, wallet: string): Hex {
  switch (wallet) {
    case "AGENT0_PRIVATE_KEY":
      return config.privateKeys.agent0;
    case "AGENT1_PRIVATE_KEY":
      return config.privateKeys.agent1;
    case "AGENT2_PRIVATE_KEY":
      return config.privateKeys.agent2;
    default:
      throw new Error(`Unsupported wallet binding: ${wallet}`);
  }
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected integer env value, got ${value}`);
  return parsed;
}

function bigintEnv(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || value === "") return fallback;
  return BigInt(value);
}

function hexEnv(value: string | undefined, fallback: string): Hex {
  const result = value && value.length > 0 ? value : fallback;
  if (!result.startsWith("0x")) throw new Error(`Private key must be 0x-prefixed`);
  return result as Hex;
}
