// stress 評価レポート CLI（ADR 0009 §5）。読取専用・採点に干渉しない。
//
// 1 つの完了済み run dir（events.jsonl / blocks.csv）から stress 指標を抽出し、
// runs/<id>/stress.md（人間向け）と stress.json（機械可読）を書き、要約を stdout に出す。
// reconstruct のコアは無改修で再利用する（観測 reconstructed observation を入力に取るだけ）。
//
// 使い方:
//   npm run stress-report -- --run-dir runs/<id>   # 明示指定
//   npm run stress-report                           # ./runs 配下の最新 run を採用
//   npm run stress-report -- --report-dir <root>    # runs ルートを変える
//
// stress run の作り方（例）は eris.config.yaml の stress セクション + sim:realtime を参照。
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  buildStressReport,
  parseStressRun,
  renderStressMarkdown,
} from "../src/stressMetrics.js";
import { safeStringify } from "../src/logger.js";
import { parseCliFlags } from "../src/runConfig.js";

// agents/<id>.jsonl を agentId → 行配列で読む（liquidator 帰属の一次情報。ADR 0009 §6）。
function readAgentLogs(agentsDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!existsSync(agentsDir) || !statSync(agentsDir).isDirectory()) return out;
  for (const f of readdirSync(agentsDir)) {
    if (!f.endsWith(".jsonl")) continue;
    const agentId = f.replace(/\.jsonl$/, "");
    out.set(agentId, readFileSync(join(agentsDir, f), "utf8").split("\n"));
  }
  return out;
}

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
  // 解析対象は CLI フラグで指定（env 退役）: --report-dir <root> / --run-dir <dir>。
  const flags = parseCliFlags();
  const runsRoot = flags["report-dir"] ?? "./runs";
  const runDir = flags["run-dir"] ?? latestRunDir(runsRoot);
  if (!runDir || !existsSync(join(runDir, "events.jsonl"))) {
    console.error(
      `no run dir with events.jsonl found (pass --run-dir or run a sim first). runsRoot=${runsRoot}`,
    );
    process.exit(1);
  }

  const eventsLines = readFileSync(join(runDir, "events.jsonl"), "utf8").split(
    "\n",
  );
  const blocksCsv = existsSync(join(runDir, "blocks.csv"))
    ? readFileSync(join(runDir, "blocks.csv"), "utf8")
    : "";
  const agentLogs = readAgentLogs(join(runDir, "agents"));

  const run = parseStressRun(eventsLines, blocksCsv, agentLogs);
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
