// stress 評価レポート CLI（ADR 0009 §5）。読取専用・採点に干渉しない。
//
// 1 つの完了済み run dir（events.jsonl / blocks.csv）から stress 指標を抽出し、
// runs/<id>/stress.md（人間向け）と stress.json（機械可読）を書き、要約を stdout に出す。
// reconstruct のコアは無改修で再利用する（観測 reconstructed observation を入力に取るだけ）。
//
// 使い方:
//   RUN_DIR=runs/<id> npm run stress-report     # 明示指定
//   npm run stress-report                        # ./runs 配下の最新 run を採用
//
// 環境（stress run の例。要 ARB_RPC_URL で full re-fork）:
//   ARB_RPC_URL=... ERIS_RUN_BLOCKS=80 \
//   ERIS_STRESS_EVENTS='[{"type":"crash","magnitudeRange":[0.06,0.10],"windowFrac":[0.3,0.7],"rampBlocks":3,"holdBlocks":6,"decayBlocks":8}]' \
//   ERIS_STRESS_VICTIM_COUNT=3 AGENTS_CONFIG=agents.local.json npm run sim:realtime
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildStressReport,
  parseStressRun,
  renderStressMarkdown,
} from "../src/stressMetrics.js";
import { safeStringify } from "../src/logger.js";

function latestRunDir(runsDir: string): string | null {
  if (!existsSync(runsDir)) return null;
  const dirs = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(runsDir, name, "events.jsonl")))
    .sort(); // runId は ISO タイムスタンプ由来 → 辞書順 = 時系列順
  return dirs.length ? join(runsDir, dirs[dirs.length - 1]) : null;
}

function main(): void {
  const runsRoot = process.env.REPORT_DIR ?? "./runs";
  const runDir = process.env.RUN_DIR ?? latestRunDir(runsRoot);
  if (!runDir || !existsSync(join(runDir, "events.jsonl"))) {
    console.error(
      `no run dir with events.jsonl found (set RUN_DIR or run a sim first). runsRoot=${runsRoot}`,
    );
    process.exit(1);
  }

  const eventsLines = readFileSync(join(runDir, "events.jsonl"), "utf8").split(
    "\n",
  );
  const blocksCsv = existsSync(join(runDir, "blocks.csv"))
    ? readFileSync(join(runDir, "blocks.csv"), "utf8")
    : "";

  const run = parseStressRun(eventsLines, blocksCsv);
  if (run.schedule.length === 0) {
    console.error(
      `[stress-report] ${runDir} に stress_schedule がありません（ERIS_STRESS_EVENTS 無しの run）。指標は出ますが event 依存の値は空になります。`,
    );
  }
  const report = buildStressReport(run);

  const md = renderStressMarkdown(report);
  writeFileSync(join(runDir, "stress.md"), md);
  writeFileSync(join(runDir, "stress.json"), `${safeStringify(report, 2)}\n`);

  // stdout 要約
  const liquidatedVictims = report.victims.filter(
    (v) => v.liquidatedBlock !== null,
  ).length;
  console.log(`stress report written: ${join(runDir, "stress.md")}`);
  console.log(
    `  events=${report.schedule.length} victims=${report.victims.length} liquidated=${liquidatedVictims} liquidators=${report.liquidators.length}`,
  );
  if (report.competitors.length > 0) {
    const worst = report.competitors.reduce((m, c) =>
      c.maxDrawdownPct > m.maxDrawdownPct ? c : m,
    );
    console.log(
      `  worst drawdown: ${worst.agentId} ${(worst.maxDrawdownPct * 100).toFixed(1)}% (survived=${worst.survived})`,
    );
  }
}

main();
