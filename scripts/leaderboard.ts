import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSimulation } from "../src/coordinator.js";
import { loadAgents, loadConfig } from "../src/config.js";

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

type ObservationEvent = {
  type: "observation";
  agentId: string;
  observation: {
    round: number;
    inventory: { valueUsdc: number };
    positions: Array<{ valueUsdc: number }>;
  };
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

  console.log(`[leaderboard] starting simulation: rounds=${config.rounds} agents=${config.agentsConfigPath}`);
  await runSimulation();

  const runDir = latestRunDir(runDirRoot);
  console.log(`[leaderboard] aggregating results from ${runDir}`);

  const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")) as Summary;
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
        revertCount: agent.revertCount
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

function latestRunDir(root: string): string {
  const entries = readdirSync(root)
    .map((name) => ({ name, path: join(root, name) }))
    .filter((entry) => statSync(entry.path).isDirectory())
    .map((entry) => ({ ...entry, mtimeMs: statSync(entry.path).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (entries.length === 0) throw new Error(`no run directories under ${root}`);
  return entries[0].path;
}

function readPerRoundValues(eventsPath: string): Map<string, number[]> {
  const lines = readFileSync(eventsPath, "utf8").split("\n").filter((line) => line.length > 0);
  const byAgent = new Map<string, Map<number, number>>();
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObservationEvent(parsed)) continue;
    const evt = parsed as ObservationEvent;
    const round = evt.observation.round;
    const value =
      evt.observation.inventory.valueUsdc +
      evt.observation.positions.reduce((sum, p) => sum + (p.valueUsdc ?? 0), 0);
    const series = byAgent.get(evt.agentId) ?? new Map<number, number>();
    series.set(round, value);
    byAgent.set(evt.agentId, series);
  }
  const out = new Map<string, number[]>();
  for (const [agentId, roundsMap] of byAgent) {
    const sorted = [...roundsMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    out.set(agentId, sorted);
  }
  return out;
}

function isObservationEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== "observation") return false;
  const obs = v.observation as Record<string, unknown> | undefined;
  if (!obs || typeof obs !== "object") return false;
  const inv = obs.inventory as Record<string, unknown> | undefined;
  return !!inv && typeof inv.valueUsdc === "number" && Array.isArray(obs.positions);
}

function readDescriptions(path: string): Map<string, string> {
  const map = new Map<string, string>();
  const agents = loadAgents(path);
  for (const a of agents) {
    if (a.description) map.set(a.id, a.description);
  }
  return map;
}

function sharpeRatio(values: number[]): number | null {
  if (values.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    if (prev === 0 || !Number.isFinite(prev)) continue;
    returns.push((values[i] - prev) / prev);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std === 0) return null;
  return mean / std;
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
  const cols = "| Rank | Agent | 戦略概要 | Net PnL (USDC) | Sharpe | Initial → Final (USDC) | Reverts |\n";
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
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
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
