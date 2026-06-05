// 識別力(discrimination power)判定 CLI（ADR 0001 P1）。
// 多様な戦略 + ベースライン(noop/random)を多 seed で実走し、3 条件を判定する:
//   C1 実力報酬 / C2 順位安定 / C3 risk 非潰れ
// evaluate.ts(過学習ゲート)とは別物: こちらは「環境に識別力があるか」を見る。
//
// リスク調整リターンは information ratio(noop 比の超過リターン Sharpe)を優先する
// （総リターン Sharpe は共有 ETH ベータに支配され全員潰れるため）。
//
// 使い方（要 npm run anvil）:
//   SEEDS=1,2,3 ROUNDS=128 AGENTS_CONFIG=agents.p1.json npm run discrimination
//
// 既存 run の再判定(再シミュレーション無し。しきい値や metric を変えて試すとき):
//   DISC_FROM_RUNS=runs/<dir1>,runs/<dir2>,... npm run discrimination
//
// baseline の解決: ロスターの "baseline": true、無ければ env BASELINE_IDS=noop,random。
// benchmark(超過リターンの基準): env DISC_BENCHMARK_ID、無ければ noop、無ければ最初の baseline。
// しきい値は env で上書き可（既定は暫定。ADR: しきい値は P1 データを見て確定）:
//   DISC_PNL_MARGIN / DISC_SHARPE_MARGIN / DISC_MIN_BEAT_FRACTION
//   DISC_MIN_SPEARMAN / DISC_MAX_GAP_CV / DISC_MIN_SHARPE_SPREAD
//
// 出力: JSON を stdout、人間向け markdown を runs/<latest>/discrimination.md に。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAgents } from "../src/config.js";
import {
  aggregateAgents,
  computeVerdict,
  DEFAULT_THRESHOLDS,
  type AgentAggregate,
  type DiscriminationThresholds,
  type DiscriminationVerdict,
} from "../src/discrimination.js";
import {
  collectMultiSeedStats,
  parseSeeds,
  statsFromRunDirs,
} from "../src/multiSeedRun.js";

process.env.ROUNDS ??= "128";
process.env.AGENTS_CONFIG ??= "agents.p1.json";

function numEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`expected number env value, got ${value}`);
  return parsed;
}

function thresholdsFromEnv(): DiscriminationThresholds {
  return {
    pnlMargin: numEnv(
      process.env.DISC_PNL_MARGIN,
      DEFAULT_THRESHOLDS.pnlMargin,
    ),
    sharpeMargin: numEnv(
      process.env.DISC_SHARPE_MARGIN,
      DEFAULT_THRESHOLDS.sharpeMargin,
    ),
    minBeatFraction: numEnv(
      process.env.DISC_MIN_BEAT_FRACTION,
      DEFAULT_THRESHOLDS.minBeatFraction,
    ),
    minSpearman: numEnv(
      process.env.DISC_MIN_SPEARMAN,
      DEFAULT_THRESHOLDS.minSpearman,
    ),
    maxGapCv: numEnv(process.env.DISC_MAX_GAP_CV, DEFAULT_THRESHOLDS.maxGapCv),
    minSharpeSpread: numEnv(
      process.env.DISC_MIN_SHARPE_SPREAD,
      DEFAULT_THRESHOLDS.minSharpeSpread,
    ),
  };
}

// baseline の id 集合を解決。env BASELINE_IDS が最優先、無ければロスターの baseline:true。
function resolveBaselineIds(configPath: string): Set<string> {
  const fromEnv = (process.env.BASELINE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return new Set(fromEnv);
  return new Set(
    loadAgents(configPath)
      .filter((a) => a.baseline)
      .map((a) => a.id),
  );
}

// 超過リターンの基準 agent。env DISC_BENCHMARK_ID > noop > 最初の baseline。
function resolveBenchmarkId(baselineIds: Set<string>): string | undefined {
  const env = process.env.DISC_BENCHMARK_ID?.trim();
  if (env) return env;
  if (baselineIds.has("noop")) return "noop";
  return [...baselineIds][0];
}

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const configPath = process.env.AGENTS_CONFIG as string;
  const baselineIds = resolveBaselineIds(configPath);
  const benchmarkId = resolveBenchmarkId(baselineIds);
  if (baselineIds.size === 0) {
    console.error(
      '[discrimination] warning: baseline agent が無い（ロスターで "baseline": true か env BASELINE_IDS を指定）。C1 は評価不能。',
    );
  }
  if (!benchmarkId) {
    console.error(
      "[discrimination] warning: benchmark agent が無い → 総リターン Sharpe にフォールバック（ベータ汚染あり）。",
    );
  }

  const fromRuns = splitEnvList(process.env.DISC_FROM_RUNS);
  const { byAgent, perSeedRuns } = fromRuns.length
    ? (console.error(
        `[discrimination] offline: 既存 ${fromRuns.length} run を再判定（benchmark=${benchmarkId ?? "none"}）`,
      ),
      statsFromRunDirs(fromRuns, benchmarkId))
    : await collectMultiSeedStats(
        parseSeeds(process.env.SEEDS, "1,2,3"),
        benchmarkId,
      );

  const seeds = perSeedRuns.map((r) => r.seed);
  const agents = aggregateAgents(byAgent);
  const thresholds = thresholdsFromEnv();
  const verdict = computeVerdict(agents, baselineIds, thresholds);

  const md = renderMarkdown(verdict, agents, baselineIds, seeds, configPath);
  const latest = perSeedRuns.at(-1)?.runDir;
  if (latest) {
    const outPath = join(latest, "discrimination.md");
    writeFileSync(outPath, md);
    console.error(`[discrimination] wrote ${outPath}`);
  }
  console.error(
    `[discrimination] verdict: ${verdict.pass ? "PASS" : "FAIL"} (C1=${ok(verdict.c1.pass)} C2=${ok(verdict.c2.pass)} C3=${ok(verdict.c3.pass)}) metric=${verdict.riskMetric}`,
  );

  const out = {
    seeds,
    rounds: Number(process.env.ROUNDS),
    agentsConfig: configPath,
    benchmarkId: benchmarkId ?? null,
    forkBlock: process.env.FORK_BLOCK_NUMBER ?? null,
    enabledProtocols: process.env.ENABLED_PROTOCOLS ?? null,
    perSeedRuns,
    verdict,
    agents,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

// --- markdown ---

function ok(pass: boolean): string {
  return pass ? "PASS" : "FAIL";
}
function num(n: number | null, digits = 2): string {
  return n === null ? "N/A" : n.toFixed(digits);
}
function metricLabel(m: DiscriminationVerdict["riskMetric"]): string {
  return m === "infoRatio"
    ? "information ratio（noop 比の超過リターン Sharpe）"
    : "総リターン Sharpe（ベータ汚染あり）";
}

function renderMarkdown(
  v: DiscriminationVerdict,
  agents: AgentAggregate[],
  baselineIds: Set<string>,
  seeds: number[],
  configPath: string,
): string {
  const t = v.thresholds;
  const lines: string[] = [];
  lines.push(`# 識別力レポート — ${configPath}`);
  lines.push("");
  lines.push(
    `**判定: ${v.pass ? "✅ PASS" : "❌ FAIL"}**  (seeds=${seeds.join(",")}, rounds=${process.env.ROUNDS})`,
  );
  lines.push("");
  lines.push(`リスク調整 metric: **${metricLabel(v.riskMetric)}**`);
  lines.push("");
  lines.push(
    `| 条件 | 結果 |\n|---|---|\n| C1 実力報酬 | ${ok(v.c1.pass)} |\n| C2 順位安定 | ${ok(v.c2.pass)} |\n| C3 risk 非潰れ | ${ok(v.c3.pass)} |`,
  );
  lines.push("");

  // ロスター（Sharpe(total) と IR(excess) を併記）
  lines.push("## ロスター（リスク調整 metric 降順）");
  lines.push("");
  lines.push(
    "| # | agent | 役割 | PnL median | PnL min | winRate | Sharpe(total) | IR(excess) |",
  );
  lines.push("|---:|---|---|---:|---:|---:|---:|---:|");
  agents.forEach((a, i) => {
    const role = baselineIds.has(a.id) ? "baseline" : "strategy";
    lines.push(
      `| ${i + 1} | ${a.id} | ${role} | ${a.netPnl.median.toFixed(2)} | ${a.netPnl.min.toFixed(2)} | ${(a.netPnl.winRate * 100).toFixed(0)}% | ${num(a.sharpe.median, 3)} | ${num(a.infoRatio.median, 3)} |`,
    );
  });
  lines.push("");

  // C1
  lines.push(`## C1 実力報酬 — ${ok(v.c1.pass)}`);
  lines.push("");
  lines.push(
    `最強 baseline: PnL median=${num(v.c1.bestBaselinePnlMedian)}, ${v.riskMetric} median=${num(v.c1.bestBaselineRiskMedian, 3)} / margin: pnl≥${t.pnlMargin}, risk≥${t.sharpeMargin}, beatFraction≥${t.minBeatFraction}（実測 ${(v.c1.beatFraction * 100).toFixed(0)}%）`,
  );
  lines.push("");
  lines.push(
    "| 戦略 | PnL median | PnL gap | Sharpe(total) | IR(excess) | risk gap | baseline 超え |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|:---:|");
  for (const r of v.c1.strategies) {
    lines.push(
      `| ${r.id} | ${r.pnlMedian.toFixed(2)} | ${r.pnlGap.toFixed(2)} | ${num(r.sharpeMedian, 3)} | ${num(r.infoRatioMedian, 3)} | ${num(r.riskGap, 3)} | ${r.beats ? "✓" : "✗"} |`,
    );
  }
  lines.push("");

  // C2
  lines.push(`## C2 順位安定 — ${ok(v.c2.pass)}`);
  lines.push("");
  lines.push(
    `平均 Spearman=${num(v.c2.meanSpearman, 3)}（≥${t.minSpearman} で合格） / gap CV=${num(v.c2.gapCv, 3)}（≤${t.maxGapCv} で合格） / seeds=${v.c2.seeds}`,
  );
  lines.push("");
  lines.push(
    `seed 別 top-bottom gap: ${v.c2.perSeedTopBottomGap.map((g) => g.toFixed(0)).join(", ")}`,
  );
  lines.push("");

  // C3
  lines.push(`## C3 risk 非潰れ — ${ok(v.c3.pass)}`);
  lines.push("");
  lines.push(
    `${v.c3.riskMetric} spread (max-min)=${num(v.c3.sharpeSpread, 3)}（>${t.minSharpeSpread} で合格） / max=${num(v.c3.maxSharpe, 3)}, min=${num(v.c3.minSharpe, 3)}`,
  );
  lines.push("");

  // hints
  if (v.hints.length) {
    lines.push("## 改善示唆（sim-loop で 1 課題ずつ）");
    lines.push("");
    for (const h of v.hints) lines.push(`- ${h}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
