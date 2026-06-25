// ダッシュボードのライブ状態モデル（ADR 0008「state」）。
//
// runWatcher（ファイル tail）と valuePoller（RPC 断面）からの更新を集約し、
// 接続中の全ブラウザへ送る増分メッセージ（SSE）を生成する。新規接続には snapshot()
// でフル状態を 1 回送る。状態の権威は「ライブ＝参考」であり、最終指標は run 後 reconstruct
// が持つ（ADR 0008 §B）。run.finalized でそのフェーズを UI に伝える。

import { EventEmitter } from "node:events";
import { type AgentKind, agentColor, classifyAgent } from "./labels.js";

export type RunPhase = "idle" | "started" | "completed";

export type RunMeta = {
  runId: string | null;
  phase: RunPhase;
  enabledProtocols: string[];
  blockTimeSec: number;
  runBlocks: number;
  processedBlocks: number;
  finalized: boolean; // value_series_reconstructed を観測したか（確定値へ切替）
  runDir: string;
};

export type AgentInfo = {
  id: string;
  address: string | null;
  kind: AgentKind;
  base: string | null;
  index: number | null;
  color: string;
  baseline: boolean;
};

export type RankRow = {
  id: string;
  valueUsdc: number;
  pnlUsdc: number;
  rank: number;
};

export type BlockPoint = {
  blockNumber: number;
  ts: number;
  timingMs: number | null;
};

export type PricePoint = {
  blockNumber: number;
  fairPrice: number;
  poolPrice: number | null;
};

export type TxRow = {
  // realtime では blocks.csv は run 後一括書込なので、ライブ tx フィードは
  // submitted（events.jsonl tx_submitted = flow / agents/*.jsonl mempool = direct agent）と
  // mined（run 後 blocks.csv = 確定の着順・status）を 1 本のストリームに流す。
  phase: "submitted" | "mined";
  blockNumber: number;
  txIndex: number | null; // submitted 時点では未確定 → null
  ownerId: string;
  role: string;
  actionType: string;
  priorityFeeWei: string;
  status: string;
};

export type AgentRecentRow = TxRow & { ts: number };

export type Activity = {
  id: string;
  submitted: number;
  rejected: number;
  submitFailed: number;
  included: number;
  reverted: number;
  lastEvent: string | null;
  lastActionType: string | null;
  lastReason: string | null;
  lastTs: number | null;
};

// 市場ストレスシナリオ（ADR 0009）。stress_schedule から組み立てる。窓は blockIndex 基準なので
// runStartBlock を持ち、フロントが latestBlock と突き合わせて「注入中」を判定する。
export type ScenarioEvent = {
  type: string; // "spike" | "crash"
  startBlock: number; // blockIndex（runStart からの 0 起点）
  endBlock: number;
  magnitude: number;
};
export type ScenarioMeta = {
  name: string; // 表示名（例 "crash" / "spike·crash"）
  runStartBlock: number;
  events: ScenarioEvent[];
};

// 清算イベント（victim 債務の減少 = liquidationCall）。tx フィードに LIQ 行として出す。
export type LiquidationEvent = {
  blockNumber: number;
  victimId: string;
  repaidBaseUsd: number; // USD 8 桁
  healthFactor: string;
  ts: number;
};

export type PollerStatus = {
  connected: boolean;
  degraded: boolean; // RPC 接続不可 → ファイル tail のみ（ADR 0008 degrade）
  lastError: string | null;
  lastPollBlock: number | null;
  pollEvery: number;
};

class Ring<T> {
  private buf: T[] = [];
  constructor(private readonly cap: number) {}
  push(x: T): void {
    this.buf.push(x);
    if (this.buf.length > this.cap)
      this.buf.splice(0, this.buf.length - this.cap);
  }
  items(): T[] {
    return this.buf;
  }
}

const FAILURE_STATUSES = new Set(["reverted", "failure", "failed", "0x0"]);
function isRevert(status: string): boolean {
  return FAILURE_STATUSES.has(status.toLowerCase());
}

export class DashboardState extends EventEmitter {
  run: RunMeta = {
    runId: null,
    phase: "idle",
    enabledProtocols: [],
    blockTimeSec: 0,
    runBlocks: 0,
    processedBlocks: 0,
    finalized: false,
    runDir: "",
  };
  priceFeed: string | null = null;
  latestBlock = 0;
  totals = { txCount: 0, revertCount: 0 };
  // 市場ストレスシナリオ（ADR 0009）。未注入なら null。
  scenario: ScenarioMeta | null = null;
  poller: PollerStatus = {
    connected: false,
    degraded: false,
    lastError: null,
    lastPollBlock: null,
    pollEvery: 0,
  };

  private readonly agents = new Map<string, AgentInfo>();
  private readonly order: string[] = [];
  private readonly initialValue = new Map<string, number>();
  private ranking: RankRow[] = [];
  private fairPrice = 0;
  private poolPrice: number | null = null;
  private readonly blocks = new Ring<BlockPoint>(900);
  private readonly prices = new Ring<PricePoint>(900);
  private readonly txs = new Ring<TxRow>(250);
  private readonly liquidations = new Ring<LiquidationEvent>(50);
  private readonly activity = new Map<string, Activity>();
  private readonly agentRecent = new Map<string, Ring<AgentRecentRow>>();

  private send(event: string, data: unknown): void {
    this.emit("message", { event, data });
  }

  private ensureAgent(
    id: string,
    opts?: { address?: string | null; baseline?: boolean },
  ): AgentInfo {
    let info = this.agents.get(id);
    if (!info) {
      const cls = classifyAgent(id, { baseline: opts?.baseline });
      info = {
        id,
        address: opts?.address ?? null,
        kind: cls.kind,
        base: cls.base,
        index: cls.index,
        color: agentColor(id, cls.kind),
        baseline: opts?.baseline ?? cls.kind === "baseline",
      };
      this.agents.set(id, info);
      this.order.push(id);
      this.activity.set(id, {
        id,
        submitted: 0,
        rejected: 0,
        submitFailed: 0,
        included: 0,
        reverted: 0,
        lastEvent: null,
        lastActionType: null,
        lastReason: null,
        lastTs: null,
      });
    } else if (opts?.address && !info.address) {
      info.address = opts.address;
    }
    return info;
  }

  private agentList(): AgentInfo[] {
    return this.order.map((id) => this.agents.get(id)!);
  }

  agentCount(): number {
    return this.order.length;
  }

  // poller 用: アドレス確定済みの agent だけ（断面 multicall に渡す）。
  agentsWithAddress(): Array<{ id: string; address: string }> {
    return this.agentList()
      .filter((a) => a.address)
      .map((a) => ({ id: a.id, address: a.address as string }));
  }

  private activityList(): Activity[] {
    return this.order.map((id) => this.activity.get(id)!).filter(Boolean);
  }

  private rememberAgentRecent(row: AgentRecentRow): void {
    this.ensureAgent(row.ownerId);
    let ring = this.agentRecent.get(row.ownerId);
    if (!ring) {
      ring = new Ring<AgentRecentRow>(20);
      this.agentRecent.set(row.ownerId, ring);
    }
    ring.push(row);
  }

  private agentRecentSnapshot(): Record<string, AgentRecentRow[]> {
    return Object.fromEntries(
      [...this.agentRecent.entries()].map(([id, ring]) => [
        id,
        ring.items().slice().reverse(),
      ]),
    );
  }

  // ---- runWatcher からの更新 ----

  setRun(meta: Partial<RunMeta> & { runId?: string }): void {
    this.run = {
      ...this.run,
      ...meta,
      phase:
        meta.phase ?? (this.run.phase === "idle" ? "started" : this.run.phase),
    };
    this.send("run", this.run);
  }

  setPriceFeed(address: string): void {
    this.priceFeed = address;
  }

  // 市場ストレスシナリオを登録（ADR 0009 stress_schedule）。
  setScenario(scenario: ScenarioMeta): void {
    this.scenario = scenario;
    this.send("scenario", scenario);
  }

  // 清算イベントを記録し tx フィードへ流す（ADR 0009 stress_liquidation）。
  recordLiquidation(liq: Omit<LiquidationEvent, "ts"> & { ts?: number }): void {
    const row: LiquidationEvent = { ...liq, ts: liq.ts ?? Date.now() };
    this.liquidations.push(row);
    this.send("liquidation", row);
  }

  registerAgents(
    list: Array<{ id: string; address?: string | null; baseline?: boolean }>,
  ): void {
    for (const a of list) {
      this.ensureAgent(a.id, {
        address: a.address ?? null,
        baseline: a.baseline,
      });
    }
    this.send("agents", this.agentList());
  }

  noteAgentAddress(id: string, address: string): void {
    const before = this.agents.has(id);
    this.ensureAgent(id, { address });
    if (!before) this.send("agents", this.agentList());
  }

  addBlock(point: {
    blockNumber: number;
    timingMs: number | null;
    ts?: number;
  }): void {
    const ts = point.ts ?? Date.now();
    if (point.blockNumber > this.latestBlock)
      this.latestBlock = point.blockNumber;
    this.run.processedBlocks += 1;
    const bp: BlockPoint = {
      blockNumber: point.blockNumber,
      ts,
      timingMs: point.timingMs,
    };
    this.blocks.push(bp);
    this.send("block", { ...bp, processedBlocks: this.run.processedBlocks });
  }

  addTx(row: TxRow): void {
    this.txs.push(row);
    this.rememberAgentRecent({ ...row, ts: Date.now() });
    this.send("tx", row);
    // included/reverted の集計は確定（blocks.csv = mined）のみ。submitted は二重計上しない。
    if (row.phase !== "mined") return;
    this.totals.txCount += 1;
    const reverted = isRevert(row.status);
    if (reverted) this.totals.revertCount += 1;
    if (row.role === "agent") {
      this.ensureAgent(row.ownerId);
      const act = this.activity.get(row.ownerId)!;
      act.included += 1;
      if (reverted) act.reverted += 1;
    }
  }

  addAgentAction(a: {
    agentId: string;
    event: string;
    actionType?: string | null;
    reason?: string | null;
    ts?: number;
  }): void {
    this.ensureAgent(a.agentId);
    const act = this.activity.get(a.agentId)!;
    if (a.event === "submitted") act.submitted += 1;
    else if (a.event === "rejected") act.rejected += 1;
    else if (a.event === "submit_failed") act.submitFailed += 1;
    act.lastEvent = a.event;
    if (a.actionType) act.lastActionType = a.actionType;
    if (a.reason) act.lastReason = a.reason;
    act.lastTs = a.ts ?? Date.now();
    this.rememberAgentRecent({
      phase: a.event === "submitted" ? "submitted" : "mined",
      blockNumber: this.latestBlock,
      txIndex: null,
      ownerId: a.agentId,
      role: "agent",
      actionType: a.actionType ?? a.event,
      priorityFeeWei: "0",
      status: a.event,
      ts: act.lastTs,
    });
    this.send("agentAction", {
      agentId: a.agentId,
      event: a.event,
      actionType: a.actionType ?? null,
      reason: a.reason ?? null,
      submitted: act.submitted,
      rejected: act.rejected,
      submitFailed: act.submitFailed,
      lastTs: act.lastTs,
    });
  }

  markFinalized(): void {
    this.run.finalized = true;
    this.send("run", this.run);
  }

  // run 後 reconstruct の確定値で順位を上書き表示する（ADR 0008 P3「確定値切替」）。
  // poller が一度も走らなくても（ダッシュボードを run 後に起動した等）確定順位が出る。
  // pnl は再構成系列の最初と最後のブロック差から算出済みのものを受け取る。
  setFinalRanking(
    rows: Array<{ id: string; valueUsdc: number; pnlUsdc: number }>,
  ): void {
    this.ranking = rows
      .slice()
      .sort((a, b) => b.valueUsdc - a.valueUsdc)
      .map((r, i): RankRow => ({ ...r, rank: i + 1 }));
    this.run.finalized = true;
    this.send("run", this.run);
    this.send("values", {
      blockNumber: this.poller.lastPollBlock ?? this.latestBlock,
      fairPrice: this.fairPrice,
      poolPrice: this.poolPrice,
      ranking: this.ranking,
      finalized: true,
    });
  }

  completeRun(): void {
    this.run.phase = "completed";
    this.send("run", this.run);
  }

  // ---- valuePoller からの更新 ----

  setPollerStatus(patch: Partial<PollerStatus>): void {
    this.poller = { ...this.poller, ...patch };
    this.send("pollerStatus", this.poller);
  }

  setValues(snapshot: {
    blockNumber: number;
    fairPrice: number;
    poolPrice: number | null;
    values: Array<{ id: string; valueUsdc: number }>;
  }): void {
    // 確定値へ切替済みならライブの遅延 poll で上書きしない（権威は reconstruct）。
    if (this.run.finalized) return;
    for (const v of snapshot.values) {
      this.ensureAgent(v.id);
      if (!this.initialValue.has(v.id))
        this.initialValue.set(v.id, v.valueUsdc);
    }
    const rows = snapshot.values
      .map((v) => ({
        id: v.id,
        valueUsdc: v.valueUsdc,
        pnlUsdc: v.valueUsdc - (this.initialValue.get(v.id) ?? v.valueUsdc),
      }))
      .sort((a, b) => b.valueUsdc - a.valueUsdc)
      .map((r, i): RankRow => ({ ...r, rank: i + 1 }));
    this.ranking = rows;
    this.fairPrice = snapshot.fairPrice;
    this.poolPrice = snapshot.poolPrice;
    this.prices.push({
      blockNumber: snapshot.blockNumber,
      fairPrice: snapshot.fairPrice,
      poolPrice: snapshot.poolPrice,
    });
    this.poller.lastPollBlock = snapshot.blockNumber;
    this.send("values", {
      blockNumber: snapshot.blockNumber,
      fairPrice: snapshot.fairPrice,
      poolPrice: snapshot.poolPrice,
      ranking: rows,
    });
  }

  // ---- 新規接続向けフル状態 ----

  snapshot(): Record<string, unknown> {
    return {
      run: this.run,
      priceFeed: this.priceFeed,
      latestBlock: this.latestBlock,
      agents: this.agentList(),
      ranking: this.ranking,
      fairPrice: this.fairPrice,
      poolPrice: this.poolPrice,
      blocks: this.blocks.items(),
      prices: this.prices.items(),
      tx: this.txs.items(),
      agentRecent: this.agentRecentSnapshot(),
      activity: this.activityList(),
      poller: this.poller,
      totals: this.totals,
      scenario: this.scenario,
      liquidations: this.liquidations.items(),
    };
  }
}
