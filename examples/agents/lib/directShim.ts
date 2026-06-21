/**
 * directShim: 既存戦略を無改修で「直接チェーンアクセス agent」化する互換シム（ADR 0006 §2）。
 *
 * 環境（coordinator）は direct モード時、agent を
 *   node --import tsx --import <このファイル> examples/agents/<strategy>.ts
 * のように起動する。本モジュールは戦略モジュールより先に評価され、
 *   - process.stdin を PassThrough に差し替え、チェーンから再構成した旧 observation 形を
 *     毎ブロック 1 行 JSON で流し込む（stdin push の置換。fair price はオンチェーン PriceFeed 読取）
 *   - process.stdout.write をフックし、戦略が出す action 行を捕捉 →
 *     parse/validate → adapter.buildTxs → 自分の秘密鍵で署名し直接送信（nonce 自己管理）
 *   - mempool 活動（submitted / failed / rejected）を runs/<id>/agents/<id>.jsonl に
 *     自己申告で記録する（ADR 0006 §5。relay 廃止で coordinator が submitted を数えられない穴を塞ぐ）
 * を行う。戦略コードは従来どおり「stdin で observation を読み stdout に action を書く」だけでよい。
 *
 * 環境変数（環境が渡す）:
 *   ERIS_AGENT_DIRECT_TX=1   このシムを有効化（run 単位で全 agent 一律）
 *   ERIS_AGENT_PRIVATE_KEY   自分の秘密鍵
 *   ERIS_RPC_URL             anvil RPC
 *   ERIS_PRICE_FEED_ADDRESS  fair price 配布コントラクト
 *   ERIS_RUN_ID / ERIS_RUN_DIR / ERIS_AGENT_ID
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wethAbi } from "../../../src/abis.js";
import { parseAction, validateAction } from "../../../src/action.js";
import { getBalances, makeClients } from "../../../src/chain.js";
import { loadConfig } from "../../../src/config.js";
import { GMX_MARKETS, TOKENS } from "../../../src/constants.js";
import { observationFor } from "../../../src/coordinator.js";
import { safeStringify } from "../../../src/logger.js";
import { initProtocols } from "../../../src/protocols/registry.js";
import type { FlowWallet, SimContext } from "../../../src/protocols/types.js";
import { readFairPrice } from "../../../src/realtime/priceFeed.js";
import { Rng } from "../../../src/rng.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  ProtocolId,
} from "../../../src/types.js";

if (process.env.ERIS_AGENT_DIRECT_TX === "1") {
  startDirectShim();
}

function startDirectShim(): void {
  const privateKey = process.env.ERIS_AGENT_PRIVATE_KEY as Hex | undefined;
  const rpcUrl = process.env.ERIS_RPC_URL;
  const priceFeed = process.env.ERIS_PRICE_FEED_ADDRESS as Address | undefined;
  const agentId = process.env.ERIS_AGENT_ID ?? "unknown";
  const runDir = process.env.ERIS_RUN_DIR;
  if (!privateKey || !rpcUrl || !priceFeed) {
    process.stderr.write(
      "[directShim] missing env (ERIS_AGENT_PRIVATE_KEY / ERIS_RPC_URL / ERIS_PRICE_FEED_ADDRESS)\n",
    );
    process.exit(1);
  }
  const runId =
    process.env.ERIS_RUN_ID ?? (runDir ? runDir.split("/").at(-1)! : "direct");

  // ---- mempool 活動の自己申告ログ（runs/<id>/agents/<id>.jsonl）----
  const logMempool = (entry: Record<string, unknown>): void => {
    if (!runDir) return;
    try {
      const dir = join(runDir, "agents");
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, `${agentId}.jsonl`),
        `${safeStringify({ ts: new Date().toISOString(), agentId, kind: "mempool", ...entry })}\n`,
      );
    } catch {
      // ログ失敗は戦略実行に影響させない
    }
  };

  // ---- stdin を差し替え（戦略は従来どおり process.stdin から observation を読む）----
  const fakeStdin = new PassThrough();
  Object.defineProperty(process, "stdin", {
    value: fakeStdin,
    configurable: true,
  });

  // ---- stdout をフック（戦略が書く action 行を捕捉して直接送信へ回す）----
  let pendingOut = "";
  let onActionLine: (line: string) => void = () => {};
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    pendingOut +=
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk as Uint8Array).toString("utf8");
    let idx = pendingOut.indexOf("\n");
    while (idx >= 0) {
      const line = pendingOut.slice(0, idx).trim();
      pendingOut = pendingOut.slice(idx + 1);
      if (line !== "") onActionLine(line);
      idx = pendingOut.indexOf("\n");
    }
    const cb = rest.find((a) => typeof a === "function") as
      | (() => void)
      | undefined;
    cb?.();
    return true;
  }) as typeof process.stdout.write;

  // ---- チェーンクライアント ----
  const config = loadConfig();
  const adapters = initProtocols(config.enabledProtocols);
  const enabledIds = adapters.map((a) => a.id);
  // batch=true: 毎ブロック十数本の観測読取を Multicall3 / JSON-RPC batch に自動集約し、
  // anvil への往復を ~20 本 → 数本に抑える（44 体同時の読みストームで律速になるため）。
  const { chain, publicClient, walletClient } = makeClients(
    rpcUrl,
    config.chainId,
    { batch: true },
  );
  const account = privateKeyToAccount(privateKey);
  const address = account.address;

  // adapter の readState/observe/buildTxs は ctx の clients/config しか使わない。
  // admin/keeper/flow は環境専用のため、agent 側 ctx ではダミー（自鍵）/例外にする。
  const ctx: SimContext = {
    publicClient,
    walletClient,
    chain,
    config,
    rng: new Rng(config.seed),
    adminPk: privateKey,
    keeperPk: privateKey,
    oracle: { aaveAggregators: {} },
    gmx: { market: GMX_MARKETS.ETH_USD },
    pendingGmxOrders: [],
    flowWallet(): FlowWallet {
      throw new Error("flow wallet is environment-only");
    },
  };

  // ---- 状態（最新ブロックの観測。action 検証と buildTxs が参照する）----
  let latestObservation: AgentObservation | null = null;
  let latestBalances: BalanceSnapshot | null = null;
  let latestStateById = new Map<ProtocolId, unknown>();
  const history: AgentObservation["history"] = [];

  // ---- nonce 自己管理 + 送信の直列化 ----
  let nextNonce: number | null = null;
  const allocNonce = async (): Promise<number> => {
    if (nextNonce === null) {
      nextNonce = await publicClient.getTransactionCount({
        address,
        blockTag: "pending",
      });
    }
    return nextNonce++;
  };
  let sendQueue: Promise<void> = Promise.resolve();
  const enqueueSend = (task: () => Promise<void>): void => {
    sendQueue = sendQueue.then(task, task);
  };

  // ---- 競争シグナル（ADR 0011）: 自分の直近 tx の着順/成否を追い、直近ブロックから競合の最高入札を読む。
  // env 特権でなく agent が公開チェーンから自己導出する（現実の MEV searcher が直近ブロックを見るのと同じ）。
  type OwnTx = {
    hash: Hex;
    actionType?: string;
    status?: "success" | "reverted";
    txIndex?: number;
  };
  const ownTxs: OwnTx[] = []; // 直近のみ保持（ring buffer）
  const pushOwnTx = (hash: Hex, actionType?: string): void => {
    ownTxs.push({ hash, actionType });
    if (ownTxs.length > 24) ownTxs.shift();
  };

  const sendBuiltTx = async (
    tx: { to: Address; data?: Hex; value?: bigint },
    priorityFeeWei: bigint,
    meta: Record<string, unknown>,
  ): Promise<void> => {
    try {
      const block = await publicClient.getBlock();
      const baseFee = block.baseFeePerGas ?? 0n;
      const nonce = await allocNonce();
      const hash = await walletClient.sendTransaction({
        account,
        chain,
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
        nonce,
        // baseFee 揺らぎ耐性のため headroom を持たせる（実効 tip は maxPriorityFeePerGas のまま）
        maxFeePerGas: baseFee * 2n + priorityFeeWei,
        maxPriorityFeePerGas: priorityFeeWei,
      });
      pushOwnTx(hash, meta.actionType as string | undefined);
      logMempool({
        event: "submitted",
        hash,
        nonce,
        priorityFeeWei: priorityFeeWei.toString(),
        ...meta,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/nonce/i.test(message)) nextNonce = null; // 次回 pending から再同期
      logMempool({ event: "submit_failed", error: message, ...meta });
    }
  };

  // ---- gas マネージャ（ADR 0011 §4。economicGas プロファイルのみ）----
  // endowment を絞ると naive 戦略がサイレント gas 切れする。ETH 残が「最低 N tx 分」を割ったら
  // WETH→ETH unwrap（スリッページ 0）で自動補充し、WETH も尽きたら USDC→WETH swap（uniswap。
  // スリッページ = 現実の treasury 管理コスト）で繋ぐ。得た WETH は次ブロックの unwrap で ETH 化する。
  // headroom を維持するので補充 tx 自身の gas は常に賄える（初手 gas 切れは setup の下限検証で排除）。
  // 維持する ETH 余力（tx 本数換算）。較正で endowment と併せて調整する（ERIS_GAS_REFILL_TX_HEADROOM）。
  const GAS_REFILL_TX_HEADROOM = BigInt(
    process.env.ERIS_GAS_REFILL_TX_HEADROOM ?? "24",
  );
  const GAS_LIMIT_ESTIMATE = 1_500_000n; // 1 tx の gas 上限見積り
  const GAS_REFILL_COOLDOWN_BLOCKS = 3; // 補充 tx が mine され残高へ反映されるまでの待ち
  let lastGasRefillBlock = -GAS_REFILL_COOLDOWN_BLOCKS;
  const maybeRefillGas = async (
    bn: number,
    balances: BalanceSnapshot,
    fairPrice: number,
  ): Promise<void> => {
    if (!config.economicGas) return;
    if (bn - lastGasRefillBlock < GAS_REFILL_COOLDOWN_BLOCKS) return;
    let baseFee: bigint;
    try {
      baseFee = (await publicClient.getBlock()).baseFeePerGas ?? 0n;
    } catch {
      return;
    }
    const tip = config.defaultPriorityFeeWei;
    const perTxCost = GAS_LIMIT_ESTIMATE * (baseFee * 2n + tip);
    const target = perTxCost * GAS_REFILL_TX_HEADROOM;
    if (balances.ethWei >= target) return;
    const deficit = target - balances.ethWei;

    if (balances.wethWei > 0n) {
      // WETH→ETH unwrap（1:1、スリッページ 0）。不足分まで（在庫上限で頭打ち）。
      const amount = deficit < balances.wethWei ? deficit : balances.wethWei;
      lastGasRefillBlock = bn;
      enqueueSend(() =>
        sendBuiltTx(
          {
            to: TOKENS.WETH.address,
            data: encodeFunctionData({
              abi: wethAbi,
              functionName: "withdraw",
              args: [amount],
            }),
          },
          tip,
          { actionType: "gasRefillUnwrap", amountWei: amount.toString() },
        ),
      );
      return;
    }

    if (balances.usdcUnits > 0n && fairPrice > 0) {
      // USDC→WETH swap（uniswap）。得た WETH は次回 unwrap で ETH 化する。
      const adapter = adapters.find((a) => a.id === "uniswap");
      if (!adapter) return;
      // deficit(ETH wei) 相当の USDC を概算 + slippage バッファ 1.3x（USDC は 6 桁）。
      const deficitWeth = Number(deficit) / 1e18;
      const usdcNeeded = BigInt(Math.ceil(deficitWeth * fairPrice * 1.3 * 1e6));
      const amountIn =
        usdcNeeded < balances.usdcUnits ? usdcNeeded : balances.usdcUnits;
      if (amountIn <= 0n) return;
      lastGasRefillBlock = bn;
      enqueueSend(async () => {
        let txs;
        try {
          txs = await adapter.buildTxs(
            ctx,
            address,
            { type: "swap", tokenIn: "USDC", amountIn: amountIn.toString() },
            latestStateById.get("uniswap"),
          );
        } catch (error) {
          logMempool({
            event: "submit_failed",
            actionType: "gasRefillSwap",
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        for (const tx of txs) {
          await sendBuiltTx(tx, tip, { actionType: "gasRefillSwap" });
        }
      });
    }
  };

  // ---- 競争シグナルを直近ブロックから導出（ADR 0011）----
  const computeCompetition = async (
    bn: number,
  ): Promise<AgentObservation["competition"]> => {
    // 1. 自分の直近 tx の receipt を解決（txIndex + status）。未 mine はスキップ。
    await Promise.all(
      ownTxs
        .filter((t) => t.status === undefined)
        .map(async (t) => {
          try {
            const r = await publicClient.getTransactionReceipt({
              hash: t.hash,
            });
            t.status = r.status === "success" ? "success" : "reverted";
            t.txIndex = r.transactionIndex;
          } catch {
            // まだ mine されていない
          }
        }),
    );
    // 取引 tx のみで revert 率・着順を測る（gas 補充の unwrap/swap は競争分析から除外）。
    const resolved = ownTxs.filter(
      (t) =>
        t.status !== undefined &&
        !String(t.actionType ?? "").startsWith("gasRefill"),
    );
    const recentSampleSize = resolved.length;
    const reverts = resolved.filter((t) => t.status === "reverted").length;
    const recentRevertRate = recentSampleSize ? reverts / recentSampleSize : 0;
    const lastWithIdx = [...resolved]
      .reverse()
      .find((t) => t.txIndex !== undefined);
    const lastTxIndex = lastWithIdx?.txIndex ?? null;
    // 2. 直近ブロックの競合最高入札（自分以外の最高 maxPriorityFeePerGas）。
    let maxComp = 0n;
    let maxAll = 0n;
    try {
      const block = await publicClient.getBlock({
        blockNumber: BigInt(bn),
        includeTransactions: true,
      });
      for (const tx of block.transactions) {
        if (typeof tx === "string") continue;
        const fee = tx.maxPriorityFeePerGas ?? 0n;
        if (fee > maxAll) maxAll = fee;
        if (tx.from.toLowerCase() !== address.toLowerCase() && fee > maxComp)
          maxComp = fee;
      }
    } catch {
      // block 取得失敗は signal 無しで継続
    }
    return {
      maxCompetitorPriorityFeeWei: maxComp.toString(),
      maxBlockPriorityFeeWei: maxAll.toString(),
      lastTxIndex,
      recentRevertRate,
      recentSampleSize,
    };
  };

  // ---- action 行の処理（relay の handleAgentAction と同じ検証 → 直接送信）----
  onActionLine = (line) => {
    let action;
    try {
      action = parseAction(JSON.parse(line));
    } catch (error) {
      logMempool({
        event: "bad_action_line",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (action.type === "noop") return;
    const obs = latestObservation;
    const balances = latestBalances;
    if (!obs || !balances) {
      logMempool({ event: "rejected", reason: "no observation yet", action });
      return;
    }
    const validated = validateAction(action, obs, balances);
    if (!validated.ok) {
      logMempool({ event: "rejected", reason: validated.reason, action });
      return;
    }
    const stateById = latestStateById;
    const blockSeen = obs.round;
    for (const intent of validated.intents) {
      const adapter = adapters.find((a) => a.id === intent.protocol);
      if (!adapter) continue;
      enqueueSend(async () => {
        let txs;
        try {
          txs = await adapter.buildTxs(
            ctx,
            address,
            intent.action,
            stateById.get(intent.protocol),
          );
        } catch (error) {
          logMempool({
            event: "submit_failed",
            actionType: intent.action.type,
            protocol: intent.protocol,
            blockSeen,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        for (const tx of txs) {
          await sendBuiltTx(tx, intent.priorityFeeWei, {
            actionType: intent.action.type,
            protocol: intent.protocol,
            bundleId: intent.bundleId,
            bundleIndex: intent.bundleIndex,
            blockSeen,
          });
        }
      });
    }
    for (const rawIntent of validated.rawIntents) {
      enqueueSend(() =>
        sendBuiltTx(
          {
            to: rawIntent.tx.to as Address,
            data: rawIntent.tx.data as Hex,
            value: rawIntent.tx.value ? BigInt(rawIntent.tx.value) : undefined,
          },
          rawIntent.priorityFeeWei,
          { actionType: "rawTx", blockSeen },
        ),
      );
    }
  };

  // ---- 自走の観測ループ: 新ブロックごとにチェーンから observation を再構成して流し込む ----
  let processing = false;
  let lastBlock = 0;
  const onBlock = async (bn: number): Promise<void> => {
    if (processing || bn <= lastBlock) return;
    processing = true;
    try {
      // 独立な読取は並列化する（2 秒ブロックの hot path。fairPrice → readState の依存だけ保つ）
      const [fairPrice, balances] = await Promise.all([
        readFairPrice(publicClient, priceFeed),
        getBalances(publicClient, address),
      ]);
      const states = await Promise.all(
        adapters.map((adapter) => adapter.readState(ctx, fairPrice)),
      );
      const stateById = new Map<ProtocolId, unknown>(
        adapters.map((adapter, i) => [adapter.id, states[i]]),
      );
      const uni = stateById.get("uniswap") as
        | { priceUsdcPerWeth?: number }
        | undefined;
      history.push({
        round: bn,
        poolPriceUsdcPerWeth: uni?.priceUsdcPerWeth ?? fairPrice,
        fairPriceUsdcPerWeth: fairPrice,
      });
      if (history.length > 20) history.splice(0, history.length - 20);
      const observation = await observationFor(
        ctx,
        adapters,
        stateById,
        runId,
        bn,
        BigInt(bn),
        address,
        fairPrice,
        balances,
        history,
        config,
        enabledIds,
      );
      // 競争シグナル（ADR 0011）を直近ブロックから導出して観測に載せる（priority-fee オークションを
      // 実力化する。economicGas で特に重要だが signal 自体は profile 非依存で常に付与する）。
      observation.competition = await computeCompetition(bn);
      latestObservation = observation;
      latestBalances = balances;
      latestStateById = stateById;
      lastBlock = bn;
      // gas マネージャ: 観測を流す前に ETH 残を点検し、低ければ補充 tx を enqueue（economicGas のみ）。
      void maybeRefillGas(bn, balances, fairPrice);
      fakeStdin.write(`${safeStringify(observation)}\n`);
    } catch (error) {
      process.stderr.write(
        `[directShim] block ${bn} read failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      processing = false;
    }
  };

  publicClient.watchBlockNumber({
    emitOnBegin: true,
    pollingInterval: Math.max(
      100,
      Math.floor((config.blockTimeSec * 1000) / 4),
    ),
    onBlockNumber: (bn) => void onBlock(Number(bn)),
  });

  logMempool({ event: "direct_start", address, rpcUrl });
}
