// per-round ポートフォリオ価値の集計と Sharpe 計算、run dir 探索。
// leaderboard.ts と evaluate.ts / discrimination.ts が同じ基準を使うための共有モジュール。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// events.jsonl の observation イベント。observation は AgentObservation 形(protocols ネスト)。
export type ObservationEvent = {
  type: "observation";
  agentId: string;
  observation: Record<string, unknown>;
};

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

// 1 ラウンドの総ポートフォリオ価値(USDC)を observation から再構成する。
// = spot inventory + 各プロトコルのポジション価値。summary が使う adapter.valueUsdc と同じ式:
//   uniswap: Σ positions[].valueUsdc
//   gmx:     collateral(WETH なら ×price, USDC なら /1e6) + pnlUsd
//   aave:    (totalCollateralBase - totalDebtBase) / 1e8
// inventory は spot のみ(担保や LP は spot から抜ける)なので、ポジション価値を足し戻して総額にする。
// 旧実装は存在しない observation.positions 配列を要求し、全 agent で空 → Sharpe が常に N/A だった。
export function perRoundValueUsdc(
  observation: Record<string, unknown>,
): number {
  // biome-ignore lint/suspicious/noExplicitAny: ログ済み JSON を防御的に読む
  const obs = observation as any;
  let value = num(obs?.inventory?.valueUsdc);

  // 後方互換: 旧イベントのフラットな positions 配列
  if (Array.isArray(obs?.positions)) {
    for (const p of obs.positions) value += num(p?.valueUsdc);
  }

  const protocols = obs?.protocols ?? {};
  if (Array.isArray(protocols?.uniswap?.positions)) {
    for (const pos of protocols.uniswap.positions) value += num(pos?.valueUsdc);
  }
  const gmxPos = protocols?.gmx?.position;
  if (gmxPos) {
    const mkt = num(protocols.gmx.marketPriceUsd);
    const collateralUsd =
      gmxPos.collateral === "WETH"
        ? (num(gmxPos.collateralAmount) / 1e18) * mkt
        : num(gmxPos.collateralAmount) / 1e6;
    value += collateralUsd + num(gmxPos.pnlUsd);
  }
  if (protocols?.aave) {
    value +=
      (num(protocols.aave.totalCollateralBase) -
        num(protocols.aave.totalDebtBase)) /
      1e8;
  }
  return value;
}

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
    const round = num((evt.observation as Record<string, unknown>).round);
    const value = perRoundValueUsdc(evt.observation);
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
  return !!inv && typeof inv.valueUsdc === "number";
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
