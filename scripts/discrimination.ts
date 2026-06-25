// 識別力(discrimination power)判定 CLI（ADR 0001 P1 / ADR 0005 で反復読み替え）。
// 多様な戦略 + ベースライン(noop/random)を regime × N 回の実時間反復で実走し、3 条件を判定する:
//   C1 実力報酬（bootstrap CI 有意性つき） / C2 順位安定（regime 間） / C3 risk 非潰れ
// evaluate.ts(unpaired ゲートのサンプル収集)とは別物: こちらは「環境に識別力があるか」を見る。
//
// リスク調整リターンは information ratio(noop 比の超過リターン Sharpe)を優先する
// （総リターン Sharpe は共有 ETH ベータに支配され全員潰れるため）。
//
// C2 は「市場(regime)が変わっても同じ agent が勝つか」を測る。regime 内の反復は
// 代表値(median PnL)へ畳んでから順位相関に渡す。単一 regime 構成では C2 は参考値
// （pass 判定から除外）になる（ADR 0005 §2）。
//
// 使い方（要 npm run anvil）:
//   REGIMES=1,2,3 REPLICATIONS=5 ERIS_RUN_BLOCKS=60 AGENTS_CONFIG=agents.p1.json npm run discrimination
//
// 既存 run の再判定(再シミュレーション無し。しきい値や metric を変えて試すとき):
//   DISC_FROM_RUNS=runs/<dir1>,runs/<dir2>,... npm run discrimination
//   DISC_FROM_RUNS_REGIMES=1,1,2,2  … 各 dir の regime ラベル(省略時は各 run を独立 regime 扱い)
//
// baseline の解決: ロスターの "baseline": true、無ければ env BASELINE_IDS=noop,random。
// benchmark(超過リターンの基準): env DISC_BENCHMARK_ID、無ければ noop、無ければ最初の baseline。
// しきい値は env で上書き可（既定は暫定。ADR: しきい値は実測データを見て確定）:
//   DISC_PNL_MARGIN / DISC_SHARPE_MARGIN / DISC_MIN_BEAT_FRACTION
//   DISC_C1_CI_LEVEL / DISC_BOOTSTRAP_ITERS
//   DISC_MIN_SPEARMAN / DISC_MAX_GAP_CV / DISC_MIN_SHARPE_SPREAD
//
// 出力: JSON を stdout、人間向け markdown を runs/<latest>/discrimination.md に。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSpec } from "../src/types.js";
import {
  loadConfigDoc,
  parseCliFlags,
  resolveRunInputs,
} from "../src/runConfig.js";
import {
  aggregateAgents,
  collapseNetPnlByRegime,
  computeVerdict,
  DEFAULT_THRESHOLDS,
  type AgentAggregate,
  type DiscriminationThresholds,
  type DiscriminationVerdict,
} from "../src/discrimination.js";
import {
  collectReplicationStats,
  parseRegimes,
  statsFromRunDirs,
} from "../src/multiSeedRun.js";

// しきい値・パラメータは eris.config.yaml の `discrimination:` セクション + CLI フラグで指定（env 退役）。
// 優先順位: CLI フラグ > YAML セクション > 既定。
type Params = Record<string, unknown>;
type Flags = Record<string, string>;

function num(
  section: Params,
  flags: Flags,
  key: string,
  fallback: number,
): number {
  const raw = flags[key] ?? section[key];
  if (raw === undefined || raw === null || String(raw).trim() === "")
    return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed))
    throw new Error(`expected number for ${key}, got ${raw}`);
  return parsed;
}

function posInt(
  section: Params,
  flags: Flags,
  key: string,
  fallback: number,
): number {
  const raw = flags[key] ?? section[key];
  if (raw === undefined || raw === null || String(raw).trim() === "")
    return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`expected positive integer for ${key}, got ${raw}`);
  return parsed;
}

function asList(raw: unknown): string[] {
  if (Array.isArray(raw))
    return raw.map((s) => String(s).trim()).filter(Boolean);
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function thresholdsFrom(
  section: Params,
  flags: Flags,
): DiscriminationThresholds {
  return {
    pnlMargin: num(section, flags, "pnlMargin", DEFAULT_THRESHOLDS.pnlMargin),
    sharpeMargin: num(
      section,
      flags,
      "sharpeMargin",
      DEFAULT_THRESHOLDS.sharpeMargin,
    ),
    minBeatFraction: num(
      section,
      flags,
      "minBeatFraction",
      DEFAULT_THRESHOLDS.minBeatFraction,
    ),
    c1CiLevel: num(section, flags, "c1CiLevel", DEFAULT_THRESHOLDS.c1CiLevel),
    bootstrapIterations: num(
      section,
      flags,
      "bootstrapIterations",
      DEFAULT_THRESHOLDS.bootstrapIterations,
    ),
    // c1Paired=0 で unpaired にロールバック（既定は paired = run 内同一市場の対）。
    c1Paired: String(flags.c1Paired ?? section.c1Paired ?? "1").trim() !== "0",
    minSpearman: num(
      section,
      flags,
      "minSpearman",
      DEFAULT_THRESHOLDS.minSpearman,
    ),
    maxGapCv: num(section, flags, "maxGapCv", DEFAULT_THRESHOLDS.maxGapCv),
    minSharpeSpread: num(
      section,
      flags,
      "minSharpeSpread",
      DEFAULT_THRESHOLDS.minSharpeSpread,
    ),
  };
}

// baseline の id 集合を解決。baselineIds 指定が最優先、無ければロスターの baseline:true。
function resolveBaselineIds(
  agents: AgentSpec[],
  section: Params,
  flags: Flags,
): Set<string> {
  const explicit = asList(flags.baselineIds ?? section.baselineIds);
  if (explicit.length) return new Set(explicit);
  return new Set(agents.filter((a) => a.baseline).map((a) => a.id));
}

// 超過リターンの基準 agent。benchmarkId 指定 > noop > 最初の baseline。
function resolveBenchmarkId(
  baselineIds: Set<string>,
  section: Params,
  flags: Flags,
): string | undefined {
  const explicit = (
    flags.benchmarkId ?? (section.benchmarkId as string | undefined)
  )?.trim();
  if (explicit) return explicit;
  if (baselineIds.has("noop")) return "noop";
  return [...baselineIds][0];
}

async function main(): Promise<void> {
  // 設定・ロスターは YAML（eris.config.yaml）を単一ソースに解決。判定パラメータは
  // `discrimination:` セクション + CLI フラグ。
  const { config, agents: roster } = resolveRunInputs();
  const flags = parseCliFlags();
  const section = (loadConfigDoc().discrimination ?? {}) as Params;
  const configPath = config.agentsConfigPath;
  const baselineIds = resolveBaselineIds(roster, section, flags);
  const benchmarkId = resolveBenchmarkId(baselineIds, section, flags);
  if (baselineIds.size === 0) {
    console.error(
      '[discrimination] warning: baseline agent が無い（ロスターで "baseline": true か baselineIds 指定）。C1 は評価不能。',
    );
  }
  if (!benchmarkId) {
    console.error(
      "[discrimination] warning: benchmark agent が無い → 総リターン Sharpe にフォールバック（ベータ汚染あり）。",
    );
  }

  const fromRuns = asList(flags.fromRuns ?? section.fromRuns);
  const replications = posInt(section, flags, "replications", 5);
  const fromRunsRegimes = flags.fromRunsRegimes ?? section.fromRunsRegimes;
  const regimesRaw =
    flags.regimes ??
    (Array.isArray(section.regimes)
      ? section.regimes.join(",")
      : (section.regimes as string | undefined));
  const { byAgent, runs } = fromRuns.length
    ? (console.error(
        `[discrimination] offline: 既存 ${fromRuns.length} run を再判定（benchmark=${benchmarkId ?? "none"}）`,
      ),
      statsFromRunDirs(
        fromRuns,
        benchmarkId,
        fromRunsRegimes ? parseRegimes(String(fromRunsRegimes), "") : undefined,
      ))
    : await collectReplicationStats(
        // C2 は複数 regime を必須とする（同一 regime だけ反復すると C2 が
        // タイミングノイズ耐性に化ける。ADR 0005 §2）。
        parseRegimes(regimesRaw, "1,2,3"),
        replications,
        benchmarkId,
      );

  const regimeOf = runs.map((r) => r.regime);
  const regimes = [...new Set(regimeOf)];
  if (regimes.length < 2) {
    console.error(
      "[discrimination] warning: 単一 regime 構成 → C2 は参考値（pass 判定から除外）。恒久判定は REGIMES を複数指定する。",
    );
  }
  const agents = aggregateAgents(byAgent);
  // C2 用: regime 内の反復を代表値(median PnL)へ畳み、各スロット = 1 regime にする。
  const rankAgents = aggregateAgents(collapseNetPnlByRegime(byAgent, regimeOf));
  const thresholds = thresholdsFrom(section, flags);
  const verdict = computeVerdict(agents, baselineIds, thresholds, {
    rankAgents,
    regimeCount: regimes.length,
  });

  const md = renderMarkdown(
    verdict,
    agents,
    baselineIds,
    runs.length,
    regimes,
    configPath,
  );
  const latest = runs.at(-1)?.runDir;
  if (latest) {
    const outPath = join(latest, "discrimination.md");
    writeFileSync(outPath, md);
    console.error(`[discrimination] wrote ${outPath}`);
  }
  console.error(
    `[discrimination] verdict: ${verdict.pass ? "PASS" : "FAIL"} (C1=${ok(verdict.c1.pass)} C2=${verdict.c2Skipped ? "SKIP" : ok(verdict.c2.pass)} C3=${ok(verdict.c3.pass)}) metric=${verdict.riskMetric}`,
  );

  const out = {
    regimes,
    replications,
    runBlocks: config.runBlocks,
    agentsConfig: configPath,
    benchmarkId: benchmarkId ?? null,
    forkBlock: config.forkBlockNumber ?? null,
    enabledProtocols: config.enabledProtocols.join(","),
    runs,
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
  runCount: number,
  regimes: number[],
  configPath: string,
): string {
  const t = v.thresholds;
  const lines: string[] = [];
  lines.push(`# 識別力レポート — ${configPath}`);
  lines.push("");
  lines.push(
    `**判定: ${v.pass ? "✅ PASS" : "❌ FAIL"}**  (regimes=${regimes.join(",")}, runs=${runCount}, runBlocks=${process.env.ERIS_RUN_BLOCKS})`,
  );
  lines.push("");
  lines.push(`リスク調整 metric: **${metricLabel(v.riskMetric)}**`);
  lines.push("");
  lines.push(
    `| 条件 | 結果 |\n|---|---|\n| C1 実力報酬 | ${ok(v.c1.pass)} |\n| C2 順位安定（regime 間） | ${v.c2Skipped ? "SKIP（単一 regime: 参考値）" : ok(v.c2.pass)} |\n| C3 risk 非潰れ | ${ok(v.c3.pass)} |`,
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
    `最強 baseline: PnL median=${num(v.c1.bestBaselinePnlMedian)}, ${v.riskMetric} median=${num(v.c1.bestBaselineRiskMedian, 3)} / margin: pnl≥${t.pnlMargin}, risk≥${t.sharpeMargin}, beatFraction≥${t.minBeatFraction}（実測 ${(v.c1.beatFraction * 100).toFixed(0)}%） / 有意性: 超過の bootstrap CI(${(v.c1.ciLevel * 100).toFixed(0)}%) 下限 > 0 を必須（ADR 0005）。CI 法: **${v.c1.paired ? "paired（run 内＝同一市場の対。同一 run で並走した agent 間は同一ドローなので高検出力）" : "unpaired（run 整列できず周辺分布を独立抽出）"}**`,
  );
  lines.push("");
  lines.push(
    "| 戦略 | PnL median | PnL gap | PnL CI 下限 | Sharpe(total) | IR(excess) | risk gap | risk CI 下限 | baseline 超え |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|:---:|");
  for (const r of v.c1.strategies) {
    lines.push(
      `| ${r.id} | ${r.pnlMedian.toFixed(2)} | ${r.pnlGap.toFixed(2)} | ${num(r.pnlCiLow)} | ${num(r.sharpeMedian, 3)} | ${num(r.infoRatioMedian, 3)} | ${num(r.riskGap, 3)} | ${num(r.riskCiLow, 3)} | ${r.beats ? "✓" : "✗"} |`,
    );
  }
  lines.push("");

  // C2
  lines.push(
    `## C2 順位安定（regime 間） — ${v.c2Skipped ? "SKIP（単一 regime: 参考値）" : ok(v.c2.pass)}`,
  );
  lines.push("");
  lines.push(
    `平均 Spearman=${num(v.c2.meanSpearman, 3)}（≥${t.minSpearman} で合格） / gap CV=${num(v.c2.gapCv, 3)}（≤${t.maxGapCv} で合格） / regimes=${v.c2.regimes}（regime 内反復は median PnL の代表ランクへ畳み済み）`,
  );
  lines.push("");
  lines.push(
    `regime 別 top-bottom gap: ${v.c2.perRegimeTopBottomGap.map((g) => g.toFixed(0)).join(", ")}`,
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
