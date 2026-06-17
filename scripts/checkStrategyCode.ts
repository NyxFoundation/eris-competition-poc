// checkStrategyCode: 戦略コードの cheatcode 静的検査 CLI（ADR 0006 §5）。
// /strategy-evolve がコード編集を伴う変更を受理する前に必ず通す入口ゲート。
//
// 使い方:
//   tsx scripts/checkStrategyCode.ts [files...]   # 省略時は examples/agents/ 直下の全戦略
//
// 出力: 検出結果 JSON を stdout、人間向けサマリを stderr。exit code: PASS=0 / 検出=2 / エラー=1。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  findCheatcodeUsage,
  type StaticCheckFinding,
} from "../src/strategyStaticCheck.js";

function defaultTargets(): string[] {
  const dir = "examples/agents";
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => statSync(p).isFile() && p.endsWith(".ts"));
}

function main(): void {
  const files = process.argv.slice(2);
  const targets = files.length > 0 ? files : defaultTargets();
  const results: Array<{ file: string; findings: StaticCheckFinding[] }> = [];
  for (const file of targets) {
    const findings = findCheatcodeUsage(readFileSync(file, "utf8"));
    if (findings.length > 0) results.push({ file, findings });
  }

  process.stdout.write(
    `${JSON.stringify({ pass: results.length === 0, checkedFiles: targets.length, results }, null, 2)}\n`,
  );
  if (results.length === 0) {
    console.error(`[static-check] PASS (${targets.length} files)`);
    return;
  }
  for (const r of results) {
    for (const f of r.findings) {
      console.error(
        `[static-check] ${r.file}:${f.line} ${f.rule}: \`${f.match}\``,
      );
    }
  }
  console.error(
    "[static-check] FAIL — cheatcode/特権ヘルパの使用を検出。戦略コードから除去すること(ADR 0006 §5)。",
  );
  process.exitCode = 2;
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
