// per-round ポートフォリオ価値の集計と Sharpe 計算、run dir 探索。
// leaderboard.ts と evaluate.ts の両方が同じ基準を使うための共有モジュール。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ObservationEvent = {
  type: "observation";
  agentId: string;
  observation: {
    round: number;
    inventory: { valueUsdc: number };
    positions: Array<{ valueUsdc: number }>;
  };
};

// events.jsonl から agent ごとの per-round 総価値系列(round 昇順)を作る。
export function readPerRoundValues(eventsPath: string): Map<string, number[]> {
  const lines = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
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
      evt.observation.positions.reduce((s, p) => s + (p.valueUsdc ?? 0), 0);
    const series = byAgent.get(evt.agentId) ?? new Map<number, number>();
    series.set(round, value);
    byAgent.set(evt.agentId, series);
  }
  const out = new Map<string, number[]>();
  for (const [agentId, roundsMap] of byAgent) {
    const sorted = [...roundsMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
    out.set(agentId, sorted);
  }
  return out;
}

export function isObservationEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== "observation") return false;
  const obs = v.observation as Record<string, unknown> | undefined;
  if (!obs || typeof obs !== "object") return false;
  const inv = obs.inventory as Record<string, unknown> | undefined;
  return (
    !!inv && typeof inv.valueUsdc === "number" && Array.isArray(obs.positions)
  );
}

// per-round リターンの平均/標準偏差比(Sharpe)。系列が短い/分散0なら null。
export function sharpeRatio(values: number[]): number | null {
  if (values.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    if (prev === 0 || !Number.isFinite(prev)) continue;
    returns.push((values[i] - prev) / prev);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std === 0) return null;
  return mean / std;
}

// 最新の run ディレクトリ(mtime 降順)。requireSummary 時は summary.json を持つものに限る
// (失敗 run の空 dir を避ける)。
export function latestRunDir(root: string, requireSummary = false): string {
  const entries = readdirSync(root)
    .map((name) => ({ name, path: join(root, name) }))
    .filter((e) => statSync(e.path).isDirectory())
    .filter((e) => !requireSummary || existsSync(join(e.path, "summary.json")))
    .map((e) => ({ ...e, mtimeMs: statSync(e.path).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (entries.length === 0)
    throw new Error(
      `no run dir${requireSummary ? " with summary.json" : ""} under ${root}`,
    );
  return entries[0].path;
}
