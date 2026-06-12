import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { loadAgents, loadConfig, privateKeyForWalletName } from "../config.js";
import { validateAction } from "../action.js";
import {
  accountAddress,
  activeStables,
  fundWallet,
  getBalances,
  makeClients,
  resetFork,
  sendAndMine,
  setEthBalance,
  setIntervalMining,
} from "../chain.js";
import { RunLogger } from "../logger.js";
import { valueUsdc } from "../pnl.js";
import { checkRunFeeViolations } from "../postRunCheck.js";
import { nextFairPrice, Rng } from "../rng.js";
import type {
  AgentAction,
  AgentObservation,
  AgentSpec,
  BalanceSnapshot,
  ProtocolId,
  TxIntent,
  WalletRole,
} from "../types.js";
import { initProtocols } from "../protocols/registry.js";
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
import { deployPriceFeed, updatePriceFeedMempool } from "./priceFeed.js";
import { reconstructValueSeries } from "./reconstruct.js";

const GAS_ONLY_WEI = 2_000_000_000_000_000_000_000_000n; // 2,000,000 ETH（admin/keeper のガス）

// flowWalletMap のキー（`${protocol}:${kind}`）から WalletRole を引く。
function flowRole(key: string): WalletRole {
  return key.endsWith(":informed") ? "informed-flow" : "uninformed-flow";
}

type RealtimeAgentRuntime = {
  id: string;
  spec: AgentSpec;
  privateKey: Hex;
  address: Address;
  process: RealtimeAgentProcess | null; // setup 完了後に spawn する
  initial: BalanceSnapshot;
  submitted: number; // relay モードのみ計数（direct では agent が自己申告ログに残す）
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

// 実時間モードのオーケストレータ（ADR 0006 で「環境デーモン + 採点者」へ縮小）。
//
// 環境はチェーンへの書き込みだけで世界を動かす:
//   anvil ライフサイクル / fair price 生成 → PriceFeed・oracle 更新 tx / flow 注文 / GMX keeper。
// agent はチェーンの読み書きだけで知覚・行動する（direct モード = 既定。ERIS_AGENT_DIRECT_TX=0 で
// 旧 relay 方式へロールバック）。ブロック内順序は anvil --order fees が fee 降順で決める。
// 採点（per-agent 価値系列）は run 終了直後に歴史ブロック読取で一括再構成する（§4）。
export async function runRealtimeSimulation(): Promise<void> {
  const config = loadConfig();
  const adapters = initProtocols(config.enabledProtocols);
  const enabledIds = adapters.map((a) => a.id);
  const directTx = config.agentDirectTx;

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logger = new RunLogger(config.runDirRoot, runId);
  logger.event({
    type: "run_started_realtime",
    runId,
    enabledProtocols: enabledIds,
    blockTimeSec: config.blockTimeSec,
    runSeconds: config.runSeconds,
    runBlocks: config.runBlocks,
    agentDirectTx: directTx,
  });

  // batch=true: 同一 tick の読取（receipt 並列取得・readState 等）を JSON-RPC array batch /
  // Multicall3 に自動集約し、環境ループの往復回数を抑える。
  const { chain, publicClient, walletClient } = makeClients(
    config.rpcUrl,
    config.chainId,
    { batch: true },
  );
  await resetFork(publicClient, {
    forkUrl: config.forkUrl,
    forkBlockNumber: config.forkBlockNumber,
  });

  // ---- agent ウォレット（プロセスは setup 完了後に起動する）----
  const agentSpecs = loadAgents(config.agentsConfigPath);
  const agentRuntimes: RealtimeAgentRuntime[] = agentSpecs.map((spec) => {
    const privateKey = privateKeyForWalletName(config, spec.wallet, spec.id);
    return {
      id: spec.id,
      spec,
      privateKey,
      address: accountAddress(privateKey),
      process: null,
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
  // flow は環境側の市場機構なので relay のまま（ADR 0006「決めていないこと」）。
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

  // tx の帰属は from アドレス引きが基本（ADR 0006 §4。direct 送信でも blocks.csv を維持）。
  // submittedByHash は環境/relay が自分で提出した tx の actionType・fee の補足にのみ使う。
  const ownerByAddress = new Map<
    string,
    { ownerId: string; role: WalletRole | "system" }
  >();
  for (const agent of agentRuntimes) {
    ownerByAddress.set(agent.address.toLowerCase(), {
      ownerId: agent.id,
      role: "agent",
    });
  }
  for (const [key, wallet] of flowWalletMap) {
    ownerByAddress.set(wallet.address.toLowerCase(), {
      ownerId: wallet.id,
      role: flowRole(key),
    });
  }
  ownerByAddress.set(accountAddress(adminPk).toLowerCase(), {
    ownerId: "oracle",
    role: "system",
  });
  ownerByAddress.set(accountAddress(keeperPk).toLowerCase(), {
    ownerId: "keeper",
    role: "system",
  });
  const submittedByHash = new Map<string, SubmittedMeta>();

  // 実時間の共有最新状態（relay の非同期 action ハンドラと flow context が参照する）
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
        role: flowRole(key),
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

    // ---- fair price のオンチェーン配布経路（ADR 0006 §3）。常設し毎ブロック書き込む ----
    const priceFeedAddress = await deployPriceFeed(ctx, latestFairPrice);
    logger.event({ type: "price_feed_deployed", address: priceFeedAddress });

    // ---- agent プロセス起動（direct: 秘密鍵 + 互換シム注入 / relay: 従来どおり）----
    for (const agent of agentRuntimes) {
      agent.process = new RealtimeAgentProcess(
        agent.spec,
        config.rpcUrl,
        agent.address,
        logger.runDir,
        directTx
          ? { privateKey: agent.privateKey, priceFeedAddress, runId }
          : undefined,
      );
    }

    // ---- 非同期 action ハンドラ（relay モードのみ）：届いた action を即 mempool へ relay ----
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
    if (!directTx) {
      for (const agent of agentRuntimes) {
        agent.process?.onAction(
          (action) => void handleAgentAction(agent, action),
        );
      }
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

    // ---- mined block の tx を blocks.csv へ（帰属は from アドレス引き。ADR 0006 §4）----
    // 実時間ループからは外し、run 終了後に全ブロックを一括走査する（採点の歴史再構成と
    // 同じ「クリティカルパス外」化）。元データは全部チェーンに残っているため後追いで足りる。
    // 帰結: run が途中クラッシュすると blocks.csv は空になる（診断は events.jsonl で行う）。
    const logBlock = async (b: number): Promise<void> => {
      const block = await publicClient.getBlock({
        blockNumber: BigInt(b),
        includeTransactions: true,
      });
      const txs = block.transactions.filter(
        (tx): tx is Exclude<typeof tx, string> => typeof tx !== "string",
      );
      // 注: eth_getBlockReceipts での一括取得は anvil の Arbitrum フォークで
      // "Failed to decode receipt" になるため使えない。per-tx 取得を並列発行する
      // （batch transport が 1 HTTP に束ねる）。
      const statuses = await Promise.all(
        txs.map(async (tx) => {
          try {
            const receipt = await publicClient.getTransactionReceipt({
              hash: tx.hash,
            });
            return receipt.status as string;
          } catch {
            return "mined"; // receipt 取得失敗時のフォールバック
          }
        }),
      );
      txs.forEach((tx, i) => {
        const meta = submittedByHash.get(tx.hash.toLowerCase());
        const owner = meta ?? ownerByAddress.get(tx.from.toLowerCase());
        if (!owner) return; // run 外の tx（想定外の外部送信者）
        const status = statuses[i];
        if (owner.role === "agent") {
          const runtime = agentById.get(owner.ownerId);
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
          // fee はチェーン上の tx フィールドが正（事後検査の根拠。自己申告に依らない）
          priorityFeeWei: tx.maxPriorityFeePerGas ?? meta?.priorityFeeWei ?? 0n,
          status,
          ownerId: owner.ownerId,
          role: owner.role,
          actionType:
            meta?.actionType ?? (owner.role === "agent" ? "direct" : ""),
        });
      });
    };

    // oracle/PriceFeed 更新の fee は agent 上限超にして --order fees で txIndex 0 に置く。
    // keeper はその僅か下に置き、同一ブロック内で「oracle 更新 → 注文約定」の順を固定する
    // （並列提出しても到着順に依らず fee で順序が決まる）。
    const oracleFee = config.maxPriorityFeeWei + 1_000_000_000n;
    const keeperFee = config.maxPriorityFeeWei + 500_000_000n;

    // ---- 競争フェーズ開始：実 N 秒ごとの interval mining へ ----
    await setIntervalMining(publicClient, config.blockTimeSec);
    logger.event({
      type: "interval_mining_started",
      blockTimeSec: config.blockTimeSec,
    });
    const startTime = Date.now();
    let processedBlocks = 0;
    let processing = false;
    let lastProcessedBlock = Number(await publicClient.getBlockNumber());
    const runStartBlock = lastProcessedBlock + 1;

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
          const fromBlock = lastProcessedBlock + 1;
          lastProcessedBlock = Math.max(lastProcessedBlock, bn);

          // 市場を1ステップ進める（RNG の更新は 1 周に 1 回。以降の並列タスクは値だけ共有）
          latestFairPrice = nextFairPrice(latestFairPrice, rng);

          // keeper / oracle 書込 / state+flow は相互に独立（ウォレットも別）なので並列に走らせる。
          // tx の記録（blocks.csv）はループから外し、run 後に一括走査する（logBlock 参照）。

          // keeper（GMX 注文実行等）。追いついた範囲をまとめて 1 回の getLogs で走査する。
          const keeperTask = async (): Promise<void> => {
            if (fromBlock > bn) return;
            for (const adapter of adapters) {
              if (!adapter.afterMine) continue;
              try {
                await adapter.afterMine(ctx, {
                  noMine: true,
                  priorityFeeWei: keeperFee,
                  fromBlock: BigInt(fromBlock),
                  toBlock: BigInt(bn),
                });
              } catch (error) {
                logger.event({
                  type: "keeper_failed",
                  protocol: adapter.id,
                  fromBlock,
                  toBlock: bn,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          };

          // fair price をオンチェーン配布（PriceFeed）+ oracle を mempool 更新（aave/gmx）。
          // 次ブロックに fee 先頭で載る。
          const oracleTask = async (): Promise<void> => {
            try {
              const feedHash = await updatePriceFeedMempool(
                ctx,
                priceFeedAddress,
                latestFairPrice,
                oracleFee,
              );
              submittedByHash.set(feedHash.toLowerCase(), {
                ownerId: "oracle",
                role: "system",
                priorityFeeWei: oracleFee,
                actionType: "priceFeedUpdate",
              });
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
          };

          // state 読取（flow context と relay の観測用。agent 数に依存しない固定コスト）→
          // relay の観測 push → flow-bot への context push。
          const stateAndFlowTask = async (): Promise<void> => {
            const states = await Promise.all(
              adapters.map((adapter) =>
                adapter.readState(ctx, latestFairPrice),
              ),
            );
            const stateById = new Map<ProtocolId, unknown>(
              adapters.map((adapter, i) => [adapter.id, states[i]]),
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

            // relay モードのみ: per-agent 観測を読んで push（direct では agent が self-serve。
            // 環境ループから agent 数比例の読取を消すのが ADR 0006 の主目的）。
            if (!directTx) {
              for (const agent of agentRuntimes) {
                if (!agent.process?.isAlive()) continue;
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
                // per-block 価値系列を events.jsonl に残す（relay のみ。direct では
                // run 後の歴史ブロック再構成が同じ形で書く。ADR 0006 §4）。
                logger.event({
                  type: "observation",
                  agentId: agent.id,
                  observation: obs,
                });
                agent.process.pushObservation(obs);
              }
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
          };

          // 各タスクの所要時間を残す（環境ループの律速診断用。ADR 0006「判定指標」の実測元）
          const timed = async (task: () => Promise<void>): Promise<number> => {
            const t0 = Date.now();
            await task();
            return Date.now() - t0;
          };
          const roundStart = Date.now();
          const [keeperMs, oracleMs, stateFlowMs] = await Promise.all([
            timed(keeperTask),
            timed(oracleTask),
            timed(stateAndFlowTask),
          ]);
          logger.event({
            type: "round_timing",
            blockNumber: bn,
            blocksCaughtUp: Math.max(0, bn - fromBlock + 1),
            keeperMs,
            oracleMs,
            stateFlowMs,
            totalMs: Date.now() - roundStart,
          });

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

    // ---- 競争終了: agent を止めてから採点する（direct agent は止めない限り発注し続ける）----
    for (const agent of agentRuntimes) agent.process?.close();
    flowProcess.close();
    await setIntervalMining(publicClient, 0);

    // ---- blocks.csv の一括記録: 実時間ループから外した分を run 全ブロックぶん走査する ----
    // （resetFork で歴史が消える前・違反検査と summary の前に終える）
    const finalBlock = Number(await publicClient.getBlockNumber());
    for (let b = runStartBlock; b <= finalBlock; b++) await logBlock(b);

    // ---- 採点: per-agent 価値系列を歴史ブロックから一括再構成（ADR 0006 §4）----
    // relay モードは run 中の live observation が同じ形で残っているため再構成しない。
    let valueSeries: Record<string, unknown> = {
      source: "live-observation",
      granularityBlocks: 1,
    };
    if (directTx && finalBlock >= runStartBlock) {
      const meta = await reconstructValueSeries({
        publicClient,
        logger,
        agents: agentRuntimes.map((a) => ({ id: a.id, address: a.address })),
        enabledIds,
        activeStables: activeStables(),
        priceFeed: priceFeedAddress,
        fromBlock: runStartBlock,
        toBlock: finalBlock,
      });
      valueSeries = meta;
      logger.event({ type: "value_series_reconstructed", ...meta });
    }

    // ---- 事後ルール検査（ADR 0006 §5）: fee 上限超過は run 無効化の根拠になる ----
    const violations = checkRunFeeViolations(
      logger.runDir,
      config.maxPriorityFeeWei,
    );
    if (violations.length > 0) {
      logger.event({ type: "rule_violations_detected", violations });
    }

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
        // direct では提出数は agent の自己申告ログ（agents/<id>.jsonl）が一次情報
        ...(directTx ? {} : { submittedTxCount: agent.submitted }),
        includedTxCount: agent.included,
        revertCount: agent.reverted,
        stderrTail: agent.process?.getStderr() ?? "",
      });
    }
    logger.summary({
      runId,
      mode: "realtime",
      agentDirectTx: directTx,
      blockTimeSec: config.blockTimeSec,
      blocksProcessed: processedBlocks,
      elapsedMs,
      finalFairPriceUsdcPerWeth: finalFairPrice,
      valueSeries,
      violations,
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
    for (const agent of agentRuntimes) agent.process?.close();
    flowProcess.close();
  }
}
