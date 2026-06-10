import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { loadAgents, loadConfig, privateKeyForWalletName } from "../config.js";
import { validateAction } from "../action.js";
import {
  accountAddress,
  fundWallet,
  getBalances,
  makeClients,
  resetFork,
  sendAndMine,
  setActiveStables,
  setEthBalance,
  setIntervalMining,
} from "../chain.js";
import { RunLogger } from "../logger.js";
import { valueUsdc } from "../pnl.js";
import { nextFairPrice, Rng } from "../rng.js";
import type {
  AgentAction,
  AgentObservation,
  BalanceSnapshot,
  ProtocolId,
  TxIntent,
  WalletRole,
} from "../types.js";
import { enabledAdapters, setEnabledProtocols } from "../protocols/registry.js";
import type { FlowKind, FlowWallet, SimContext } from "../protocols/types.js";
import { updateOraclesMempool } from "../protocols/oracles.js";
import { GMX_MARKETS } from "../constants.js";
import {
  buildFlowContext,
  flowOrdersToIntents,
  initialFairPrice,
  observationFor,
  submitIntent,
  submitRawTxIntent,
} from "../coordinator.js";
import type { FlowOrderWire } from "../flowProcess.js";
import { RealtimeAgentProcess } from "./agentProcess.js";
import { RealtimeFlowProcess } from "./flowProcess.js";

const GAS_ONLY_WEI = 2_000_000_000_000_000_000_000_000n; // 2,000,000 ETH（admin/keeper のガス）

type RealtimeAgentRuntime = {
  id: string;
  privateKey: Hex;
  address: Address;
  process: RealtimeAgentProcess;
  initial: BalanceSnapshot;
  submitted: number;
  included: number; // ブロックに取り込まれた tx 数（evaluate/discrimination の集計が読む）
  reverted: number; // うち revert した tx 数
  lastObservation: AgentObservation | null;
  lastBalances: BalanceSnapshot | null;
};

type SubmittedMeta = {
  ownerId: string;
  role: WalletRole | "system";
  priorityFeeWei: bigint;
  actionType: string;
};

// 実時間モードのオーケストレータ。
// setup（fork/資金/approve）は no-mining + sendAndMine で高速フラッシュ → 競争フェーズ開始時に
// setIntervalMining(blockTimeSec) で実 N 秒ごとの自動 mine へ切り替える。以後は newHeads を購読し、
// ブロック毎に observation を全 agent へ push、agent から非同期に届く action を即 mempool へ relay する
// （--order fees が次ブロックで fee 降順整列）。決定論は持たない。
// 注: 薄い縦切りのため uniswap-only 前提（oracle 更新を伴う aave/gmx は Phase 2 で対応）。flow bot は未接続。
export async function runRealtimeSimulation(): Promise<void> {
  const config = loadConfig();
  setEnabledProtocols(config.enabledProtocols);
  const adapters = enabledAdapters();
  const enabledIds = adapters.map((a) => a.id);
  setActiveStables(
    adapters.map((a) => a.stableToken).filter((t): t is Address => Boolean(t)),
  );

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logger = new RunLogger(config.runDirRoot, runId);
  logger.event({
    type: "run_started_realtime",
    runId,
    enabledProtocols: enabledIds,
    blockTimeSec: config.blockTimeSec,
    runSeconds: config.runSeconds,
    runBlocks: config.runBlocks,
  });

  const { chain, publicClient, walletClient } = makeClients(
    config.rpcUrl,
    config.chainId,
  );
  await resetFork(publicClient, {
    forkUrl: config.forkUrl,
    forkBlockNumber: config.forkBlockNumber,
  });

  // ---- agent プロセス（realtime）----
  const agentSpecs = loadAgents(config.agentsConfigPath);
  const agentRuntimes: RealtimeAgentRuntime[] = agentSpecs.map((spec) => {
    const privateKey = privateKeyForWalletName(config, spec.wallet, spec.id);
    const address = accountAddress(privateKey);
    return {
      id: spec.id,
      privateKey,
      address,
      process: new RealtimeAgentProcess(
        spec,
        config.rpcUrl,
        address,
        logger.runDir,
      ),
      initial: { ethWei: 0n, wethWei: 0n, usdcUnits: 0n },
      submitted: 0,
      included: 0,
      reverted: 0,
      lastObservation: null,
      lastBalances: null,
    };
  });
  const agentById = new Map(agentRuntimes.map((a) => [a.id, a]));

  // ---- flow-bot プロセス（realtime）。毎ブロック context を push し market を動かす ----
  const flowProcess = new RealtimeFlowProcess(
    config.flowBotCommand,
    config.flowBotArgs,
    config.flowSeed,
    logger.runDir,
  );

  // ---- flow ウォレット（protocol/kind ごと。submitIntent / ctx が選択に使う）----
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

  // 提出した tx の hash → メタ（block ログで owner/fee を引くため）
  const submittedByHash = new Map<string, SubmittedMeta>();
  // 実時間の共有最新状態（非同期 action ハンドラが参照する）
  let latestStateById = new Map<ProtocolId, unknown>();
  let latestFairPrice = 0;
  const latestHistory: AgentObservation["history"] = [];

  try {
    // ---- setup（高速フラッシュ：no-mining + sendAndMine）----
    await setEthBalance(publicClient, accountAddress(adminPk), GAS_ONLY_WEI);
    await setEthBalance(publicClient, accountAddress(keeperPk), GAS_ONLY_WEI);
    for (const adapter of adapters) {
      if (adapter.setupGlobal) await adapter.setupGlobal(ctx);
    }
    const fundTargets: Array<{ role: WalletRole; privateKey: Hex }> = [
      ...agentRuntimes.map((a) => ({
        role: "agent" as WalletRole,
        privateKey: a.privateKey,
      })),
      ...[...flowWalletMap.entries()].map(([key, w]) => ({
        role: (key.endsWith("informed") && !key.endsWith("uninformed")
          ? "informed-flow"
          : "uninformed-flow") as WalletRole,
        privateKey: w.privateKey,
      })),
    ];
    for (const t of fundTargets) {
      await fundWallet(
        publicClient,
        walletClient,
        chain,
        t.privateKey,
        config.initialEthWei,
        config.initialWethWei,
        config.initialUsdcUnits,
      );
      for (const adapter of adapters) {
        if (!adapter.setupWallet) continue;
        const approvals = await adapter.setupWallet(
          ctx,
          accountAddress(t.privateKey),
        );
        for (const tx of approvals) {
          await sendAndMine(publicClient, walletClient, chain, t.privateKey, {
            to: tx.to,
            data: tx.data,
            value: tx.value,
          });
        }
      }
    }

    latestFairPrice = await initialFairPrice(ctx, enabledIds);
    for (const agent of agentRuntimes) {
      agent.initial = await getBalances(publicClient, agent.address);
    }

    // ---- 非同期 action ハンドラ：届いた action を即 mempool へ relay ----
    const handleAgentAction = async (
      agent: RealtimeAgentRuntime,
      action: AgentAction,
    ): Promise<void> => {
      if (action.type === "noop") return;
      const obs = agent.lastObservation;
      const balances = agent.lastBalances;
      if (!obs || !balances) return;
      const validated = validateAction(action, obs, balances);
      if (!validated.ok) {
        logger.event({
          type: "action_rejected",
          agentId: agent.id,
          action,
          reason: validated.reason,
        });
        return;
      }
      for (const intent of validated.intents) {
        const txIntent: TxIntent = {
          ownerId: agent.id,
          role: "agent",
          privateKey: agent.privateKey,
          protocol: intent.protocol,
          action: intent.action,
          priorityFeeWei: intent.priorityFeeWei,
          bundleId: intent.bundleId,
          bundleIndex: intent.bundleIndex,
          gmxOrder: intent.protocol === "gmx",
        };
        try {
          const hashes = await submitIntent(ctx, txIntent, latestStateById);
          for (const hash of hashes) {
            submittedByHash.set(hash.toLowerCase(), {
              ownerId: agent.id,
              role: "agent",
              priorityFeeWei: intent.priorityFeeWei,
              actionType: intent.action.type,
            });
            agent.submitted++;
            logger.event({
              type: "tx_submitted",
              hash,
              ownerId: agent.id,
              priorityFeeWei: intent.priorityFeeWei,
              actionType: intent.action.type,
              protocol: intent.protocol,
            });
          }
        } catch (error) {
          logger.event({
            type: "tx_submit_failed",
            ownerId: agent.id,
            actionType: intent.action.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      for (const rawIntent of validated.rawIntents) {
        try {
          const hash = await submitRawTxIntent(ctx, {
            ownerId: agent.id,
            role: "agent",
            privateKey: agent.privateKey,
            rawTx: rawIntent.tx,
            priorityFeeWei: rawIntent.priorityFeeWei,
            bundleId: rawIntent.bundleId,
            bundleIndex: rawIntent.bundleIndex,
          });
          submittedByHash.set(hash.toLowerCase(), {
            ownerId: agent.id,
            role: "agent",
            priorityFeeWei: rawIntent.priorityFeeWei,
            actionType: "rawTx",
          });
          agent.submitted++;
        } catch (error) {
          logger.event({
            type: "tx_submit_failed",
            ownerId: agent.id,
            actionType: "rawTx",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    for (const agent of agentRuntimes) {
      agent.process.onAction((action) => void handleAgentAction(agent, action));
    }

    // ---- flow order ハンドラ：bot の注文を flow ウォレットで mempool へ relay ----
    const handleFlowOrders = async (orders: FlowOrderWire[]): Promise<void> => {
      const intents = flowOrdersToIntents(ctx, orders);
      for (const intent of intents) {
        try {
          const hashes = await submitIntent(ctx, intent, latestStateById);
          for (const hash of hashes) {
            submittedByHash.set(hash.toLowerCase(), {
              ownerId: intent.ownerId,
              role: intent.role,
              priorityFeeWei: intent.priorityFeeWei,
              actionType: intent.action.type,
            });
            logger.event({
              type: "tx_submitted",
              hash,
              ownerId: intent.ownerId,
              role: intent.role,
              priorityFeeWei: intent.priorityFeeWei,
              actionType: intent.action.type,
              protocol: intent.protocol,
            });
          }
        } catch (error) {
          logger.event({
            type: "tx_submit_failed",
            ownerId: intent.ownerId,
            actionType: intent.action.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    flowProcess.onOrders((orders) => void handleFlowOrders(orders));

    // ---- mined block の tx を blocks.csv へ（txIndex は実ブロック内位置）----
    const logBlock = async (b: number): Promise<void> => {
      const block = await publicClient.getBlock({
        blockNumber: BigInt(b),
        includeTransactions: true,
      });
      for (const tx of block.transactions) {
        if (typeof tx === "string") continue;
        const meta = submittedByHash.get(tx.hash.toLowerCase());
        if (!meta) continue;
        let status = "mined";
        try {
          const receipt = await publicClient.getTransactionReceipt({
            hash: tx.hash,
          });
          status = receipt.status;
        } catch {
          // receipt 取得失敗時は "mined" のまま
        }
        if (meta.role === "agent") {
          const runtime = agentById.get(meta.ownerId);
          if (runtime) {
            runtime.included++;
            if (status !== "success") runtime.reverted++;
          }
        }
        logger.blockRow({
          round: b,
          blockNumber: BigInt(b),
          txIndex: tx.transactionIndex,
          hash: tx.hash,
          from: tx.from,
          priorityFeeWei: meta.priorityFeeWei,
          status,
          ownerId: meta.ownerId,
          role: meta.role,
          actionType: meta.actionType,
        });
      }
    };

    // oracle 更新の fee は agent 上限超にして --order fees で txIndex 0 付近に置く。
    const oracleFee = config.maxPriorityFeeWei + 1_000_000_000n;

    // ---- 競争フェーズ開始：実 N 秒ごとの interval mining へ ----
    await setIntervalMining(publicClient, config.blockTimeSec);
    logger.event({
      type: "interval_mining_started",
      blockTimeSec: config.blockTimeSec,
    });
    const startTime = Date.now();
    let processedBlocks = 0;
    let processing = false;
    let lastLoggedBlock = Number(await publicClient.getBlockNumber());

    await new Promise<void>((resolve) => {
      let finished = false;
      let unwatch: () => void = () => {};
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        unwatch();
        resolve();
      };
      const timer =
        config.runSeconds > 0
          ? setTimeout(finish, config.runSeconds * 1000)
          : undefined;

      const onBlock = async (bn: number): Promise<void> => {
        if (processing || finished) return;
        processing = true;
        try {
          // 新規に mine されたブロックの tx をログし、keeper（GMX 注文実行等）を回す
          for (let b = lastLoggedBlock + 1; b <= bn; b++) {
            await logBlock(b);
            for (const adapter of adapters) {
              if (!adapter.afterMine) continue;
              try {
                await adapter.afterMine(ctx, {
                  noMine: true,
                  priorityFeeWei: oracleFee,
                  blockNumber: BigInt(b),
                });
              } catch (error) {
                logger.event({
                  type: "keeper_failed",
                  protocol: adapter.id,
                  blockNumber: b,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
          lastLoggedBlock = Math.max(lastLoggedBlock, bn);

          // 市場を1ステップ進めて state を読み直し、observation を全 agent へ push
          latestFairPrice = nextFairPrice(latestFairPrice, rng);

          // oracle を mempool 更新（aave/gmx。uniswap-only では no-op）。次ブロックに fee 先頭で載る。
          try {
            const oracleHashes = await updateOraclesMempool(
              ctx,
              latestFairPrice,
              oracleFee,
            );
            for (const hash of oracleHashes) {
              submittedByHash.set(hash.toLowerCase(), {
                ownerId: "oracle",
                role: "system",
                priorityFeeWei: oracleFee,
                actionType: "oracleUpdate",
              });
            }
          } catch (error) {
            logger.event({
              type: "oracle_update_failed",
              error: error instanceof Error ? error.message : String(error),
            });
          }
          const stateById = new Map<ProtocolId, unknown>();
          for (const adapter of adapters)
            stateById.set(
              adapter.id,
              await adapter.readState(ctx, latestFairPrice),
            );
          latestStateById = stateById;
          const uni = stateById.get("uniswap") as
            | { priceUsdcPerWeth?: number }
            | undefined;
          latestHistory.push({
            round: bn,
            poolPriceUsdcPerWeth: uni?.priceUsdcPerWeth ?? latestFairPrice,
            fairPriceUsdcPerWeth: latestFairPrice,
          });

          for (const agent of agentRuntimes) {
            if (!agent.process.isAlive()) continue;
            const balances = await getBalances(publicClient, agent.address);
            agent.lastBalances = balances;
            const obs = await observationFor(
              ctx,
              adapters,
              latestStateById,
              runId,
              bn,
              BigInt(bn),
              agent.address,
              latestFairPrice,
              balances,
              latestHistory.slice(-20),
              config,
              enabledIds,
            );
            agent.lastObservation = obs;
            // per-block 価値系列を events.jsonl に残す（evaluate/discrimination の
            // Sharpe / information ratio が readPerRoundValues で再構成する。ADR 0005）。
            logger.event({
              type: "observation",
              agentId: agent.id,
              observation: obs,
            });
            agent.process.pushObservation(obs);
          }

          // flow-bot に context を push（market を動かして arb 機会を作る）
          if (flowProcess.isAlive()) {
            const flowContext = await buildFlowContext(
              ctx,
              enabledIds,
              latestStateById,
              latestFairPrice,
              bn,
            );
            flowProcess.pushContext(flowContext);
          }

          processedBlocks++;
          if (config.runBlocks > 0 && processedBlocks >= config.runBlocks)
            finish();
        } catch (error) {
          logger.event({
            type: "realtime_block_error",
            blockNumber: bn,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          processing = false;
        }
      };

      unwatch = publicClient.watchBlockNumber({
        emitOnBegin: true,
        pollingInterval: Math.max(
          100,
          Math.floor((config.blockTimeSec * 1000) / 4),
        ),
        onBlockNumber: (bn) => void onBlock(Number(bn)),
      });
    });

    const elapsedMs = Date.now() - startTime;

    // ---- 最終 PnL ----
    const finalFairPrice = latestFairPrice;
    const agentsSummary = [];
    for (const agent of agentRuntimes) {
      const final = await getBalances(publicClient, agent.address);
      const initialValue = valueUsdc(agent.initial, finalFairPrice);
      let finalValue = valueUsdc(final, finalFairPrice);
      const protocolValues: Record<string, number> = {};
      for (const adapter of adapters) {
        const v = await adapter.valueUsdc(
          ctx,
          agent.address,
          null,
          finalFairPrice,
        );
        protocolValues[adapter.id] = v;
        finalValue += v;
      }
      agentsSummary.push({
        id: agent.id,
        address: agent.address,
        initialValueUsdc: initialValue,
        finalValueUsdc: finalValue,
        netPnlUsdc: finalValue - initialValue,
        submittedTxCount: agent.submitted,
        includedTxCount: agent.included,
        revertCount: agent.reverted,
        stderrTail: agent.process.getStderr(),
      });
    }
    logger.summary({
      runId,
      mode: "realtime",
      blockTimeSec: config.blockTimeSec,
      blocksProcessed: processedBlocks,
      elapsedMs,
      finalFairPriceUsdcPerWeth: finalFairPrice,
      agents: agentsSummary,
    });
    logger.event({ type: "run_completed", runId, runDir: logger.runDir });
    console.error(
      `realtime simulation completed: ${logger.runDir} (${processedBlocks} blocks, ${Math.round(elapsedMs / 1000)}s)`,
    );
  } finally {
    try {
      await setIntervalMining(publicClient, 0);
    } catch {
      // teardown 中のエラーは無視
    }
    for (const agent of agentRuntimes) agent.process.close();
    flowProcess.close();
  }
}
