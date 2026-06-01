import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSimulation } from "../src/coordinator.js";
import { loadAgents, loadConfig } from "../src/config.js";
import {
  latestRunDir,
  readPerRoundValues,
  sharpeRatio,
} from "../src/perRoundValues.js";

process.env.ROUNDS ??= "128";
process.env.AGENTS_CONFIG ??= "agents.leaderboard.json";

type SummaryAgent = {
  id: string;
  initialValueUsdc: number;
  finalValueUsdc: number;
  netPnlUsdc: number;
  revertCount: number;
  submittedTxCount: number;
  includedTxCount: number;
};

type Summary = {
  runId: string;
  rounds: number;
  finalFairPriceUsdcPerWeth: number;
  agents: SummaryAgent[];
};

type Row = {
  rank: number;
  id: string;
  description: string;
  netPnlUsdc: number;
  sharpe: number | null;
  initialValueUsdc: number;
  finalValueUsdc: number;
  revertCount: number;
};

async function main(): Promise<void> {
  const config = loadConfig();
  const runDirRoot = config.runDirRoot;

  console.log(
    `[leaderboard] starting simulation: rounds=${config.rounds} agents=${config.agentsConfigPath}`,
  );
  await runSimulation();

  const runDir = latestRunDir(runDirRoot);
  console.log(`[leaderboard] aggregating results from ${runDir}`);

  const summary = JSON.parse(
    readFileSync(join(runDir, "summary.json"), "utf8"),
  ) as Summary;
  const valuesByAgent = readPerRoundValues(join(runDir, "events.jsonl"));
  const descriptions = readDescriptions(config.agentsConfigPath);

  const rows = summary.agents
    .map((agent): Row => {
      const series = valuesByAgent.get(agent.id) ?? [];
      return {
        rank: 0,
        id: agent.id,
        description: descriptions.get(agent.id) ?? "(no description)",
        netPnlUsdc: agent.netPnlUsdc,
        sharpe: sharpeRatio(series),
        initialValueUsdc: agent.initialValueUsdc,
        finalValueUsdc: agent.finalValueUsdc,
        revertCount: agent.revertCount,
      };
    })
    .sort(compareRows)
    .map((row, idx) => ({ ...row, rank: idx + 1 }));

  const md = renderMarkdown(summary, rows);
  const outPath = join(runDir, "leaderboard.md");
  writeFileSync(outPath, md);
  console.log(`\n${md}`);
  console.log(`[leaderboard] wrote ${outPath}`);
}

function readDescriptions(path: string): Map<string, string> {
  const map = new Map<string, string>();
  const agents = loadAgents(path);
  for (const a of agents) {
    if (a.description) map.set(a.id, a.description);
  }
  return map;
}

function compareRows(a: Row, b: Row): number {
  const sa = a.sharpe;
  const sb = b.sharpe;
  if (sa !== null && sb !== null && sa !== sb) return sb - sa;
  if (sa !== null && sb === null) return -1;
  if (sa === null && sb !== null) return 1;
  return b.netPnlUsdc - a.netPnlUsdc;
}

function renderMarkdown(summary: Summary, rows: Row[]): string {
  const header = `# Leaderboard — ${summary.runId} (${summary.rounds} rounds)\n\n`;
  const cols =
    "| Rank | Agent | 戦略概要 | Net PnL (USDC) | Sharpe | Initial → Final (USDC) | Reverts |\n";
  const sep = "|---:|---|---|---:|---:|---|---:|\n";
  const body = rows
    .map((r) => {
      const pnl = formatSigned(r.netPnlUsdc, 2);
      const sharpe = r.sharpe === null ? "N/A" : r.sharpe.toFixed(3);
      const initFinal = `${formatNumber(r.initialValueUsdc, 2)} → ${formatNumber(r.finalValueUsdc, 2)}`;
      return `| ${r.rank} | ${r.id} | ${r.description} | ${pnl} | ${sharpe} | ${initFinal} | ${r.revertCount} |`;
    })
    .join("\n");
  return `${header}${cols}${sep}${body}\n`;
}

function formatNumber(n: number, digits: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatSigned(n: number, digits: number): string {
  const formatted = formatNumber(Math.abs(n), digits);
  if (n > 0) return `+${formatted}`;
  if (n < 0) return `-${formatted}`;
  return formatted;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
