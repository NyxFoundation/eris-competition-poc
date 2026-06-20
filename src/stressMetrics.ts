// stress 評価軸の指標抽出層（ADR 0009 §5）。
//
// α 識別（discrimination の C1/C2/C3）とは分離した「stress 軸」を、reconstruct のコア
// （events.jsonl の reconstructed observation）と coordinator が emit する stress イベントから
// 抽出する純関数群。チェーン I/O には触れず、run dir の 2 ファイル
// （events.jsonl / blocks.csv）の文字列を入力に取る（テスト可能）。
//
// 測るスキル（ADR 0009 §5 の表）:
//   - 競技 agent: 最大ドローダウン / イベント後 PnL / 生存（リスク管理。目的 2）
//   - liquidator agent: 清算捕捉数 / 検知遅延（HF<1 から清算まで）（清算ハンティング。目的 1）
//
// SEED は市場条件ラベルで着順だけ非決定（ADR 0005）→ run 横断の生存率等は N 反復で集計する
// （本層は 1 run の per-agent 指標を出す。集計は呼び側 / 反復ツールの責務）。
import { BLOCKS_CSV_INDEX } from "./logger.js";
import type { ResolvedStressEvent } from "./realtime/events.js";

const HF_SCALE = 1e18; // Aave healthFactor は 1e18 = 1.0

export type StressRunData = {
  agents: { id: string; baseline: boolean }[];
  schedule: ResolvedStressEvent[];
  // agentId → run 後再構成の価値系列（round 昇順）。
  valueSeries: Map<string, { round: number; value: number }[]>;
  // victim HF/債務の観測列（blockNumber 昇順。窓内/窓近傍のみ）。
  victimHf: {
    blockNumber: number;
    blockIndex: number;
    victims: { id: string; hf: number; debtBase: number }[];
  }[];
  // 清算検知（victim 債務の減少）。
  liquidations: {
    blockNumber: number;
    victimId: string;
    repaidBaseUsd: number;
  }[];
  // setup 直後の victim（HF≈H0）。
  victimsSetup: { id: string; address: string; hf: number }[];
  // run 競争の開始ブロック（絶対）。stress_victim_hf の blockNumber − blockIndex から導出。
  runStartBlock: number | null;
  // blockNumber → そのブロックの tx（owner/role/status）。liquidator 帰属の heuristic に使う。
  agentTxByBlock: Map<
    number,
    { ownerId: string; role: string; status: string }[]
  >;
};

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// healthFactor（bigint 1e18 文字列）→ float。debt=0 のとき Aave は uint256 最大値を返す（巨大）。
function hfToFloat(v: unknown): number {
  try {
    return Number(BigInt(String(v))) / HF_SCALE;
  } catch {
    return num(v);
  }
}

// events.jsonl（行配列）+ blocks.csv（生文字列）を構造化する。
export function parseStressRun(
  eventsLines: string[],
  blocksCsv: string,
): StressRunData {
  const agents: { id: string; baseline: boolean }[] = [];
  let schedule: ResolvedStressEvent[] = [];
  const valueSeries = new Map<string, { round: number; value: number }[]>();
  const victimHf: StressRunData["victimHf"] = [];
  const liquidations: StressRunData["liquidations"] = [];
  let victimsSetup: StressRunData["victimsSetup"] = [];
  let runStartBlock: number | null = null;

  for (const line of eventsLines) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    switch (ev.type) {
      case "agents_registered":
        if (Array.isArray(ev.agents)) {
          for (const a of ev.agents as Array<Record<string, unknown>>) {
            agents.push({ id: String(a.id), baseline: Boolean(a.baseline) });
          }
        }
        break;
      case "stress_schedule":
        if (Array.isArray(ev.events)) {
          schedule = ev.events as ResolvedStressEvent[];
        }
        break;
      case "stress_victims_setup":
        if (Array.isArray(ev.victims)) {
          victimsSetup = (ev.victims as Array<Record<string, unknown>>).map(
            (v) => ({
              id: String(v.id),
              address: String(v.address),
              hf: hfToFloat(v.healthFactor),
            }),
          );
        }
        break;
      case "stress_victim_hf": {
        const blockNumber = num(ev.blockNumber);
        const blockIndex = num(ev.blockIndex);
        if (runStartBlock === null) runStartBlock = blockNumber - blockIndex;
        const victims = Array.isArray(ev.victims)
          ? (ev.victims as Array<Record<string, unknown>>).map((v) => ({
              id: String(v.id),
              hf: hfToFloat(v.healthFactor),
              debtBase: num(v.totalDebtBase),
            }))
          : [];
        victimHf.push({ blockNumber, blockIndex, victims });
        break;
      }
      case "stress_liquidation":
        liquidations.push({
          blockNumber: num(ev.blockNumber),
          victimId: String(ev.victimId),
          repaidBaseUsd: num(ev.repaidBaseUsd),
        });
        break;
      case "observation": {
        const obs = ev.observation as
          | {
              reconstructed?: boolean;
              round?: number;
              inventory?: { valueUsdc?: number };
            }
          | undefined;
        if (!obs?.reconstructed || typeof ev.agentId !== "string") break;
        const id = ev.agentId;
        const series = valueSeries.get(id) ?? [];
        series.push({
          round: num(obs.round),
          value: num(obs.inventory?.valueUsdc),
        });
        valueSeries.set(id, series);
        break;
      }
      default:
        break;
    }
  }

  for (const series of valueSeries.values()) {
    series.sort((a, b) => a.round - b.round);
  }
  victimHf.sort((a, b) => a.blockNumber - b.blockNumber);

  const agentTxByBlock = parseBlocksCsv(blocksCsv);
  return {
    agents,
    schedule,
    valueSeries,
    victimHf,
    liquidations,
    victimsSetup,
    runStartBlock,
    agentTxByBlock,
  };
}

function parseBlocksCsv(
  csv: string,
): Map<number, { ownerId: string; role: string; status: string }[]> {
  const byBlock = new Map<
    number,
    { ownerId: string; role: string; status: string }[]
  >();
  for (const line of csv.split("\n")) {
    if (!line || line.startsWith("round,")) continue;
    const cols = line.split(",");
    const blockNumber = Number(cols[BLOCKS_CSV_INDEX.blockNumber]);
    if (!Number.isFinite(blockNumber)) continue;
    const row = {
      ownerId: cols[BLOCKS_CSV_INDEX.ownerId] ?? "",
      role: cols[BLOCKS_CSV_INDEX.role] ?? "",
      status: cols[BLOCKS_CSV_INDEX.status] ?? "",
    };
    const list = byBlock.get(blockNumber) ?? [];
    list.push(row);
    byBlock.set(blockNumber, list);
  }
  return byBlock;
}

// ---- 競技 agent のリスク管理指標（目的 2）----
export type CompetitorMetric = {
  agentId: string;
  baseline: boolean;
  startValueUsdc: number;
  finalValueUsdc: number;
  netPnlUsdc: number;
  maxDrawdownPct: number; // 0..1。価値系列の peak→trough 下落率の最大
  preEventValueUsdc: number | null; // 最初のイベント直前の価値
  postEventPnlUsdc: number | null; // final − preEvent（ストレス episode を通した損益）
  survived: boolean; // maxDrawdownPct < survivalDrawdownPct
};

export function computeCompetitorMetrics(
  run: StressRunData,
  opts: { survivalDrawdownPct?: number } = {},
): CompetitorMetric[] {
  const survivalDrawdownPct = opts.survivalDrawdownPct ?? 0.5;
  const firstEvent = run.schedule.length
    ? run.schedule.reduce((m, e) => (e.startBlock < m.startBlock ? e : m))
    : null;
  const preEventBlock =
    firstEvent && run.runStartBlock !== null
      ? run.runStartBlock + firstEvent.startBlock - 1
      : null;

  const baselineById = new Map(run.agents.map((a) => [a.id, a.baseline]));
  const metrics: CompetitorMetric[] = [];
  for (const [agentId, series] of run.valueSeries) {
    if (series.length === 0) continue;
    const startValue = series[0].value;
    const finalValue = series[series.length - 1].value;
    let peak = series[0].value;
    let maxDrawdownPct = 0;
    for (const { value } of series) {
      if (value > peak) peak = value;
      if (peak > 0) {
        const dd = (peak - value) / peak;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }
    }
    const preEventValue =
      preEventBlock !== null ? valueAtOrBefore(series, preEventBlock) : null;
    const postEventPnl =
      preEventValue !== null ? finalValue - preEventValue : null;
    metrics.push({
      agentId,
      baseline: baselineById.get(agentId) ?? false,
      startValueUsdc: startValue,
      finalValueUsdc: finalValue,
      netPnlUsdc: finalValue - startValue,
      maxDrawdownPct,
      preEventValueUsdc: preEventValue,
      postEventPnlUsdc: postEventPnl,
      survived: maxDrawdownPct < survivalDrawdownPct,
    });
  }
  metrics.sort((a, b) => b.netPnlUsdc - a.netPnlUsdc);
  return metrics;
}

// round（=絶対ブロック）<= target の最後の観測値（無ければ最初の値）。
function valueAtOrBefore(
  series: { round: number; value: number }[],
  target: number,
): number {
  let chosen = series[0].value;
  for (const { round, value } of series) {
    if (round <= target) chosen = value;
    else break;
  }
  return chosen;
}

// ---- victim の清算アウトカム ----
export type VictimOutcome = {
  victimId: string;
  setupHf: number | null;
  minHf: number | null;
  wentBelowOne: boolean;
  firstBelowOneBlock: number | null;
  liquidatedBlock: number | null;
  detectionDelayBlocks: number | null; // liquidatedBlock − firstBelowOneBlock
  totalRepaidBaseUsd: number;
};

export function computeVictimOutcomes(run: StressRunData): VictimOutcome[] {
  const setupById = new Map(run.victimsSetup.map((v) => [v.id, v.hf]));
  const ids = new Set<string>([
    ...run.victimsSetup.map((v) => v.id),
    ...run.victimHf.flatMap((h) => h.victims.map((v) => v.id)),
  ]);
  const outcomes: VictimOutcome[] = [];
  for (const victimId of ids) {
    let minHf: number | null = null;
    let firstBelowOneBlock: number | null = null;
    for (const obs of run.victimHf) {
      const v = obs.victims.find((x) => x.id === victimId);
      if (!v) continue;
      if (minHf === null || v.hf < minHf) minHf = v.hf;
      if (v.hf < 1 && firstBelowOneBlock === null)
        firstBelowOneBlock = obs.blockNumber;
    }
    const myLiquidations = run.liquidations.filter(
      (l) => l.victimId === victimId,
    );
    const liquidatedBlock = myLiquidations.length
      ? Math.min(...myLiquidations.map((l) => l.blockNumber))
      : null;
    const totalRepaidBaseUsd = myLiquidations.reduce(
      (s, l) => s + l.repaidBaseUsd,
      0,
    );
    outcomes.push({
      victimId,
      setupHf: setupById.get(victimId) ?? null,
      minHf,
      wentBelowOne: firstBelowOneBlock !== null,
      firstBelowOneBlock,
      liquidatedBlock,
      detectionDelayBlocks:
        liquidatedBlock !== null && firstBelowOneBlock !== null
          ? liquidatedBlock - firstBelowOneBlock
          : null,
      totalRepaidBaseUsd,
    });
  }
  outcomes.sort((a, b) => a.victimId.localeCompare(b.victimId));
  return outcomes;
}

// ---- liquidator agent の清算捕捉（目的 1）----
// 帰属は heuristic: 清算ブロックで success した agent tx をその agent の捕捉とみなす
// （同一ブロックに複数の agent tx があれば全員に計上され得る。competent 同士の運成分は
// N 反復で吸収する前提。ADR 0009 §6）。
export type LiquidatorMetric = {
  agentId: string;
  captures: number;
  capturedVictims: string[];
};

export function computeLiquidatorMetrics(
  run: StressRunData,
): LiquidatorMetric[] {
  const byAgent = new Map<string, Set<string>>();
  for (const liq of run.liquidations) {
    const txs = run.agentTxByBlock.get(liq.blockNumber) ?? [];
    for (const tx of txs) {
      if (tx.role !== "agent") continue;
      if (tx.status !== "success") continue;
      const set = byAgent.get(tx.ownerId) ?? new Set<string>();
      set.add(liq.victimId);
      byAgent.set(tx.ownerId, set);
    }
  }
  const metrics: LiquidatorMetric[] = [];
  for (const [agentId, victims] of byAgent) {
    metrics.push({
      agentId,
      captures: victims.size,
      capturedVictims: [...victims].sort(),
    });
  }
  metrics.sort((a, b) => b.captures - a.captures);
  return metrics;
}

export type StressReport = {
  runStartBlock: number | null;
  schedule: ResolvedStressEvent[];
  competitors: CompetitorMetric[];
  victims: VictimOutcome[];
  liquidators: LiquidatorMetric[];
};

export function buildStressReport(run: StressRunData): StressReport {
  return {
    runStartBlock: run.runStartBlock,
    schedule: run.schedule,
    competitors: computeCompetitorMetrics(run),
    victims: computeVictimOutcomes(run),
    liquidators: computeLiquidatorMetrics(run),
  };
}

// 人間可読の Markdown レポート（runs/<id>/stress.md 用）。
export function renderStressMarkdown(report: StressReport): string {
  const lines: string[] = [];
  lines.push("# Stress 評価レポート（ADR 0009）");
  lines.push("");
  lines.push(`- runStartBlock: ${report.runStartBlock ?? "n/a"}`);
  lines.push(
    `- events: ${
      report.schedule.length
        ? report.schedule
            .map(
              (e) =>
                `${e.type} m=${e.magnitude.toFixed(3)} @block ${e.startBlock}..${e.endBlock}`,
            )
            .join(" / ")
        : "(none)"
    }`,
  );
  lines.push("");

  lines.push("## 競技 agent（リスク管理。目的 2）");
  lines.push("");
  lines.push(
    ...mdTable(
      ["agent", "baseline", "netPnl", "maxDD%", "postEventPnl", "survived"],
      ["---", "---", "--:", "--:", "--:", ":--:"],
      report.competitors.map((c) => [
        c.agentId,
        c.baseline ? "yes" : "",
        fmt(c.netPnlUsdc),
        (c.maxDrawdownPct * 100).toFixed(1),
        c.postEventPnlUsdc === null ? "n/a" : fmt(c.postEventPnlUsdc),
        c.survived ? "✓" : "✗",
      ]),
    ),
  );
  lines.push("");

  lines.push("## victim（清算成立の確認）");
  lines.push("");
  lines.push(
    ...mdTable(
      [
        "victim",
        "setupHF",
        "minHF",
        "<1",
        "liquidated@",
        "detectionDelay",
        "repaidUSD",
      ],
      ["---", "--:", "--:", ":--:", "--:", "--:", "--:"],
      report.victims.map((v) => [
        v.victimId,
        v.setupHf?.toFixed(3) ?? "n/a",
        v.minHf?.toFixed(3) ?? "n/a",
        v.wentBelowOne ? "✓" : "✗",
        String(v.liquidatedBlock ?? "—"),
        String(v.detectionDelayBlocks ?? "—"),
        fmt(v.totalRepaidBaseUsd / 1e8),
      ]),
    ),
  );
  lines.push("");

  lines.push(
    "## liquidator agent（清算ハンティング。目的 1。帰属は heuristic）",
  );
  lines.push("");
  if (report.liquidators.length === 0) {
    lines.push("(清算捕捉なし)");
  } else {
    lines.push(
      ...mdTable(
        ["agent", "captures", "victims"],
        ["---", "--:", "---"],
        report.liquidators.map((l) => [
          l.agentId,
          String(l.captures),
          l.capturedVictims.join(" "),
        ]),
      ),
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// Markdown テーブルの行配列（header / separator / rows）を組み立てる。
function mdTable(
  headers: string[],
  alignments: string[],
  rows: string[][],
): string[] {
  return [
    `| ${headers.join(" | ")} |`,
    `|${alignments.join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ];
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
