// 複数 SEED で sim を実走し、agent ごとの seed 横断アキュムレータを作る。
// evaluate.ts(過学習ゲート)と scripts/discrimination.ts(識別力判定)で共有する。
//
// coordinator/fs に依存するため、純粋な集計・判定ロジック(src/discrimination.ts)とは分離する
// → 純粋層のユニットテストが coordinator(viem/anvil)を読み込まずに済む。
//
// 各 SEED は市場(fair price + flow bot)を決定論的に固定する(flowSeed 既定 = SEED, config.ts)。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { runSimulation } from "./coordinator.js";
import type { AgentAcc } from "./discrimination.js";
import {
  latestRunDir,
  readPerRoundValues,
  sharpeRatio,
} from "./perRoundValues.js";

export type SeedRun = { seed: number; runId: string; runDir: string };

export type MultiSeedStats = {
  // agent id → seed 横断アキュムレータ。perSeed 配列は seeds と同じ順。
  byAgent: Map<string, AgentAcc>;
  // seed → run の対応。診断で median/worst seed の run を直接開けるようにする。
  perSeedRuns: SeedRun[];
};

type SummaryAgent = {
  id: string;
  netPnlUsdc: number;
  revertCount: number;
  includedTxCount: number;
};

type Summary = {
  runId: string;
  agents: SummaryAgent[];
};

export async function collectMultiSeedStats(
  seeds: number[],
): Promise<MultiSeedStats> {
  const runDirRoot = loadConfig().runDirRoot;
  const byAgent = new Map<string, AgentAcc>();
  const perSeedRuns: SeedRun[] = [];

  for (const seed of seeds) {
    process.env.SEED = String(seed);
    console.error(`[multiSeed] seed=${seed} running simulation...`);
    await runSimulation();
    const runDir = latestRunDir(runDirRoot, true);
    const summary = JSON.parse(
      readFileSync(join(runDir, "summary.json"), "utf8"),
    ) as Summary;
    perSeedRuns.push({ seed, runId: summary.runId, runDir });
    const values = readPerRoundValues(join(runDir, "events.jsonl"));
    for (const a of summary.agents) {
      const acc = byAgent.get(a.id) ?? {
        netPnl: [],
        sharpe: [],
        revert: [],
        included: [],
      };
      acc.netPnl.push(a.netPnlUsdc);
      const s = sharpeRatio(values.get(a.id) ?? []);
      if (s !== null) acc.sharpe.push(s);
      acc.revert.push(a.revertCount);
      acc.included.push(a.includedTxCount);
      byAgent.set(a.id, acc);
    }
  }

  return { byAgent, perSeedRuns };
}

// SEEDS env のパース(evaluate / discrimination 共通)。
export function parseSeeds(
  value: string | undefined,
  fallback: string,
): number[] {
  const seeds = (value ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (seeds.length === 0 || seeds.some((s) => !Number.isInteger(s))) {
    throw new Error(`invalid SEEDS: ${value}`);
  }
  return seeds;
}
