import test from "node:test";
import assert from "node:assert/strict";
import {
  computeAttribution,
  formatAttribution,
} from "../src/llm/attribution.js";
import type { RoundRecord } from "../src/llm/history.js";

function rec(
  round: number,
  type: string,
  inventoryUsd: number,
  opts: { ok?: boolean; reason?: string } = {},
): RoundRecord {
  return {
    round,
    poolPrice: 1700,
    fairPrice: 1700,
    inventoryUsd,
    weth: 0,
    usdc: 0,
    eth: 0,
    openPositions: 0,
    action: { type },
    executorLogs: [],
    executorOk: opts.ok ?? true,
    executorReason: opts.reason,
  };
}

test("computeAttribution: action 別 netUsd / turnover / drawdown を集計", () => {
  const records = [
    rec(1, "swap", 100),
    rec(2, "noop", 110), // swap@1 → +10
    rec(3, "swap", 105), // noop@2 → -5
    rec(4, "noop", 108), // swap@3 → +3
  ];
  const a = computeAttribution(records);
  assert.equal(a.samples, 4);
  assert.equal(a.turnover, 2); // swap が 2 回
  assert.equal(a.byAction.swap.rounds, 2);
  assert.equal(a.byAction.swap.netUsd, 13); // +10 +3
  assert.equal(a.byAction.noop.netUsd, -5); // r4 は次が無く 0
  // peak 110 → trough 105 → drawdown 5
  assert.equal(a.drawdownUsd, 5);
});

test("computeAttribution: 失敗を failed / noop理由に数える", () => {
  const records = [
    rec(1, "noop", 100, { ok: false, reason: "executor error: boom" }),
    rec(2, "noop", 100, { ok: true, reason: "gap too small" }),
  ];
  const a = computeAttribution(records);
  assert.equal(a.byAction.noop.failed, 1);
  assert.equal(a.byAction.noop.valid, 1);
  const reasons = Object.fromEntries(a.topNoopReasons);
  assert.equal(reasons["executor error: boom"], 1);
  assert.equal(reasons["gap too small"], 1);
});

test("formatAttribution: サンプル0は (no rounds yet)", () => {
  assert.equal(formatAttribution(computeAttribution([])), "(no rounds yet)");
  const s = formatAttribution(computeAttribution([rec(1, "swap", 100)]));
  assert.match(s, /per-action PnL attribution/);
  assert.match(s, /swap:/);
});
