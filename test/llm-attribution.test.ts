import test from "node:test";
import assert from "node:assert/strict";
import {
  computeAttribution,
  formatAttribution,
} from "../src/llm/attribution.js";
import type { RoundRecord } from "../src/llm/history.js";

// 在庫構成(usdc/weth/eth)と現在価格から RoundRecord を作る。
// inventoryUsd は時価評価(= usdc + (weth+eth)×price)で β を含む。
function rec(
  round: number,
  type: string,
  opts: {
    usdc?: number;
    weth?: number;
    eth?: number;
    price?: number;
    ok?: boolean;
    reason?: string;
  } = {},
): RoundRecord {
  const usdc = opts.usdc ?? 0;
  const weth = opts.weth ?? 0;
  const eth = opts.eth ?? 0;
  const price = opts.price ?? 1700;
  return {
    round,
    poolPrice: price,
    fairPrice: price,
    inventoryUsd: usdc + (weth + eth) * price,
    weth,
    usdc,
    eth,
    openPositions: 0,
    action: { type },
    executorLogs: [],
    executorOk: opts.ok ?? true,
    executorReason: opts.reason,
  };
}

test("computeAttribution: α(β除去)で action 別 netUsd / turnover を集計", () => {
  // 価格は 1700 で一定。トレードで在庫の α 価値が増えた分だけ netUsd に出る。
  const records = [
    rec(1, "swap", { usdc: 1700, weth: 1 }), // α=3400
    rec(2, "noop", { usdc: 100, weth: 2 }), // α=3500 → swap@1 = +100
    rec(3, "swap", { usdc: 100, weth: 2 }), // α=3500 → noop@2 = 0
    rec(4, "noop", { usdc: 300, weth: 2 }), // α=3700 → swap@3 = +200
  ];
  const a = computeAttribution(records);
  assert.equal(a.samples, 4);
  assert.equal(a.turnover, 2); // swap が 2 回
  assert.equal(a.refPrice, 1700);
  assert.equal(a.byAction.swap.rounds, 2);
  assert.equal(a.byAction.swap.netUsd, 300); // +100 +200
  assert.equal(a.byAction.noop.netUsd, 0); // r4 は次が無く 0
  assert.equal(a.totalAlphaUsd, 300); // α(r4) − α(r1)
  assert.equal(a.totalGrossUsd, 300); // 価格不変なので α == gross
  assert.equal(a.drawdownUsd, 0); // α は単調増
});

test("computeAttribution: 価格変動(β)は netUsd に漏れない、gross にだけ出る", () => {
  // noop のみ・在庫構成は不変、価格だけ 1700→1800→1900 と上昇。
  const records = [
    rec(1, "noop", { usdc: 1000, weth: 1, price: 1700 }), // inv=2700
    rec(2, "noop", { usdc: 1000, weth: 1, price: 1800 }), // inv=2800
    rec(3, "noop", { usdc: 1000, weth: 1, price: 1900 }), // inv=2900
  ];
  const a = computeAttribution(records);
  assert.equal(a.refPrice, 1900); // 窓内最新の fairPrice
  assert.equal(a.byAction.noop.netUsd, 0); // β 除去 → トレードしてないので α=0
  assert.equal(a.byAction.noop.grossUsd, 200); // 生の時価変化(+100 +100)は β を含む
  assert.equal(a.totalAlphaUsd, 0); // トレード由来 PnL は 0
  assert.equal(a.totalGrossUsd, 200); // 総額は価格上昇で +200
  assert.equal(a.drawdownUsd, 0); // α 一定
});

test("computeAttribution: 失敗を failed / noop理由に数える", () => {
  const records = [
    rec(1, "noop", { ok: false, reason: "executor error: boom" }),
    rec(2, "noop", { ok: true, reason: "gap too small" }),
  ];
  const a = computeAttribution(records);
  assert.equal(a.byAction.noop.failed, 1);
  assert.equal(a.byAction.noop.valid, 1);
  const reasons = Object.fromEntries(a.topNoopReasons);
  assert.equal(reasons["executor error: boom"], 1);
  assert.equal(reasons["gap too small"], 1);
});

test("formatAttribution: サンプル0は (no rounds yet)、α ラベルを含む", () => {
  assert.equal(formatAttribution(computeAttribution([])), "(no rounds yet)");
  const s = formatAttribution(
    computeAttribution([rec(1, "swap", { usdc: 1700, weth: 1 })]),
  );
  assert.match(s, /per-action α attribution/);
  assert.match(s, /swap:/);
  assert.match(s, /window αPnL/);
});
