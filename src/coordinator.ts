import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { formatEther, type Hex } from "viem";
import { loadAgents, loadConfig, privateKeyForWalletName, type SimConfig } from "./config.js";
import { ADDRESSES, WETH_USDC_FEE } from "./constants.js";
import { AgentProcess } from "./agentProcess.js";
import { validateAction } from "./action.js";
import { accountAddress, getBalances, makeClients, mine, sendAndMine, setupWallet, snapshotForLog } from "./chain.js";
import { RunLogger, safeStringify } from "./logger.js";
import { balanceToInventory, positionsValueUsdc, valueUsdc, valueUsdcWithPositions } from "./pnl.js";
import { nextFairPrice, Rng } from "./rng.js";
import type { AgentAction, AgentObservation, BalanceSnapshot, SimWallet, TxIntent, WalletRole } from "./types.js";
import { buildLpActionData, buildSwapData, getLpPositions, getPoolPriceUsdcPerWeth, getPoolState } from "./uniswap.js";

type AgentRuntime = {
  id: string;
  privateKey: Hex;
  process: AgentProcess;
  initial: BalanceSnapshot;
};

type AgentMetrics = {
  gasUsed: bigint;
  gasCostWei: bigint;
  revertCount: number;
  submittedTxCount: number;
  includedTxCount: number;
};

type SubmittedTx = {
  hash: Hex;
  ownerId: string;
  role: WalletRole;
  priorityFeeWei: bigint;
  actionType: string;
  bundleId?: string;
  bundleIndex?: number;
};

type ReceiptResult = {
  tx: SubmittedTx;
  status: string;
  gasUsed: bigint;
  gasCostWei: bigint;
};

const FLOW_SLIPPAGE_BPS = 100;

export async function runSimulation(): Promise<void> {
  const config = loadConfig();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logger = new RunLogger(config.runDirRoot, runId);
  logger.event({ type: "run_started", runId, config: publicConfig(config) });

  const { chain, publicClient, walletClient } = makeClients(config.rpcUrl, config.chainId);
  const agentSpecs = loadAgents(config.agentsConfigPath);
  const agentRuntimes: AgentRuntime[] = agentSpecs.map((spec) => ({
    id: spec.id,
    privateKey: privateKeyForWalletName(config, spec.wallet),
    process: new AgentProcess(spec),
    initial: { ethWei: 0n, wethWei: 0n, usdcUnits: 0n }
  }));
  const agentMetrics = new Map(agentRuntimes.map((agent) => [agent.id, emptyAgentMetrics()]));
  const flowWallets: SimWallet[] = [
    { id: "uninformed-flow", role: "uninformed-flow", privateKey: config.privateKeys.uninformedFlow },
    { id: "informed-flow", role: "informed-flow", privateKey: config.privateKeys.informedFlow }
  ];

  try {
    const setupWallets = [
      ...agentRuntimes.map((agent): SimWallet => ({ id: agent.id, role: "agent", privateKey: agent.privateKey })),
      ...flowWallets
    ];
    for (const wallet of setupWallets) {
      logger.event({ type: "wallet_setup_started", id: wallet.id, role: wallet.role, address: accountAddress(wallet.privateKey) });
      await setupWallet(publicClient, walletClient, chain, wallet.privateKey, config.initialEthWei, config.initialWethWei);
      await initialUsdcSwap(publicClient, walletClient, chain, wallet.privateKey, config);
      logger.event({ type: "wallet_setup_completed", id: wallet.id, balances: snapshotForLog(await getBalances(publicClient, accountAddress(wallet.privateKey))) });
    }

    let fairPrice = await getPoolPriceUsdcPerWeth(publicClient);
    const rng = new Rng(config.seed);
    const history: AgentObservation["history"] = [];
    for (const agent of agentRuntimes) {
      agent.initial = await getBalances(publicClient, accountAddress(agent.privateKey));
    }

    for (let round = 1; round <= config.rounds; round++) {
      const poolState = await getPoolState(publicClient);
      const poolPrice = poolState.priceUsdcPerWeth;
      fairPrice = nextFairPrice(fairPrice, rng);
      history.push({ round, poolPriceUsdcPerWeth: poolPrice, fairPriceUsdcPerWeth: fairPrice });

      const block = await publicClient.getBlock();
      const agentIntents: TxIntent[] = [];
      for (const agent of agentRuntimes) {
        const address = accountAddress(agent.privateKey);
        const balances = await getBalances(publicClient, address);
        const positions = await getLpPositions(publicClient, address, fairPrice);
        const observation = observationFor(runId, round, block.number, poolState, fairPrice, balances, positions, history, config);
        logger.event({ type: "observation", agentId: agent.id, observation });
        const action = await agent.process.requestAction(observation, config.agentTimeoutMs);
        const validated = validateAction(action, observation, balances);
        if (!validated.ok) {
          logger.event({ type: "action_rejected", agentId: agent.id, action, reason: validated.reason });
          continue;
        }
        logger.event({ type: "action_accepted", agentId: agent.id, action: validated.action, intents: validated.intents });
        for (const intent of validated.intents) {
          agentIntents.push({
            ownerId: agent.id,
            role: "agent",
            privateKey: agent.privateKey,
            action: intent.action,
            priorityFeeWei: intent.priorityFeeWei,
            bundleId: intent.bundleId,
            bundleIndex: intent.bundleIndex
          });
        }
      }

      const flowIntents = await buildFlowIntents(publicClient, config, rng, poolPrice, fairPrice);
      const submitted: SubmittedTx[] = [];
      for (const intent of [...flowIntents, ...agentIntents]) {
        try {
          const hash = await submitIntent(publicClient, walletClient, chain, intent);
          submitted.push({
            hash,
            ownerId: intent.ownerId,
            role: intent.role,
            priorityFeeWei: intent.priorityFeeWei,
            actionType: intent.action.type,
            bundleId: intent.bundleId,
            bundleIndex: intent.bundleIndex
          });
          if (intent.role === "agent") agentMetrics.get(intent.ownerId)!.submittedTxCount++;
          logger.event({
            type: "tx_submitted",
            round,
            hash,
            ownerId: intent.ownerId,
            role: intent.role,
            priorityFeeWei: intent.priorityFeeWei,
            actionType: intent.action.type,
            bundleId: intent.bundleId,
            bundleIndex: intent.bundleIndex
          });
        } catch (error) {
          logger.event({
            type: "tx_submit_failed",
            round,
            ownerId: intent.ownerId,
            role: intent.role,
            priorityFeeWei: intent.priorityFeeWei,
            actionType: intent.action.type,
            bundleId: intent.bundleId,
            bundleIndex: intent.bundleIndex,
            error: errorMessage(error)
          });
        }
      }

      await mine(publicClient);
      const receiptResults = await logReceiptsAndOrdering(publicClient, logger, round, submitted);
      for (const result of receiptResults) {
        if (result.tx.role !== "agent") continue;
        const metrics = agentMetrics.get(result.tx.ownerId)!;
        metrics.gasUsed += result.gasUsed;
        metrics.gasCostWei += result.gasCostWei;
        metrics.includedTxCount++;
        if (result.status !== "success") metrics.revertCount++;
      }
    }

    const finalFairPrice = history.at(-1)?.fairPriceUsdcPerWeth ?? fairPrice;
    const agents = [];
    for (const agent of agentRuntimes) {
      const address = accountAddress(agent.privateKey);
      const final = await getBalances(publicClient, address);
      const positions = await getLpPositions(publicClient, address, finalFairPrice);
      const initialValue = valueUsdc(agent.initial, finalFairPrice);
      const finalValue = valueUsdcWithPositions(final, positions, finalFairPrice);
      agents.push({
        id: agent.id,
        address,
        initial: snapshotForLog(agent.initial),
        final: snapshotForLog(final),
        positions,
        openLpPositionCount: positions.length,
        lpValueUsdc: positionsValueUsdc(positions),
        initialValueUsdc: initialValue,
        finalValueUsdc: finalValue,
        netPnlUsdc: finalValue - initialValue,
        ...agentMetricsForSummary(agentMetrics.get(agent.id)!),
        stderrTail: agent.process.getStderr()
      });
    }
    logger.summary({ runId, rounds: config.rounds, finalFairPriceUsdcPerWeth: finalFairPrice, agents });
    writeFileSync(join(logger.runDir, "history.json"), `${safeStringify(history, 2)}\n`);
    logger.event({ type: "run_completed", runId, runDir: logger.runDir });
    console.log(`simulation completed: ${logger.runDir}`);
  } finally {
    for (const agent of agentRuntimes) agent.process.close();
  }
}

async function initialUsdcSwap(
  publicClient: ReturnType<typeof makeClients>["publicClient"],
  walletClient: ReturnType<typeof makeClients>["walletClient"],
  chain: ReturnType<typeof makeClients>["chain"],
  privateKey: Hex,
  config: SimConfig
) {
  if (config.initialSwapWethWei <= 0n) return;
  const data = await buildSwapData(publicClient, accountAddress(privateKey), {
    type: "swap",
    tokenIn: "WETH",
    amountIn: config.initialSwapWethWei.toString(),
    slippageBps: 100
  }, 100);
  await sendAndMine(publicClient, walletClient, chain, privateKey, { to: ADDRESSES.swapRouter, data });
}

function observationFor(
  runId: string,
  round: number,
  blockNumber: bigint,
  poolState: { priceUsdcPerWeth: number; tick: number; tickSpacing: number },
  fairPrice: number,
  balances: BalanceSnapshot,
  positions: AgentObservation["positions"],
  history: AgentObservation["history"],
  config: SimConfig
): AgentObservation {
  return {
    kind: "observation",
    runId,
    round,
    blockNumber: blockNumber.toString(),
    pool: { pair: "WETH/USDC", fee: WETH_USDC_FEE, priceUsdcPerWeth: poolState.priceUsdcPerWeth, tick: poolState.tick, tickSpacing: poolState.tickSpacing },
    positions,
    fairPriceUsdcPerWeth: fairPrice,
    balances: {
      ethWei: balances.ethWei.toString(),
      wethWei: balances.wethWei.toString(),
      usdcUnits: balances.usdcUnits.toString()
    },
    inventory: balanceToInventory(balances, fairPrice),
    history: history.slice(-20),
    limits: {
      maxWethInWei: config.maxAgentWethInWei.toString(),
      maxUsdcInUnits: config.maxAgentUsdcInUnits.toString(),
      defaultPriorityFeePerGasWei: config.defaultPriorityFeeWei.toString(),
      maxPriorityFeePerGasWei: config.maxPriorityFeeWei.toString(),
      defaultSlippageBps: 50,
      maxBundleActions: config.maxBundleActions,
      maxLpWethWei: config.maxLpWethWei.toString(),
      maxLpUsdcUnits: config.maxLpUsdcUnits.toString(),
      maxOpenPositions: config.maxOpenPositions
    }
  };
}

async function buildFlowIntents(
  publicClient: ReturnType<typeof makeClients>["publicClient"],
  config: SimConfig,
  rng: Rng,
  poolPrice: number,
  fairPrice: number
): Promise<TxIntent[]> {
  const uninformedTokenIn = rng.bool() ? "WETH" : "USDC";
  const uninformedAmount =
    uninformedTokenIn === "WETH"
      ? randomBigInt(rng, config.uninformedFlowMaxWethWei / 20n, config.uninformedFlowMaxWethWei)
      : randomBigInt(rng, 100_000_000n, 2_500_000_000n);

  const informedTokenIn = poolPrice < fairPrice ? "USDC" : "WETH";
  const gap = Math.min(1, Math.abs(fairPrice / poolPrice - 1) * 20);
  const informedAmount =
    informedTokenIn === "WETH"
      ? (config.informedFlowMaxWethWei * BigInt(Math.max(1, Math.floor(gap * 100)))) / 100n
      : BigInt(Math.max(100_000_000, Math.floor(gap * 5_000_000_000)));

  const uninformedBalances = await getBalances(publicClient, accountAddress(config.privateKeys.uninformedFlow));
  const informedBalances = await getBalances(publicClient, accountAddress(config.privateKeys.informedFlow));
  const intents: TxIntent[] = [];
  const cappedUninformedAmount = capToFlowBalance(uninformedTokenIn, uninformedAmount, uninformedBalances);
  if (cappedUninformedAmount > 0n) {
    intents.push({
      ownerId: "uninformed-flow",
      role: "uninformed-flow",
      privateKey: config.privateKeys.uninformedFlow,
      action: { type: "swap", tokenIn: uninformedTokenIn, amountIn: cappedUninformedAmount.toString(), slippageBps: FLOW_SLIPPAGE_BPS },
      priorityFeeWei: config.defaultPriorityFeeWei + BigInt(rng.int(1, 50)) * 1_000_000n
    });
  }
  const cappedInformedAmount = capToFlowBalance(informedTokenIn, informedAmount, informedBalances);
  if (cappedInformedAmount > 0n) {
    intents.push({
      ownerId: "informed-flow",
      role: "informed-flow",
      privateKey: config.privateKeys.informedFlow,
      action: { type: "swap", tokenIn: informedTokenIn, amountIn: cappedInformedAmount.toString(), slippageBps: FLOW_SLIPPAGE_BPS },
      priorityFeeWei: config.defaultPriorityFeeWei + BigInt(rng.int(50, 100)) * 1_000_000n
    });
  }
  return intents;
}

async function submitIntent(
  publicClient: ReturnType<typeof makeClients>["publicClient"],
  walletClient: ReturnType<typeof makeClients>["walletClient"],
  chain: ReturnType<typeof makeClients>["chain"],
  intent: TxIntent
): Promise<Hex> {
  const account = privateKeyToAccount(intent.privateKey);
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const data =
    intent.action.type === "swap"
      ? await buildSwapData(publicClient, account.address, intent.action, intent.action.slippageBps ?? 50)
      : await buildLpActionData(publicClient, account.address, intent.action, intent.action.type === "mintLiquidity" ? intent.action.slippageBps ?? 50 : 0);
  return walletClient.sendTransaction({
    account,
    chain,
    to: intent.action.type === "swap" ? ADDRESSES.swapRouter : ADDRESSES.nonfungiblePositionManager,
    data,
    maxFeePerGas: baseFee + intent.priorityFeeWei,
    maxPriorityFeePerGas: intent.priorityFeeWei
  });
}

async function logReceiptsAndOrdering(
  publicClient: ReturnType<typeof makeClients>["publicClient"],
  logger: RunLogger,
  round: number,
  submitted: SubmittedTx[]
): Promise<ReceiptResult[]> {
  const submittedByHash = new Map(submitted.map((tx) => [tx.hash.toLowerCase(), tx]));
  const receipts: Array<{ tx: SubmittedTx; receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>> }> = [];
  for (const tx of submitted) {
    try {
      receipts.push({ tx, receipt: await publicClient.waitForTransactionReceipt({ hash: tx.hash }) });
    } catch (error) {
      logger.event({ type: "tx_receipt_failed", round, hash: tx.hash, ownerId: tx.ownerId, role: tx.role, error: errorMessage(error) });
    }
  }
  const results: ReceiptResult[] = [];
  for (const { tx, receipt } of receipts) {
    const gasCostWei = receipt.gasUsed * receipt.effectiveGasPrice;
    results.push({ tx, status: receipt.status, gasUsed: receipt.gasUsed, gasCostWei });
    logger.event({
      type: "tx_receipt",
      round,
      hash: tx.hash,
      ownerId: tx.ownerId,
      role: tx.role,
      status: receipt.status,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      gasCostWei,
      actionType: tx.actionType,
      bundleId: tx.bundleId,
      bundleIndex: tx.bundleIndex
    });
  }
  const blockNumber = receipts[0]?.receipt.blockNumber;
  if (blockNumber === undefined) return results;
  const block = await publicClient.getBlock({ blockNumber, includeTransactions: true });
  for (let i = 0; i < block.transactions.length; i++) {
    const tx = block.transactions[i];
    if (typeof tx === "string") continue;
    const metadata = submittedByHash.get(tx.hash.toLowerCase());
    if (!metadata) continue;
    const receipt = receipts.find((item) => item.tx.hash === tx.hash)?.receipt;
    logger.blockRow({
      round,
      blockNumber,
      txIndex: i,
      hash: tx.hash,
      from: tx.from,
      priorityFeeWei: metadata.priorityFeeWei,
      status: receipt?.status ?? "unknown",
      ownerId: metadata.ownerId,
      role: metadata.role,
      actionType: metadata.actionType,
      bundleId: metadata.bundleId,
      bundleIndex: metadata.bundleIndex
    });
  }
  return results;
}

function randomBigInt(rng: Rng, minInclusive: bigint, maxInclusive: bigint): bigint {
  const span = maxInclusive - minInclusive + 1n;
  return minInclusive + (BigInt(Math.floor(rng.next() * 1_000_000)) * span) / 1_000_000n;
}

function capToFlowBalance(tokenIn: "WETH" | "USDC", desired: bigint, balances: BalanceSnapshot): bigint {
  const balance = tokenIn === "WETH" ? balances.wethWei : balances.usdcUnits;
  return desired > balance ? balance : desired;
}

function publicConfig(config: SimConfig) {
  return {
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    rounds: config.rounds,
    seed: config.seed,
    runDirRoot: config.runDirRoot,
    agentTimeoutMs: config.agentTimeoutMs
  };
}

function emptyAgentMetrics(): AgentMetrics {
  return {
    gasUsed: 0n,
    gasCostWei: 0n,
    revertCount: 0,
    submittedTxCount: 0,
    includedTxCount: 0
  };
}

function agentMetricsForSummary(metrics: AgentMetrics) {
  return {
    gasUsed: metrics.gasUsed.toString(),
    gasCostEth: formatEther(metrics.gasCostWei),
    revertCount: metrics.revertCount,
    submittedTxCount: metrics.submittedTxCount,
    includedTxCount: metrics.includedTxCount
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
