// evaluate: 複数 SEED で sim を回し、agent ごとに seed 横断の集計統計を出す。
// strategy-evolve の「過学習ゲート」本体。
//
// 各 SEED は市場(fair price + flow bot)を決定論的に固定する（flowSeed 既定 = SEED, config.ts）。
// → 同一 SEED の before-run / after-run は同一市場を見るので、戦略変更の差分だけが測れる。
// → SEED をまたぐと別の市場シナリオになるので、1 seed だけで勝つ過学習を検出できる。
// 単一 seed で勝っても他 seed で負ける変更を弾くため、median だけでなく
// min(最悪 seed) と win-rate(正 PnL の seed 数) を出す。Sharpe は leaderboard と
// 共有モジュール(src/perRoundValues.ts)で一貫させる。
//
// 使い方:
//   SEEDS=1,2,3,4,5 ROUNDS=128 AGENTS_CONFIG=agents.evolve.json npm run evaluate
//
// 出力: 1 つの JSON オブジェクトを stdout に。git 追跡ファイルには書かない。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runSimulation } from "../src/coordinator.js";
import { loadConfig } from "../src/config.js";
import {
  latestRunDir,
  readPerRoundValues,
  sharpeRatio,
} from "../src/perRoundValues.js";

process.env.ROUNDS ??= "128";
process.env.AGENTS_CONFIG ??= "agents.evolve.json";

type SummaryAgent = {
  id: string;
  netPnlUsdc: number;
  revertCount: number;
  includedTxCount: number;
};

type Summary = {
  runId: string;
  rounds: number;
  agents: SummaryAgent[];
};

type AgentAcc = {
  netPnl: number[];
  sharpe: number[];
  revert: number[];
  included: number[];
};

async function main(): Promise<void> {
  const seeds = (process.env.SEEDS ?? "1,2,3,4,5")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (seeds.length === 0 || seeds.some((s) => !Number.isInteger(s))) {
    throw new Error(`invalid SEEDS: ${process.env.SEEDS}`);
  }
  const runDirRoot = loadConfig().runDirRoot;
  const byAgent = new Map<string, AgentAcc>();

  for (const seed of seeds) {
    process.env.SEED = String(seed);
    console.error(`[evaluate] seed=${seed} running simulation...`);
    await runSimulation();
    const runDir = latestRunDir(runDirRoot, true);
    const summary = JSON.parse(
      readFileSync(join(runDir, "summary.json"), "utf8"),
    ) as Summary;
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

  const agents = [...byAgent.entries()]
    .map(([id, acc]) => ({
      id,
      netPnl: {
        perSeed: acc.netPnl,
        median: median(acc.netPnl),
        mean: mean(acc.netPnl),
        min: Math.min(...acc.netPnl),
        stdev: stdev(acc.netPnl),
        winRate: acc.netPnl.filter((v) => v > 0).length / acc.netPnl.length,
      },
      sharpe: {
        perSeed: acc.sharpe,
        median: acc.sharpe.length ? median(acc.sharpe) : null,
        mean: acc.sharpe.length ? mean(acc.sharpe) : null,
      },
      revertTotal: sum(acc.revert),
      includedTotal: sum(acc.included),
    }))
    .sort(
      (a, b) =>
        (b.sharpe.median ?? -Infinity) - (a.sharpe.median ?? -Infinity) ||
        b.netPnl.median - a.netPnl.median,
    );

  const out = {
    seeds,
    rounds: Number(process.env.ROUNDS),
    agentsConfig: process.env.AGENTS_CONFIG,
    agents,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

// --- 集計ヘルパー ---
function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
