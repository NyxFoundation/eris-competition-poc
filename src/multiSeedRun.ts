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
  // 価値系列の再構成粒度（ブロック数。ADR 0006 §4）。全 run で一致していることを保証済み。
  // gate は粒度不一致の run 比較を拒否する。
  granularityBlocks: number;
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
  // ADR 0006: 価値系列メタ（再構成粒度）と事後ルール検査の結果。
  valueSeries?: { granularityBlocks?: number };
  violations?: Array<{ ownerId: string; hash: string }>;
};

function emptyAcc(): AgentAcc {
  return { netPnl: [], sharpe: [], infoRatio: [], revert: [], included: [] };
}

// 1 つの run ディレクトリ(summary.json + events.jsonl)を読み、byAgent に寄与させる。
// benchmarkId が渡されたら、その agent の per-round 系列を基準に information ratio も計算する。
// 戻り値は run の runId と価値系列粒度(runs 構築・粒度整合チェック用)。
export function accumulateRun(
  byAgent: Map<string, AgentAcc>,
  runDir: string,
  benchmarkId?: string,
): { runId: string; granularityBlocks: number } {
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
  return {
    runId: summary.runId,
    granularityBlocks: summary.valueSeries?.granularityBlocks ?? 1,
  };
}

// 全 run の粒度が一致していることを確認して返す（混在サンプルの統計比較を防ぐ。ADR 0006 §4）。
function uniformGranularity(granularities: number[]): number {
  const unique = [...new Set(granularities)];
  if (unique.length > 1) {
    throw new Error(
      `価値系列の粒度が run 間で混在しています: ${unique.join(", ")} blocks。同一粒度で取り直してください(ADR 0006 §4)。`,
    );
  }
  return unique[0] ?? 1;
}

// run の市場を歪める違反（fee 上限超過など。ADR 0006 §5）。検出された run は
// サンプルとして無効（違反 tx が動かした市場で他 agent の成績が付く「run 汚染」を防ぐ）。
function runViolations(runDir: string): NonNullable<Summary["violations"]> {
  const summary = JSON.parse(
    readFileSync(join(runDir, "summary.json"), "utf8"),
  ) as Summary;
  return summary.violations ?? [];
}

// 違反 run の自動再実行の上限。恒常的に違反する agent はロスター修正が必要なので打ち切る。
const MAX_VIOLATION_RETRIES = 2;

// regime ごとに replications 回、実時間 sim を直列で実走し、accumulateRun で集計する。
// 旧 collectMultiSeedStats(seed ごとに 1 回・決定論前提)の置換(ADR 0005 §1)。
// ルール違反が検出された run は無効化して自動再実行する(ADR 0006 §5)。
// forkUrl(ARB_RPC_URL)未設定だと resetFork が soft-reset(anvil_reset [])へ黙ってフォールバックし、
// 前 run の市場/ポジション状態が残留する([[anvil-reset-does-not-clear-state]])。比較評価で特に危険:
//   - LP/aave 等ポジション保持戦略は前 run のポジションを引き継ぎ netPnl が汚染(偽の益)
//   - REP>1 は同一 regime で同一ウォレットを再利用するため汚染が確実に出る
//   - swap 系も市場残留ノイズで C2(順位安定)が崩れ識別力を過小評価
// silent に汚染されると誤った結論を出すため(実例: ADR 0007 初版の FAIL→PASS 誤判定)、大きく警告する。
// 純関数(テスト可)。forkUrl があれば null(警告不要)。
export function softResetWarning(
  forkUrl: string | undefined,
  regimes: number[],
  replications: number,
): string | null {
  if (forkUrl) return null;
  const totalRuns = regimes.length * replications;
  return [
    "",
    "============================================================",
    "⚠  WARNING: ARB_RPC_URL 未設定 → resetFork が soft-reset で回ります",
    "============================================================",
    `  比較評価(${totalRuns} run = ${regimes.length} regime × ${replications} rep)で前 run の`,
    "  市場/ポジション状態が残留し、結果が汚染される可能性があります:",
    "    - LP/aave 等ポジション保持戦略は netPnl が汚染(前 run のポジション引継ぎ)",
    "    - REP>1 は同一ウォレット再利用で汚染が確実に発生",
    "    - swap 系も市場残留ノイズで C2(順位安定)が崩れ識別力を過小評価",
    "  → full re-fork(clean)にするには `ARB_RPC_URL` を export してから回すこと。",
    "    例: ARB_RPC_URL=<上流 RPC> FORK_BLOCK_NUMBER=<n> npm run discrimination",
    "============================================================",
    "",
  ].join("\n");
}

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
  // forkUrl 未設定なら soft-reset 汚染を大きく警告(silent 汚染で誤結論を防ぐ)。
  const warning = softResetWarning(config.forkUrl, regimes, replications);
  if (warning) console.error(warning);
  const byAgent = new Map<string, AgentAcc>();
  const runs: ReplicationRun[] = [];
  const granularities: number[] = [];

  for (const regime of regimes) {
    for (let rep = 1; rep <= replications; rep++) {
      process.env.SEED = String(regime);
      let retries = 0;
      for (;;) {
        console.error(
          `[replication] regime=${regime} rep=${rep}/${replications} running realtime simulation (${config.runBlocks} blocks)...`,
        );
        await runRealtimeSimulation();
        const runDir = latestRunDir(config.runDirRoot, true);
        const violations = runViolations(runDir);
        if (violations.length > 0) {
          if (retries >= MAX_VIOLATION_RETRIES) {
            throw new Error(
              `run ${runDir} のルール違反が ${retries} 回の再実行後も解消しません: ` +
                `${violations.map((v) => v.ownerId).join(", ")}。違反 agent をロスターから外してください(ADR 0006 §5)。`,
            );
          }
          retries++;
          console.error(
            `[replication] rule violation detected (${violations.map((v) => v.ownerId).join(", ")}) — run を無効化して再実行 (${retries}/${MAX_VIOLATION_RETRIES})`,
          );
          continue;
        }
        const { runId, granularityBlocks } = accumulateRun(
          byAgent,
          runDir,
          benchmarkId,
        );
        granularities.push(granularityBlocks);
        runs.push({ regime, replication: rep, runId, runDir });
        break;
      }
    }
  }

  return {
    byAgent,
    runs,
    granularityBlocks: uniformGranularity(granularities),
  };
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
  const granularities: number[] = [];
  const repCount = new Map<number, number>();
  runDirs.forEach((runDir, i) => {
    const regime = regimes?.[i] ?? i + 1;
    const replication = (repCount.get(regime) ?? 0) + 1;
    repCount.set(regime, replication);
    const { runId, granularityBlocks } = accumulateRun(
      byAgent,
      runDir,
      benchmarkId,
    );
    granularities.push(granularityBlocks);
    runs.push({ regime, replication, runId, runDir });
  });
  return {
    byAgent,
    runs,
    granularityBlocks: uniformGranularity(granularities),
  };
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
