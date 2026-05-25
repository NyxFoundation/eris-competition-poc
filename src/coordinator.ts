import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  formatEther,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import {
  loadAgents,
  loadConfig,
  privateKeyForWalletName,
  type SimConfig,
} from "./config.js";
import { AgentProcess } from "./agentProcess.js";
import { validateAction } from "./action.js";
import {
  accountAddress,
  fundWallet,
  getBalances,
  makeClients,
  mine,
  resetFork,
  sendAndMine,
  setActiveStables,
  setEthBalance,
  snapshotForLog,
} from "./chain.js";
import { RunLogger, safeStringify } from "./logger.js";
import { balanceToInventory, valueUsdc } from "./pnl.js";
import { nextFairPrice, Rng } from "./rng.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  ProtocolId,
  ProtocolObservations,
  RawTxIntent,
  TxIntent,
  WalletRole,
} from "./types.js";
import { enabledAdapters, setEnabledProtocols } from "./protocols/registry.js";
import type { FlowKind, FlowWallet, SimContext } from "./protocols/types.js";
import { GMX_MARKETS } from "./constants.js";

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
  protocol?: ProtocolId;
  bundleId?: string;
  bundleIndex?: number;
};

type ReceiptResult = {
  tx: SubmittedTx;
  status: string;
  gasUsed: bigint;
  gasCostWei: bigint;
};

const GAS_ONLY_WEI = 2_000_000_000_000_000_000_000_000n; // 2,000,000 ETH（admin/keeper: gas + Balancer seed の wrap 等）

export async function runSimulation(): Promise<void> {
  const config = loadConfig();
  setEnabledProtocols(config.enabledProtocols);
  const adapters = enabledAdapters();
  const enabledIds = adapters.map((a) => a.id);
  // stable 統一会計: 有効 adapter が使う stable を残高合算対象に登録
  setActiveStables(
    adapters.map((a) => a.stableToken).filter((t): t is Address => Boolean(t)),
  );

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logger = new RunLogger(config.runDirRoot, runId);
  logger.event({
    type: "run_started",
    runId,
    config: publicConfig(config),
    enabledProtocols: enabledIds,
  });

  const { chain, publicClient, walletClient } = makeClients(
    config.rpcUrl,
    config.chainId,
  );
  await resetFork(publicClient);
  logger.event({ type: "fork_reset" });

  const agentSpecs = loadAgents(config.agentsConfigPath);
  const agentRuntimes: AgentRuntime[] = agentSpecs.map((spec) => {
    const privateKey = privateKeyForWalletName(config, spec.wallet, spec.id);
    return {
      id: spec.id,
      privateKey,
      process: new AgentProcess(
        spec,
        config.rpcUrl,
        accountAddress(privateKey),
      ),
      initial: { ethWei: 0n, wethWei: 0n, usdcUnits: 0n },
    };
  });
  const agentMetrics = new Map(
    agentRuntimes.map((agent) => [agent.id, emptyAgentMetrics()]),
  );

  // protocol/kind ごとの flow ウォレットを導出
  const flowWalletMap = new Map<string, FlowWallet>();
  for (const id of enabledIds) {
    for (const kind of ["informed", "uninformed"] as FlowKind[]) {
      const key = `${id}:${kind}`;
      const privateKey = keccak256(stringToBytes(`flow:${config.seed}:${key}`));
      flowWalletMap.set(key, {
        id: `flow-${key}`,
        address: accountAddress(privateKey),
        privateKey,
      });
    }
  }
  const flowPrivateKeys = new Map<string, Hex>(
    [...flowWalletMap.values()].map((w) => [w.id, w.privateKey]),
  );

  const adminPk = config.privateKeys.admin;
  const keeperPk = config.privateKeys.keeper;
  const rng = new Rng(config.seed);

  const ctx: SimContext = {
    publicClient,
    walletClient,
    chain,
    config,
    rng,
    adminPk,
    keeperPk,
    oracle: { aaveAggregators: {} },
    gmx: { market: GMX_MARKETS.ETH_USD },
    pendingGmxOrders: [],
    flowWallet(protocol: ProtocolId, kind: FlowKind): FlowWallet {
      const w = flowWalletMap.get(`${protocol}:${kind}`);
      if (!w) throw new Error(`flow wallet not found: ${protocol}:${kind}`);
      return w;
    },
  };

  try {
    // ---- admin / keeper にガス用 ETH（setupGlobal の seed/deploy より前）----
    await setEthBalance(publicClient, accountAddress(adminPk), GAS_ONLY_WEI);
    await setEthBalance(publicClient, accountAddress(keeperPk), GAS_ONLY_WEI);

    // ---- グローバル setup（mock deploy / role 付与 / oracle source 差替 / liquidity seed）----
    for (const adapter of adapters) {
      if (adapter.setupGlobal) {
        logger.event({ type: "protocol_setup_started", protocol: adapter.id });
        await adapter.setupGlobal(ctx);
        logger.event({
          type: "protocol_setup_completed",
          protocol: adapter.id,
        });
      }
    }

    // ---- 全ウォレットの資金調達 + approve ----
    const fundTargets: Array<{
      id: string;
      role: WalletRole;
      privateKey: Hex;
    }> = [
      ...agentRuntimes.map((a) => ({
        id: a.id,
        role: "agent" as WalletRole,
        privateKey: a.privateKey,
      })),
      ...[...flowWalletMap.entries()].map(([key, w]) => ({
        id: w.id,
        role: (key.endsWith("informed") && !key.endsWith("uninformed")
          ? "informed-flow"
          : "uninformed-flow") as WalletRole,
        privateKey: w.privateKey,
      })),
    ];
    for (const target of fundTargets) {
      logger.event({
        type: "wallet_setup_started",
        id: target.id,
        role: target.role,
        address: accountAddress(target.privateKey),
      });
      await fundWallet(
        publicClient,
        walletClient,
        chain,
        target.privateKey,
        config.initialEthWei,
        config.initialWethWei,
        config.initialUsdcUnits,
      );
      for (const adapter of adapters) {
        if (!adapter.setupWallet) continue;
        const approvals = await adapter.setupWallet(
          ctx,
          accountAddress(target.privateKey),
        );
        for (const tx of approvals) {
          await sendAndMine(
            publicClient,
            walletClient,
            chain,
            target.privateKey,
            { to: tx.to, data: tx.data, value: tx.value },
          );
        }
      }
      logger.event({
        type: "wallet_setup_completed",
        id: target.id,
        balances: snapshotForLog(
          await getBalances(publicClient, accountAddress(target.privateKey)),
        ),
      });
    }

    let fairPrice = await initialFairPrice(ctx, enabledIds);
    const history: AgentObservation["history"] = [];
    for (const agent of agentRuntimes) {
      agent.initial = await getBalances(
        publicClient,
        accountAddress(agent.privateKey),
      );
    }

    for (let round = 1; round <= config.rounds; round++) {
      fairPrice = nextFairPrice(fairPrice, rng);

      // ---- 1) Oracle ブロック（GMX/Aave の mock 価格更新）----
      let oracleWrote = false;
      for (const adapter of adapters) {
        // updateOracles 相当は各 adapter の setupGlobal で確立した handle を使う oracles.ts に集約予定。
        // Phase 1（uniswap のみ）では何もしない。
        void adapter;
      }
      oracleWrote = await updateOracles(ctx, fairPrice);
      if (oracleWrote) await mine(publicClient);

      // ---- 2) 競争ブロック ----
      const stateById = new Map<ProtocolId, unknown>();
      for (const adapter of adapters)
        stateById.set(adapter.id, await adapter.readState(ctx, fairPrice));

      const poolPrice = uniswapPoolPrice(stateById) ?? fairPrice;
      history.push({
        round,
        poolPriceUsdcPerWeth: poolPrice,
        fairPriceUsdcPerWeth: fairPrice,
      });

      const block = await publicClient.getBlock();
      const agentIntents: TxIntent[] = [];
      const rawTxIntents: RawTxIntent[] = [];

      for (const agent of agentRuntimes) {
        const address = accountAddress(agent.privateKey);
        const balances = await getBalances(publicClient, address);
        const observation = await observationFor(
          ctx,
          adapters,
          stateById,
          runId,
          round,
          block.number,
          address,
          fairPrice,
          balances,
          history,
          config,
          enabledIds,
        );
        logger.event({ type: "observation", agentId: agent.id, observation });
        const action = await agent.process.requestAction(
          observation,
          config.agentTimeoutMs,
        );
        const validated = validateAction(action, observation, balances);
        if (!validated.ok) {
          logger.event({
            type: "action_rejected",
            agentId: agent.id,
            action,
            reason: validated.reason,
          });
          continue;
        }
        logger.event({
          type: "action_accepted",
          agentId: agent.id,
          action: validated.action,
          intents: validated.intents,
          rawIntents: validated.rawIntents,
        });
        for (const intent of validated.intents) {
          agentIntents.push({
            ownerId: agent.id,
            role: "agent",
            privateKey: agent.privateKey,
            protocol: intent.protocol,
            action: intent.action,
            priorityFeeWei: intent.priorityFeeWei,
            bundleId: intent.bundleId,
            bundleIndex: intent.bundleIndex,
            gmxOrder: intent.protocol === "gmx",
          });
        }
        for (const rawIntent of validated.rawIntents) {
          rawTxIntents.push({
            ownerId: agent.id,
            role: "agent",
            privateKey: agent.privateKey,
            rawTx: rawIntent.tx,
            priorityFeeWei: rawIntent.priorityFeeWei,
            bundleId: rawIntent.bundleId,
            bundleIndex: rawIntent.bundleIndex,
          });
        }
      }

      const flowIntents = await buildFlowIntents(
        ctx,
        adapters,
        stateById,
        fairPrice,
      );

      const submitted: SubmittedTx[] = [];
      for (const intent of [...flowIntents, ...agentIntents]) {
        try {
          const hashes = await submitIntent(ctx, intent, stateById);
          for (const hash of hashes) {
            submitted.push({
              hash,
              ownerId: intent.ownerId,
              role: intent.role,
              priorityFeeWei: intent.priorityFeeWei,
              actionType: intent.action.type,
              protocol: intent.protocol,
              bundleId: intent.bundleId,
              bundleIndex: intent.bundleIndex,
            });
            if (intent.role === "agent")
              agentMetrics.get(intent.ownerId)!.submittedTxCount++;
            logger.event({
              type: "tx_submitted",
              round,
              hash,
              ownerId: intent.ownerId,
              role: intent.role,
              priorityFeeWei: intent.priorityFeeWei,
              actionType: intent.action.type,
              protocol: intent.protocol,
              bundleId: intent.bundleId,
              bundleIndex: intent.bundleIndex,
            });
          }
        } catch (error) {
          logger.event({
            type: "tx_submit_failed",
            round,
            ownerId: intent.ownerId,
            role: intent.role,
            priorityFeeWei: intent.priorityFeeWei,
            actionType: intent.action.type,
            protocol: intent.protocol,
            bundleId: intent.bundleId,
            bundleIndex: intent.bundleIndex,
            error: errorMessage(error),
          });
        }
      }

      for (const intent of rawTxIntents) {
        try {
          const hash = await submitRawTxIntent(ctx, intent);
          submitted.push({
            hash,
            ownerId: intent.ownerId,
            role: intent.role,
            priorityFeeWei: intent.priorityFeeWei,
            actionType: "rawTx",
            bundleId: intent.bundleId,
            bundleIndex: intent.bundleIndex,
          });
          agentMetrics.get(intent.ownerId)!.submittedTxCount++;
          logger.event({
            type: "tx_submitted",
            round,
            hash,
            ownerId: intent.ownerId,
            role: intent.role,
            priorityFeeWei: intent.priorityFeeWei,
            actionType: "rawTx",
            targetAddress: intent.rawTx.to,
            dataLength: intent.rawTx.data.length,
            bundleId: intent.bundleId,
            bundleIndex: intent.bundleIndex,
          });
        } catch (error) {
          logger.event({
            type: "tx_submit_failed",
            round,
            ownerId: intent.ownerId,
            role: intent.role,
            priorityFeeWei: intent.priorityFeeWei,
            actionType: "rawTx",
            bundleId: intent.bundleId,
            bundleIndex: intent.bundleIndex,
            error: errorMessage(error),
          });
        }
      }

      await mine(publicClient);
      const receiptResults = await logReceiptsAndOrdering(
        publicClient,
        logger,
        round,
        submitted,
      );
      for (const result of receiptResults) {
        if (result.tx.role !== "agent") continue;
        const metrics = agentMetrics.get(result.tx.ownerId)!;
        metrics.gasUsed += result.gasUsed;
        metrics.gasCostWei += result.gasCostWei;
        metrics.includedTxCount++;
        if (result.status !== "success") metrics.revertCount++;
      }

      // ---- 3) Keeper ブロック（GMX 注文の実行など）----
      for (const adapter of adapters) {
        if (adapter.afterMine) await adapter.afterMine(ctx);
      }
    }

    const finalFairPrice = history.at(-1)?.fairPriceUsdcPerWeth ?? fairPrice;
    const agents = [];
    for (const agent of agentRuntimes) {
      const address = accountAddress(agent.privateKey);
      const final = await getBalances(publicClient, address);
      const initialValue = valueUsdc(agent.initial, finalFairPrice);
      let finalValue = valueUsdc(final, finalFairPrice);
      const protocolValues: Record<string, number> = {};
      for (const adapter of adapters) {
        const v = await adapter.valueUsdc(ctx, address, null, finalFairPrice);
        protocolValues[adapter.id] = v;
        finalValue += v;
      }
      agents.push({
        id: agent.id,
        address,
        initial: snapshotForLog(agent.initial),
        final: snapshotForLog(final),
        protocolValuesUsdc: protocolValues,
        initialValueUsdc: initialValue,
        finalValueUsdc: finalValue,
        netPnlUsdc: finalValue - initialValue,
        ...agentMetricsForSummary(agentMetrics.get(agent.id)!),
        stderrTail: agent.process.getStderr(),
      });
    }
    logger.summary({
      runId,
      rounds: config.rounds,
      enabledProtocols: enabledIds,
      finalFairPriceUsdcPerWeth: finalFairPrice,
      agents,
    });
    writeFileSync(
      join(logger.runDir, "history.json"),
      `${safeStringify(history, 2)}\n`,
    );
    logger.event({ type: "run_completed", runId, runDir: logger.runDir });
    console.log(`simulation completed: ${logger.runDir}`);
  } finally {
    for (const agent of agentRuntimes) agent.process.close();
    void flowPrivateKeys;
  }
}

// ---------------------------------------------------------------------------
// 観測 / flow / submit
// ---------------------------------------------------------------------------

async function observationFor(
  ctx: SimContext,
  adapters: ReturnType<typeof enabledAdapters>,
  stateById: Map<ProtocolId, unknown>,
  runId: string,
  round: number,
  blockNumber: bigint,
  agentAddress: Address,
  fairPrice: number,
  balances: BalanceSnapshot,
  history: AgentObservation["history"],
  config: SimConfig,
  enabledIds: ProtocolId[],
): Promise<AgentObservation> {
  const protocols: ProtocolObservations = {};
  for (const adapter of adapters) {
    const obs = await adapter.observe(
      ctx,
      stateById.get(adapter.id),
      agentAddress,
      fairPrice,
    );
    (protocols as Record<string, unknown>)[adapter.id] = obs;
  }
  return {
    kind: "observation",
    runId,
    round,
    blockNumber: blockNumber.toString(),
    agentAddress,
    fairPriceUsdcPerWeth: fairPrice,
    oraclePrices: { wethUsd: fairPrice, usdcUsd: 1 },
    enabledProtocols: enabledIds,
    balances: {
      ethWei: balances.ethWei.toString(),
      wethWei: balances.wethWei.toString(),
      usdcUnits: balances.usdcUnits.toString(),
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
      maxOpenPositions: config.maxOpenPositions,
      maxGmxSizeUsd: config.maxGmxSizeUsd.toString(),
      maxAaveSupplyWethWei: config.maxAaveSupplyWethWei.toString(),
      maxAaveBorrowUsdcUnits: config.maxAaveBorrowUsdcUnits.toString(),
    },
    protocols,
  };
}

async function buildFlowIntents(
  ctx: SimContext,
  adapters: ReturnType<typeof enabledAdapters>,
  stateById: Map<ProtocolId, unknown>,
  fairPrice: number,
): Promise<TxIntent[]> {
  const intents: TxIntent[] = [];
  for (const adapter of adapters) {
    const orders = await adapter.buildFlow(
      ctx,
      stateById.get(adapter.id),
      fairPrice,
    );
    for (const order of orders) {
      const wallet = ctx.flowWallet(adapter.id, order.kind);
      intents.push({
        ownerId: wallet.id,
        role: order.kind === "informed" ? "informed-flow" : "uninformed-flow",
        privateKey: wallet.privateKey,
        protocol: adapter.id,
        action: order.action,
        priorityFeeWei: order.priorityFeeWei,
        gmxOrder: adapter.id === "gmx",
      });
    }
  }
  return intents;
}

async function submitIntent(
  ctx: SimContext,
  intent: TxIntent,
  stateById: Map<ProtocolId, unknown>,
): Promise<Hex[]> {
  const adapter = enabledAdapters().find((a) => a.id === intent.protocol);
  if (!adapter) throw new Error(`adapter not enabled: ${intent.protocol}`);
  const owner = accountAddress(intent.privateKey);
  const txs = await adapter.buildTxs(
    ctx,
    owner,
    intent.action,
    stateById.get(intent.protocol),
  );
  const account = privateKeyToAccount(intent.privateKey);
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hashes: Hex[] = [];
  for (const tx of txs) {
    const hash = await ctx.walletClient.sendTransaction({
      account,
      chain: ctx.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
      maxFeePerGas: baseFee + intent.priorityFeeWei,
      maxPriorityFeePerGas: intent.priorityFeeWei,
    });
    hashes.push(hash);
  }
  return hashes;
}

async function submitRawTxIntent(
  ctx: SimContext,
  intent: RawTxIntent,
): Promise<Hex> {
  const account = privateKeyToAccount(intent.privateKey);
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  return ctx.walletClient.sendTransaction({
    account,
    chain: ctx.chain,
    to: intent.rawTx.to as Address,
    data: intent.rawTx.data as Hex,
    value: intent.rawTx.value ? BigInt(intent.rawTx.value) : 0n,
    maxFeePerGas: baseFee + intent.priorityFeeWei,
    maxPriorityFeePerGas: intent.priorityFeeWei,
  });
}

// updateOracles：GMX/Aave の handle がある場合のみ価格更新。Phase 1 では何もしない。
async function updateOracles(
  ctx: SimContext,
  fairPrice: number,
): Promise<boolean> {
  void fairPrice;
  if (
    !ctx.oracle.gmxProvider &&
    Object.keys(ctx.oracle.aaveAggregators).length === 0
  )
    return false;
  // Phase 4/5 で oracles.ts に実装を集約する。
  return false;
}

async function initialFairPrice(
  ctx: SimContext,
  enabledIds: ProtocolId[],
): Promise<number> {
  if (enabledIds.includes("uniswap")) {
    const { getPoolPriceUsdcPerWeth } = await import("./protocols/uniswap.js");
    return getPoolPriceUsdcPerWeth(ctx.publicClient);
  }
  return 3000;
}

function uniswapPoolPrice(
  stateById: Map<ProtocolId, unknown>,
): number | undefined {
  const s = stateById.get("uniswap") as
    | { priceUsdcPerWeth: number }
    | undefined;
  return s?.priceUsdcPerWeth;
}

// ---------------------------------------------------------------------------
// receipts / ordering
// ---------------------------------------------------------------------------

async function logReceiptsAndOrdering(
  publicClient: SimContext["publicClient"],
  logger: RunLogger,
  round: number,
  submitted: SubmittedTx[],
): Promise<ReceiptResult[]> {
  const submittedByHash = new Map(
    submitted.map((tx) => [tx.hash.toLowerCase(), tx]),
  );
  const receipts: Array<{
    tx: SubmittedTx;
    receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;
  }> = [];
  for (const tx of submitted) {
    try {
      receipts.push({
        tx,
        receipt: await publicClient.waitForTransactionReceipt({
          hash: tx.hash,
        }),
      });
    } catch (error) {
      logger.event({
        type: "tx_receipt_failed",
        round,
        hash: tx.hash,
        ownerId: tx.ownerId,
        role: tx.role,
        error: errorMessage(error),
      });
    }
  }
  const results: ReceiptResult[] = [];
  for (const { tx, receipt } of receipts) {
    const gasCostWei = receipt.gasUsed * receipt.effectiveGasPrice;
    results.push({
      tx,
      status: receipt.status,
      gasUsed: receipt.gasUsed,
      gasCostWei,
    });
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
      protocol: tx.protocol,
      bundleId: tx.bundleId,
      bundleIndex: tx.bundleIndex,
    });
  }
  const blockNumber = receipts[0]?.receipt.blockNumber;
  if (blockNumber === undefined) return results;
  const block = await publicClient.getBlock({
    blockNumber,
    includeTransactions: true,
  });
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
      bundleIndex: metadata.bundleIndex,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function publicConfig(config: SimConfig) {
  return {
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    rounds: config.rounds,
    seed: config.seed,
    runDirRoot: config.runDirRoot,
    agentTimeoutMs: config.agentTimeoutMs,
  };
}

function emptyAgentMetrics(): AgentMetrics {
  return {
    gasUsed: 0n,
    gasCostWei: 0n,
    revertCount: 0,
    submittedTxCount: 0,
    includedTxCount: 0,
  };
}

function agentMetricsForSummary(metrics: AgentMetrics) {
  return {
    gasUsed: metrics.gasUsed.toString(),
    gasCostEth: formatEther(metrics.gasCostWei),
    revertCount: metrics.revertCount,
    submittedTxCount: metrics.submittedTxCount,
    includedTxCount: metrics.includedTxCount,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
