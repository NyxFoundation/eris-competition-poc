// 反復実行基盤（ADR 0005 §1）。config を regime × N 回 i.i.d. 反復実行し、
// agent ごとの run 横断アキュムレータを作る。
// evaluate.ts（unpaired 統計ゲートの実走部）と scripts/discrimination.ts（識別力判定）で共有する。
//
// coordinator/fs に依存するため、純粋な集計・判定ロジック(src/discrimination.ts)とは分離する
// → 純粋層のユニットテストが coordinator(viem/anvil)を読み込まずに済む。
//
// 実時間化（feat/realtime-blocktime）後の前提:
//   - SEED は市場の「条件（regime = fair price パスと flow の種）を選ぶラベル」。
//     価格パスは seed で再現可能だが、tx タイミング/着順は非決定 → 同一 regime でも
//     結果（agent の PnL）はランごとにぶれる。だから同一 regime を N 回反復してサンプルを貯める。
//   - run 長は runBlocks（ERIS_RUN_BLOCKS）固定で揃える（価格パス長を一定化し公平に）。
//   - 同一 anvil への並行 sim は resetFork が干渉して壊れるため、必ず直列実行する。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import type { AgentAcc } from "./discrimination.js";
import { informationRatio } from "./discrimination.js";
import {
  latestRunDir,
  readPerRoundValues,
  sharpeRatio,
} from "./perRoundValues.js";
import { runRealtimeSimulation } from "./realtime/coordinator.js";

export type ReplicationRun = {
  regime: number; // SEED として渡した regime ラベル
  replication: number; // regime 内の反復番号(1 始まり)
  runId: string;
  runDir: string;
};

export type ReplicationStats = {
  // agent id → run 横断アキュムレータ。netPnl 等の配列は runs と同じ順。
  byAgent: Map<string, AgentAcc>;
  // 各 run のメタ。診断で worst/median run の成果物を直接開けるようにする。
  runs: ReplicationRun[];
};

type SummaryAgent = {
  id: string;
  netPnlUsdc: number;
  revertCount?: number;
  includedTxCount?: number;
};

type Summary = {
  runId: string;
  agents: SummaryAgent[];
};

function emptyAcc(): AgentAcc {
  return { netPnl: [], sharpe: [], infoRatio: [], revert: [], included: [] };
}

// 1 つの run ディレクトリ(summary.json + events.jsonl)を読み、byAgent に寄与させる。
// benchmarkId が渡されたら、その agent の per-round 系列を基準に information ratio も計算する。
// 戻り値は run の runId(runs 構築用)。
export function accumulateRun(
  byAgent: Map<string, AgentAcc>,
  runDir: string,
  benchmarkId?: string,
): string {
  const summary = JSON.parse(
    readFileSync(join(runDir, "summary.json"), "utf8"),
  ) as Summary;
  const values = readPerRoundValues(join(runDir, "events.jsonl"));
  const benchmark = benchmarkId ? values.get(benchmarkId) : undefined;
  for (const a of summary.agents) {
    const acc = byAgent.get(a.id) ?? emptyAcc();
    const series = values.get(a.id) ?? [];
    acc.netPnl.push(a.netPnlUsdc);
    const s = sharpeRatio(series);
    if (s !== null) acc.sharpe.push(s);
    if (benchmark) {
      const ir = informationRatio(series, benchmark);
      if (ir !== null) acc.infoRatio.push(ir);
    }
    acc.revert.push(a.revertCount ?? 0);
    acc.included.push(a.includedTxCount ?? 0);
    byAgent.set(a.id, acc);
  }
  return summary.runId;
}

// regime ごとに replications 回、実時間 sim を直列で実走し、accumulateRun で集計する。
// 旧 collectMultiSeedStats(seed ごとに 1 回・決定論前提)の置換(ADR 0005 §1)。
export async function collectReplicationStats(
  regimes: number[],
  replications: number,
  benchmarkId?: string,
): Promise<ReplicationStats> {
  if (!Number.isInteger(replications) || replications < 1) {
    throw new Error(`invalid replications: ${replications}`);
  }
  const config = loadConfig();
  if (config.runBlocks <= 0) {
    throw new Error(
      "ERIS_RUN_BLOCKS must be > 0: 実時間 run は runBlocks 固定で長さを揃える(ADR 0005 §1)。ERIS_RUN_SECONDS だけでは run 長が wall-clock 依存でぶれる。",
    );
  }
  const byAgent = new Map<string, AgentAcc>();
  const runs: ReplicationRun[] = [];

  for (const regime of regimes) {
    for (let rep = 1; rep <= replications; rep++) {
      process.env.SEED = String(regime);
      console.error(
        `[replication] regime=${regime} rep=${rep}/${replications} running realtime simulation (${config.runBlocks} blocks)...`,
      );
      await runRealtimeSimulation();
      const runDir = latestRunDir(config.runDirRoot, true);
      const runId = accumulateRun(byAgent, runDir, benchmarkId);
      runs.push({ regime, replication: rep, runId, runDir });
    }
  }

  return { byAgent, runs };
}

// 既存の run ディレクトリ群を再シミュレーション無しで集計する(オフライン再判定用)。
// しきい値や metric を変えて判定し直すときに、長い sim を回さず使える。
// regimes を渡すと runDirs と同順の regime ラベルを対応づける(C2 の regime 畳み込み用)。
// 省略時は各 run を独立の regime と見なす(旧挙動互換)。
export function statsFromRunDirs(
  runDirs: string[],
  benchmarkId?: string,
  regimes?: number[],
): ReplicationStats {
  if (regimes && regimes.length !== runDirs.length) {
    throw new Error(
      `regimes length (${regimes.length}) must match runDirs length (${runDirs.length})`,
    );
  }
  const byAgent = new Map<string, AgentAcc>();
  const runs: ReplicationRun[] = [];
  const repCount = new Map<number, number>();
  runDirs.forEach((runDir, i) => {
    const regime = regimes?.[i] ?? i + 1;
    const replication = (repCount.get(regime) ?? 0) + 1;
    repCount.set(regime, replication);
    const runId = accumulateRun(byAgent, runDir, benchmarkId);
    runs.push({ regime, replication, runId, runDir });
  });
  return { byAgent, runs };
}

// REGIMES / SEEDS env のパース(evaluate / discrimination 共通)。
export function parseRegimes(
  value: string | undefined,
  fallback: string,
): number[] {
  const regimes = (value ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (regimes.length === 0 || regimes.some((s) => !Number.isInteger(s))) {
    throw new Error(`invalid REGIMES: ${value}`);
  }
  return regimes;
}
