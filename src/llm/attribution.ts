// PnL 帰属(attribution)— ADR 0002 の「安価版」を β 除去(α)化したもの。
//
// 旧版は RoundRecord.inventoryUsd(時価総額 = USDC + (WETH+ETH)×現在価格)の差分を
// 行動に帰属させていた。これは戦略の取り分(α)に価格変動(β)が混ざるため、
// 「noop でも価格が動けば儲かった/損した」ように見え、LLM が
// 「per-round $93 儲かっている → サイズを上げれば 2.5x」と誤読する原因になっていた
// (β はサイズに比例しない。増えるのは slippage だけ)。
//
// 本版は在庫を「窓内で固定した参照価格(最新 fairPrice)」で評価する α 値の差分を帰属させる。
// → 価格変動の影響(β)が消え、トレードが実際に積み増した価値(= slippage/gas を差し引いた
//    裁定の取り分)だけが netUsd に残る。サイズを上げて意味があるのはこの α だけ。
// 既存の rollback A/B 判定(claudeAgent.alphaValueUsd)と同じ α 規約に揃えている。
//
// 注意: α 値は free 残高(usdc/weth/eth)のみで評価し、LP ポジションに固定した価値は含めない
// (RoundRecord が LP 内訳を持たないため。rollback の α 規約と同じ制約)。純 swap 戦略
// (crossvenue base)では free 残高 = 全在庫なので一致する。
import type { RoundRecord } from "./history.js";

export type ActionAttribution = {
  rounds: number; // その action.type を取ったラウンド数
  netUsd: number; // β除去: 固定参照価格での α 評価額の変化合計(トレード由来 PnL の概算)
  grossUsd: number; // 参考: 生 inventoryUsd 変化(価格変動 β を含む)
  valid: number; // executorOk だった回数
  failed: number; // executor エラー/不正だった回数
};

export type Attribution = {
  byAction: Record<string, ActionAttribution>;
  topNoopReasons: Array<[string, number]>;
  drawdownUsd: number; // α ベースの最大 peak-to-trough(USD, 0 以上)
  turnover: number; // 非 noop の行動回数
  samples: number; // 集計に使ったラウンド数
  refPrice: number; // α 評価に使った固定参照価格(USDC/WETH)
  totalAlphaUsd: number; // 期間合計 α(= 最終 α 評価額 − 初回 α 評価額)
  totalGrossUsd: number; // 期間合計 gross(= 最終 inventoryUsd − 初回 inventoryUsd, β込み)
};

// 在庫を固定参照価格 ref で評価した α 値: usdc + (weth+eth)×ref。
// 価格変動による在庫の再評価(β)を除くので、戦略の取り分だけが残る。
function alphaValue(r: RoundRecord, ref: number): number {
  return r.usdc + (r.weth + r.eth) * ref;
}

// 窓内で固定する参照価格を選ぶ: 最新の正の fairPrice → 無ければ最新の正の poolPrice → 0。
function pickRefPrice(records: RoundRecord[]): number {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].fairPrice > 0) return records[i].fairPrice;
  }
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].poolPrice > 0) return records[i].poolPrice;
  }
  return 0;
}

// 連続する RoundRecord の α 評価額差分を「直前の行動」に帰属させる(行動 → 次の α 評価)。
export function computeAttribution(records: RoundRecord[]): Attribution {
  const byAction: Record<string, ActionAttribution> = {};
  const noopReasons = new Map<string, number>();
  let turnover = 0;
  const refPrice = pickRefPrice(records);
  const alpha0 = records.length > 0 ? alphaValue(records[0], refPrice) : 0;
  let peak = alpha0;
  let drawdownUsd = 0;

  const bucket = (type: string): ActionAttribution =>
    (byAction[type] ??= {
      rounds: 0,
      netUsd: 0,
      grossUsd: 0,
      valid: 0,
      failed: 0,
    });

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
    // 行動 i の損益は i→i+1 の α 評価額変化(β 除去)で概算。gross は参考に β込みで併記。
    if (i + 1 < records.length) {
      b.netUsd +=
        alphaValue(records[i + 1], refPrice) - alphaValue(r, refPrice);
      b.grossUsd += records[i + 1].inventoryUsd - r.inventoryUsd;
    }
    // ドローダウンも α ベース(価格急落で見かけ上のドローダウンが出るのを防ぐ)
    const a = alphaValue(r, refPrice);
    if (a > peak) peak = a;
    const dd = peak - a;
    if (dd > drawdownUsd) drawdownUsd = dd;
  }

  const topNoopReasons = [...noopReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  const last = records[records.length - 1];
  const totalAlphaUsd =
    records.length > 0 ? alphaValue(last, refPrice) - alpha0 : 0;
  const totalGrossUsd =
    records.length > 0 ? last.inventoryUsd - records[0].inventoryUsd : 0;

  return {
    byAction,
    topNoopReasons,
    drawdownUsd,
    turnover,
    samples: records.length,
    refPrice,
    totalAlphaUsd,
    totalGrossUsd,
  };
}

// revise プロンプト用のコンパクトな文字列(トークン節約)。
// netUsd は β 除去後の α(トレード由来 PnL)。gross(β込み)は参考値として併記し、
// 「総額の伸びは価格変動で、サイズを上げて伸びるのは α だけ」を LLM に明示する。
export function formatAttribution(a: Attribution): string {
  if (a.samples === 0) return "(no rounds yet)";
  const lines = Object.entries(a.byAction)
    .sort((x, y) => y[1].netUsd - x[1].netUsd)
    .map(
      ([type, s]) =>
        `  ${type}: rounds=${s.rounds} αNetUsd=${s.netUsd.toFixed(2)} (gross=${s.grossUsd.toFixed(2)}) ok=${s.valid} fail=${s.failed}`,
    );
  const noop =
    a.topNoopReasons.length > 0
      ? a.topNoopReasons.map(([r, n]) => `${r}×${n}`).join(", ")
      : "none";
  return [
    `samples=${a.samples} turnover=${a.turnover} refPrice=${a.refPrice.toFixed(2)} maxα-drawdownUsd=${a.drawdownUsd.toFixed(2)}`,
    `window αPnL (trade edge, price moves removed) = ${a.totalAlphaUsd.toFixed(2)} USDC` +
      ` | total Δvalue incl. price moves (β) = ${a.totalGrossUsd.toFixed(2)} USDC`,
    "per-action α attribution (αNetUsd = inventory α change attributed to that action; gross includes price moves):",
    ...lines,
    `top noop/failed reasons: ${noop}`,
  ].join("\n");
}
