// PnL 帰属(attribution)— ADR 0002 の「安価版」。
// RoundRecord.inventoryUsd の差分を action.type 別に集計し、「どの行動が効いて/損したか」を
// revise プロンプトに渡せる小さな要約へ落とす。新規プラミング不要(History が既に持つ情報のみ)。
import type { RoundRecord } from "./history.js";

export type ActionAttribution = {
  rounds: number; // その action.type を取ったラウンド数
  netUsd: number; // 次ラウンドにかけての inventoryUsd 変化の合計(概算 PnL)
  valid: number; // executorOk だった回数
  failed: number; // executor エラー/不正だった回数
};

export type Attribution = {
  byAction: Record<string, ActionAttribution>;
  topNoopReasons: Array<[string, number]>;
  drawdownUsd: number; // 期間中の最大 peak-to-trough(USD, 0 以上)
  turnover: number; // 非 noop の行動回数
  samples: number; // 集計に使ったラウンド数
};

// 連続する RoundRecord の inventoryUsd 差分を「直前の行動」に帰属させる(行動 → 次の評価額)。
export function computeAttribution(records: RoundRecord[]): Attribution {
  const byAction: Record<string, ActionAttribution> = {};
  const noopReasons = new Map<string, number>();
  let turnover = 0;
  let peak = records.length > 0 ? records[0].inventoryUsd : 0;
  let drawdownUsd = 0;

  const bucket = (type: string): ActionAttribution =>
    (byAction[type] ??= { rounds: 0, netUsd: 0, valid: 0, failed: 0 });

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const b = bucket(r.action.type);
    b.rounds++;
    if (r.executorOk) b.valid++;
    else b.failed++;
    if (r.action.type !== "noop") turnover++;
    // noop / 失敗の理由を数える(executorOk=false の理由も含む)
    if (r.action.type === "noop" || !r.executorOk) {
      const key = r.executorReason ?? r.action.type;
      noopReasons.set(key, (noopReasons.get(key) ?? 0) + 1);
    }
    // 行動 i の損益は i→i+1 の評価額変化で概算
    if (i + 1 < records.length) {
      b.netUsd += records[i + 1].inventoryUsd - r.inventoryUsd;
    }
    // ドローダウン
    if (r.inventoryUsd > peak) peak = r.inventoryUsd;
    const dd = peak - r.inventoryUsd;
    if (dd > drawdownUsd) drawdownUsd = dd;
  }

  const topNoopReasons = [...noopReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  return {
    byAction,
    topNoopReasons,
    drawdownUsd,
    turnover,
    samples: records.length,
  };
}

// revise プロンプト用のコンパクトな文字列(トークン節約)。
export function formatAttribution(a: Attribution): string {
  if (a.samples === 0) return "(no rounds yet)";
  const lines = Object.entries(a.byAction)
    .sort((x, y) => y[1].netUsd - x[1].netUsd)
    .map(
      ([type, s]) =>
        `  ${type}: rounds=${s.rounds} netUsd=${s.netUsd.toFixed(2)} ok=${s.valid} fail=${s.failed}`,
    );
  const noop =
    a.topNoopReasons.length > 0
      ? a.topNoopReasons.map(([r, n]) => `${r}×${n}`).join(", ")
      : "none";
  return [
    `samples=${a.samples} turnover=${a.turnover} maxDrawdownUsd=${a.drawdownUsd.toFixed(2)}`,
    "per-action PnL attribution (netUsd = inventory change attributed to that action):",
    ...lines,
    `top noop/failed reasons: ${noop}`,
  ].join("\n");
}
