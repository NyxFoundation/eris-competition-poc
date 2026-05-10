import { readFileSync, existsSync } from "node:fs";
import type { Hex } from "viem";
import { DEFAULT_ANVIL_PRIVATE_KEYS, MAX_BUNDLE_ACTIONS } from "./constants.js";
import type { AgentSpec, AgentsFile } from "./types.js";

const SUPPORTED_AGENT_WALLETS = ["AGENT0_PRIVATE_KEY", "AGENT1_PRIVATE_KEY", "AGENT2_PRIVATE_KEY"] as const;

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
  maxBundleActions: number;
  maxLpWethWei: bigint;
  maxLpUsdcUnits: bigint;
  maxOpenPositions: number;
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
    maxBundleActions: intEnv(env.MAX_BUNDLE_ACTIONS, MAX_BUNDLE_ACTIONS),
    maxLpWethWei: bigintEnv(env.MAX_LP_WETH_WEI, 1_000_000_000_000_000_000n),
    maxLpUsdcUnits: bigintEnv(env.MAX_LP_USDC_UNITS, 5_000_000_000n),
    maxOpenPositions: intEnv(env.MAX_OPEN_POSITIONS, 10),
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
  if (!existsSync(path)) return defaultAgents();
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return validateAgentsFile(parsed, path);
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

function defaultAgents(): AgentSpec[] {
  return validateAgentsFile(
    {
      agents: [
        { id: "noop", command: "node", args: ["--import", "tsx", "examples/agents/noop.ts"], wallet: "AGENT0_PRIVATE_KEY" },
        { id: "random", command: "node", args: ["--import", "tsx", "examples/agents/random.ts"], wallet: "AGENT1_PRIVATE_KEY" },
        { id: "simple", command: "node", args: ["--import", "tsx", "examples/agents/simple-rule.ts"], wallet: "AGENT2_PRIVATE_KEY" }
      ]
    },
    "default agents"
  );
}

function validateAgentsFile(parsed: unknown, path: string): AgentSpec[] {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${path} must be a JSON object`);
  }
  const file = parsed as AgentsFile;
  if (!Array.isArray(file.agents) || file.agents.length === 0) {
    throw new Error(`${path} must contain a non-empty "agents" array`);
  }
  const seenIds = new Set<string>();
  return file.agents.map((agent, index) => {
    const label = `${path} agents[${index}]`;
    if (!agent || typeof agent !== "object") throw new Error(`${label} must be an object`);
    if (typeof agent.id !== "string" || agent.id.trim() === "") throw new Error(`${label}.id must be a non-empty string`);
    if (seenIds.has(agent.id)) throw new Error(`${path} contains duplicate agent id: ${agent.id}`);
    seenIds.add(agent.id);
    if (typeof agent.command !== "string" || agent.command.trim() === "") throw new Error(`${label}.command must be a non-empty string`);
    if (agent.args !== undefined && (!Array.isArray(agent.args) || !agent.args.every((arg) => typeof arg === "string"))) {
      throw new Error(`${label}.args must be an array of strings`);
    }
    if (!isSupportedAgentWallet(agent.wallet)) {
      throw new Error(`${label}.wallet must be one of ${SUPPORTED_AGENT_WALLETS.join(", ")}`);
    }
    if (agent.description !== undefined && typeof agent.description !== "string") {
      throw new Error(`${label}.description must be a string when present`);
    }
    return {
      id: agent.id,
      command: agent.command,
      args: agent.args,
      wallet: agent.wallet,
      description: agent.description
    };
  });
}

function isSupportedAgentWallet(wallet: unknown): wallet is (typeof SUPPORTED_AGENT_WALLETS)[number] {
  return typeof wallet === "string" && SUPPORTED_AGENT_WALLETS.includes(wallet as (typeof SUPPORTED_AGENT_WALLETS)[number]);
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
  if (!/^0x[0-9a-fA-F]{64}$/.test(result)) throw new Error("Private key must be a 0x-prefixed 32-byte hex string");
  return result as Hex;
}
