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
  increaseTime,
  makeClients,
  mine,
  resetFork,
  sendAndMine,
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
import { baseTokens } from "./markets.js";
import { enabledAdapters, initProtocols } from "./protocols/registry.js";
import type { FlowKind, FlowWallet, SimContext } from "./protocols/types.js";
import { updateOracles } from "./protocols/oracles.js";
import { GMX_MARKETS } from "./constants.js";
import { FlowProcess, type FlowOrderWire } from "./flowProcess.js";
import type { FlowContextWire } from "./flow/logic.js";
import { readAaveFlowReserves } from "./protocols/aave.js";
import {
  applyOracleShock,
  openVictimPosition,
  setupVictim,
  VICTIM_ADDRESS,
  victimHealthFactor,
} from "./liquidationDemo.js";
import { deployFlashArb, FLASH_ARB_ADDRESS } from "./flashArbDemo.js";

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
  // 有効 protocol の設定 + stable 統一会計の登録（registry.initProtocols に集約）
  const adapters = initProtocols(config.enabledProtocols);
  const enabledIds = adapters.map((a) => a.id);

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
  await resetFork(publicClient, {
    forkUrl: config.forkUrl,
    forkBlockNumber: config.forkBlockNumber,
  });
  if (!config.forkUrl) {
    // 上流 RPC 未設定だと soft reset になり、run/seed 間で Aave 等の状態が残留する。
    console.warn(
      "[coordinator] ARB_RPC_URL 未設定: anvil_reset [] フォールバック。複数 run/seed を" +
        "同一 anvil で回すと Aave ポジションが残留し PnL が汚染されます。ARB_RPC_URL を設定するか" +
        " anvil を都度再起動してください。",
    );
  }
  logger.event({ type: "fork_reset", forked: Boolean(config.forkUrl) });

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
        logger.runDir,
      ),
      initial: { ethWei: 0n, wethWei: 0n, usdcUnits: 0n },
    };
  });
  const agentMetrics = new Map(
    agentRuntimes.map((agent) => [agent.id, emptyAgentMetrics()]),
  );

  // orderflow bot（独立プロセス）。毎ラウンド FlowContext を渡し FlowOrder[] を受け取る。
  // bot は RPC に触れず注文を決めるだけ。seeded RNG で決定論（同一 seed → 同一市場）。
  const flowProcess = new FlowProcess(
    config.flowBotCommand,
    config.flowBotArgs,
    config.flowSeed,
    logger.runDir,
  );

  // protocol/kind ごとの flow ウォレットを導出（spread = cross-venue 注入用。既定 off だが
  // wallet は常に用意し、有効化時に flowOrdersToIntents が引けるようにする）
  const flowWalletMap = new Map<string, FlowWallet>();
  for (const id of enabledIds) {
    for (const kind of ["informed", "uninformed", "spread"] as FlowKind[]) {
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
      flow?: boolean;
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
        flow: true,
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
        target.flow ? config.flowEthWei : config.initialEthWei,
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

    // ---- 清算デモ(GitHub #1, env gate): victim を資金調達+approve ----
    const liquidationDemo =
      config.liquidationDemo && enabledIds.includes("aave");
    if (liquidationDemo) {
      await setupVictim(ctx);
      logger.event({
        type: "liquidation_victim_setup",
        address: VICTIM_ADDRESS,
      });
    }

    // ---- フラッシュ arb デモ(GitHub #3, env gate): FlashArb をデプロイ ----
    if (
      config.flashArbDemo &&
      enabledIds.includes("aave") &&
      enabledIds.includes("uniswap") &&
      enabledIds.includes("balancer")
    ) {
      await deployFlashArb(ctx);
      logger.event({ type: "flash_arb_deployed", address: FLASH_ARB_ADDRESS });
    }

    let fairPrice = await initialFairPrice(ctx, enabledIds);
    const fairAnchor = fairPrice; // 平均回帰価格モデルの中心（初期 fair price）
    const history: AgentObservation["history"] = [];
    for (const agent of agentRuntimes) {
      agent.initial = await getBalances(
        publicClient,
        accountAddress(agent.privateKey),
      );
    }

    for (let round = 1; round <= config.rounds; round++) {
      fairPrice = nextFairPrice(fairPrice, rng, fairAnchor);

      // ---- 0) EVM 時間を進める（Aave 変動金利・GMX funding が現実スケールで効くように）----
      // evm_increaseTime は「次の mine 時点での timestamp」に効くので、
      // 直後の updateOracles が +roundTimeSeconds 経過した timestamp で価格を書き込む。
      if (config.roundTimeSeconds > 0) {
        await increaseTime(publicClient, config.roundTimeSeconds);
      }

      // ---- 1) Oracle ブロック（GMX/Aave の mock 価格を fairPrice に追従）----
      // updateOracles は内部で sendAndMine するため追加 mine は不要。
      await updateOracles(ctx, fairPrice);

      // ---- 1b) 清算デモ(env gate): round 1 で victim を開き、shockRound 以降は
      //         WETH オラクルを引き下げて victim を HF<1 にする ----
      if (liquidationDemo) {
        if (round === 1) await openVictimPosition(ctx);
        if (round >= config.liquidationShockRound) {
          await applyOracleShock(ctx, fairPrice);
          logger.event({
            type: "liquidation_victim_hf",
            round,
            healthFactor: (await victimHealthFactor(ctx)).toString(),
          });
        }
      }

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

      const flowIntents = await requestFlowIntents(
        ctx,
        flowProcess,
        enabledIds,
        stateById,
        fairPrice,
        round,
        config.agentTimeoutMs,
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
    // status は stderr へ。stdout は evaluate の JSON 専用に保つ（純 JSON を壊さない）。
    console.error(`simulation completed: ${logger.runDir}`);
  } finally {
    for (const agent of agentRuntimes) agent.process.close();
    flowProcess.close();
  }
}

// ---------------------------------------------------------------------------
// 観測 / flow / submit
// ---------------------------------------------------------------------------

export async function observationFor(
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
  // protocol ごとの観測は独立した読取なので並列に発行する。direct モードの agent クライアント
  // （batch=true）では同一 tick の読取が Multicall3 1 本に自動集約されるため、並列発行が
  // そのまま往復回数の削減になる。
  const protocols: ProtocolObservations = {};
  await Promise.all(
    adapters.map(async (adapter) => {
      const obs = await adapter.observe(
        ctx,
        stateById.get(adapter.id),
        agentAddress,
        fairPrice,
      );
      (protocols as Record<string, unknown>)[adapter.id] = obs;
    }),
  );
  return {
    kind: "observation",
    runId,
    round,
    blockNumber: blockNumber.toString(),
    agentAddress,
    fairPriceUsdcPerWeth: fairPrice,
    oraclePrices: { wethUsd: fairPrice, usdcUsd: 1 },
    // ADR 0013: 全 base の USD 価格・残高。WETH のみのとき fairPricesUsd={WETH:fairPrice} で
    // 既存フィールドと一致（後方互換）。WBTC を見る戦略だけ参照する。
    fairPricesUsd: ctx.fairPrices ?? { WETH: fairPrice },
    ...(balances.bases
      ? {
          baseBalances: Object.fromEntries(
            Object.entries(balances.bases).map(([k, v]) => [k, v.toString()]),
          ),
        }
      : {}),
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
      // 経済化（ADR 0011 §2）: priority-fee 上限執行を退役するので、agent へ提示する上限も
      // 実質撤廃する（入札は機会価値で自己制限する = realistic priority gas auction）。validateAction の
      // 提出前チェックもこの値を見るため、ここを上げないと高入札が黙って弾かれる。10^18 wei/gas は
      // 事実上無制限の guard（壊れた巨大入札だけ弾く。実 spend は EIP-1559 残高制約で endowment に縛られる）。
      maxPriorityFeePerGasWei: (config.economicGas
        ? 1_000_000_000_000_000_000n
        : config.maxPriorityFeeWei
      ).toString(),
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

// orderflow bot プロセスに FlowContext を渡して FlowOrder[] を受け取り、TxIntent に変換する。
// flow ウォレットの選択と tx 提出は coordinator が所有（bot は注文を決めるだけ）。
// FlowContext を組み立てる（poolPrices / aave reserves / limits）。realtime でも毎ブロック再利用する。
export async function buildFlowContext(
  ctx: SimContext,
  enabledIds: ProtocolId[],
  stateById: Map<ProtocolId, unknown>,
  fairPrice: number,
  round: number,
): Promise<FlowContextWire> {
  const poolPrices: Partial<Record<"uniswap" | "balancer" | "curve", number>> =
    {};
  for (const id of ["uniswap", "balancer", "curve"] as const) {
    if (!enabledIds.includes(id)) continue;
    const s = stateById.get(id) as { priceUsdcPerWeth?: number } | undefined;
    if (s && typeof s.priceUsdcPerWeth === "number")
      poolPrices[id] = s.priceUsdcPerWeth;
  }

  // aave flow は flow ウォレットの reserve に依存する。RPC 読取は coordinator 側で行い渡す。
  let aaveReserves: FlowContextWire["aaveReserves"];
  if (enabledIds.includes("aave")) {
    const wallet = ctx.flowWallet("aave", "informed");
    const r = await readAaveFlowReserves(ctx.publicClient, wallet.address);
    aaveReserves = {
      wethSupplied: r.wethSupplied.toString(),
      usdcBorrowed: r.usdcBorrowed.toString(),
    };
  }
  const flowBalances: FlowContextWire["flowBalances"] = {};
  for (const protocol of enabledIds) {
    for (const kind of ["informed", "uninformed", "spread"] as FlowKind[]) {
      const wallet = ctx.flowWallet(protocol, kind);
      const b = await getBalances(ctx.publicClient, wallet.address);
      flowBalances[`${protocol}:${kind}`] = {
        wethWei: b.wethWei.toString(),
        usdcUnits: b.usdcUnits.toString(),
      };
    }
  }

  // ADR 0013 Phase 8: WETH 以外の base の AMM flow context。flow max>0 かつ価格が揃う base のみ
  // 載せる（max=0/未設定なら省略 → buildFlowOrders が当該 base を反復せず RNG 非消費 = byte 互換）。
  const extraBases: NonNullable<FlowContextWire["extraBases"]> = [];
  for (const t of baseTokens()) {
    if (t.symbol === "WETH") continue;
    const max = ctx.config.baseFlowMax?.[t.symbol] ?? 0n;
    if (max <= 0n) continue;
    const basePoolPrices: NonNullable<
      FlowContextWire["extraBases"]
    >[number]["poolPrices"] = {};
    for (const id of ["uniswap", "balancer", "curve"] as const) {
      if (!enabledIds.includes(id)) continue;
      const s = stateById.get(id) as
        | {
            markets?: Array<{
              market: { base: string };
              priceUsdcPerWeth: number;
            }>;
          }
        | undefined;
      const ms = s?.markets?.find((m) => m.market.base === t.symbol);
      if (
        ms &&
        typeof ms.priceUsdcPerWeth === "number" &&
        ms.priceUsdcPerWeth > 0
      )
        basePoolPrices[id] = ms.priceUsdcPerWeth;
    }
    const fairPriceUsd = ctx.fairPrices?.[t.symbol] ?? 0;
    if (fairPriceUsd <= 0 || Object.keys(basePoolPrices).length === 0) continue;
    const maxStr = max.toString();
    extraBases.push({
      base: t.symbol,
      poolPrices: basePoolPrices,
      fairPriceUsd,
      uninformedFlowMaxBaseWei: maxStr,
      informedFlowMaxBaseWei: maxStr,
      balancerFlowMaxBaseWei: maxStr,
      curveFlowMaxBaseWei: maxStr,
    });
  }

  return {
    round,
    fairPriceUsdcPerWeth: fairPrice,
    protocols: enabledIds,
    poolPrices,
    aaveReserves,
    flowBalances,
    usdcOnlyFlow: ctx.config.initialWethWei === 0n,
    ...(extraBases.length > 0 ? { extraBases } : {}),
    limits: {
      uninformedFlowMaxWethWei: ctx.config.uninformedFlowMaxWethWei.toString(),
      informedFlowMaxWethWei: ctx.config.informedFlowMaxWethWei.toString(),
      balancerFlowMaxWethWei: ctx.config.balancerFlowMaxWethWei.toString(),
      curveFlowMaxWethWei: ctx.config.curveFlowMaxWethWei.toString(),
      gmxFlowMaxSizeUsd: ctx.config.gmxFlowMaxSizeUsd.toString(),
      aaveFlowMaxWethWei: ctx.config.aaveFlowMaxWethWei.toString(),
      maxAaveBorrowUsdcUnits: ctx.config.maxAaveBorrowUsdcUnits.toString(),
      crossVenueSpreadFlowMaxWethWei:
        ctx.config.crossVenueSpreadFlowMaxWethWei.toString(),
      defaultPriorityFeeWei: ctx.config.defaultPriorityFeeWei.toString(),
    },
  };
}

// bot が返した FlowOrder[] を flow ウォレット紐付けの TxIntent[] に変換する。
export function flowOrdersToIntents(
  ctx: SimContext,
  orders: FlowOrderWire[],
): TxIntent[] {
  const intents: TxIntent[] = [];
  for (const order of orders) {
    const wallet = ctx.flowWallet(
      order.walletProtocol ?? order.protocol,
      order.kind,
    );
    intents.push({
      ownerId: wallet.id,
      role: order.kind === "informed" ? "informed-flow" : "uninformed-flow",
      privateKey: wallet.privateKey,
      protocol: order.protocol,
      action: order.action,
      priorityFeeWei: BigInt(order.priorityFeeWei),
      gmxOrder: order.protocol === "gmx",
    });
  }
  return intents;
}

// orderflow bot プロセスに FlowContext を渡して FlowOrder[] を受け取り、TxIntent に変換する。
// flow ウォレットの選択と tx 提出は coordinator が所有（bot は注文を決めるだけ）。
export async function requestFlowIntents(
  ctx: SimContext,
  flowProcess: FlowProcess,
  enabledIds: ProtocolId[],
  stateById: Map<ProtocolId, unknown>,
  fairPrice: number,
  round: number,
  timeoutMs: number,
): Promise<TxIntent[]> {
  const context = await buildFlowContext(
    ctx,
    enabledIds,
    stateById,
    fairPrice,
    round,
  );
  const orders = await flowProcess.requestOrders(context, timeoutMs);
  return flowOrdersToIntents(ctx, orders);
}

export async function submitIntent(
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

export async function submitRawTxIntent(
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

export async function initialFairPrice(
  ctx: SimContext,
  enabledIds: ProtocolId[],
): Promise<number> {
  if (enabledIds.includes("uniswap")) {
    const { getPoolPriceUsdcPerWeth } = await import("./protocols/uniswap.js");
    return getPoolPriceUsdcPerWeth(ctx.publicClient);
  }
  return 3000;
}

// ADR 0013: 追加 base（WBTC 等）の初期 fair price。uniswap の当該 market pool 価格を採用し、
// 無ければ既定（WBTC=60000）。WETH は従来の initialFairPrice にフォールバック。
export async function initialFairPriceFor(
  ctx: SimContext,
  base: string,
  enabledIds: ProtocolId[],
): Promise<number> {
  if (base === "WETH") return initialFairPrice(ctx, enabledIds);
  if (enabledIds.includes("uniswap")) {
    const { getPoolState } = await import("./protocols/uniswap.js");
    const s = await getPoolState(ctx.publicClient);
    const m = s.markets.find((ms) => ms.market.base === base);
    if (m) return m.priceUsdcPerWeth;
  }
  return base === "WBTC" ? 60000 : 3000;
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
