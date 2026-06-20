import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStressReport,
  computeCompetitorMetrics,
  computeLiquidatorMetrics,
  computeVictimOutcomes,
  parseStressRun,
  renderStressMarkdown,
} from "../src/stressMetrics.js";

const HF = (x: number): string => BigInt(Math.round(x * 1e18)).toString();
const USD8 = (x: number): number => Math.round(x * 1e8);

function obs(agentId: string, round: number, value: number): string {
  return JSON.stringify({
    type: "observation",
    agentId,
    observation: {
      reconstructed: true,
      round,
      blockNumber: String(round),
      fairPriceUsdcPerWeth: 3000,
      inventory: { valueUsdc: value },
    },
  });
}

// runStartBlock=100, crash 窓 = 絶対ブロック 105..115（blockIndex 5..15）。
function buildEvents(): string[] {
  return [
    JSON.stringify({
      type: "agents_registered",
      agents: [
        { id: "lev", baseline: false },
        { id: "liq", baseline: false },
        { id: "noop", baseline: true },
      ],
    }),
    JSON.stringify({
      type: "stress_schedule",
      events: [
        {
          type: "crash",
          magnitude: 0.1,
          startBlock: 5,
          rampBlocks: 2,
          holdBlocks: 4,
          decayBlocks: 2,
          endBlock: 13,
        },
      ],
    }),
    JSON.stringify({
      type: "stress_victims_setup",
      hf0: 1.05,
      victims: [{ id: "victim-0", address: "0xV0", healthFactor: HF(1.05) }],
    }),
    // victim HF 観測（窓内）。108 で HF<1、110 で債務が減る。
    JSON.stringify({
      type: "stress_victim_hf",
      blockNumber: 105,
      blockIndex: 5,
      wethMult: 0.95,
      victims: [
        { id: "victim-0", healthFactor: HF(1.05), totalDebtBase: USD8(1000) },
      ],
    }),
    JSON.stringify({
      type: "stress_victim_hf",
      blockNumber: 108,
      blockIndex: 8,
      wethMult: 0.9,
      victims: [
        { id: "victim-0", healthFactor: HF(0.95), totalDebtBase: USD8(1000) },
      ],
    }),
    JSON.stringify({
      type: "stress_victim_hf",
      blockNumber: 110,
      blockIndex: 10,
      wethMult: 0.9,
      victims: [
        { id: "victim-0", healthFactor: HF(0.95), totalDebtBase: USD8(500) },
      ],
    }),
    JSON.stringify({
      type: "stress_liquidation",
      blockNumber: 110,
      blockIndex: 10,
      victimId: "victim-0",
      victimAddress: "0xV0",
      repaidBaseUsd: USD8(500),
      remainingDebtBase: USD8(500),
      healthFactor: HF(0.95),
    }),
    // 価値系列（reconstructed）
    obs("lev", 100, 10000),
    obs("lev", 104, 10000),
    obs("lev", 108, 8000), // crash で被弾
    obs("lev", 112, 8500),
    obs("lev", 120, 9000),
    obs("liq", 100, 5000),
    obs("liq", 104, 5000),
    obs("liq", 110, 5300), // 清算益
    obs("liq", 120, 5300),
    obs("noop", 100, 1000),
    obs("noop", 120, 1000),
    JSON.stringify({ type: "value_series_reconstructed" }),
    JSON.stringify({ type: "run_completed" }),
  ];
}

const BLOCKS_CSV = [
  "round,blockNumber,txIndex,hash,from,priorityFeeWei,status,ownerId,role,actionType,bundleId,bundleIndex",
  "110,110,0,0xh1,0xliq,6000000000,success,liq,agent,rawTx,,",
  "110,110,1,0xh2,0xlev,1,reverted,lev,agent,rawTx,,", // reverted → 捕捉に数えない
  "108,108,0,0xh3,0xoracle,7000000000,success,oracle,system,oracleUpdate,,",
].join("\n");

test("parseStressRun: 構造化（runStartBlock / schedule / series / liquidations）", () => {
  const run = parseStressRun(buildEvents(), BLOCKS_CSV);
  assert.equal(run.runStartBlock, 100); // 105 − 5
  assert.equal(run.schedule.length, 1);
  assert.equal(run.valueSeries.size, 3);
  assert.equal(run.liquidations.length, 1);
  assert.equal(run.victimsSetup.length, 1);
  // series は round 昇順
  const lev = run.valueSeries.get("lev")!;
  assert.deepEqual(
    lev.map((p) => p.round),
    [100, 104, 108, 112, 120],
  );
});

test("computeCompetitorMetrics: drawdown / postEventPnl / 順位", () => {
  const run = parseStressRun(buildEvents(), BLOCKS_CSV);
  const m = computeCompetitorMetrics(run);
  // netPnl 降順: liq(+300) > noop(0) > lev(-1000)
  assert.deepEqual(
    m.map((x) => x.agentId),
    ["liq", "noop", "lev"],
  );
  const lev = m.find((x) => x.agentId === "lev")!;
  assert.ok(Math.abs(lev.maxDrawdownPct - 0.2) < 1e-9, `${lev.maxDrawdownPct}`);
  // preEventBlock = 100 + 5 − 1 = 104 → preEventValue 10000、final 9000
  assert.equal(lev.preEventValueUsdc, 10000);
  assert.equal(lev.postEventPnlUsdc, -1000);
  assert.equal(lev.survived, true); // dd 0.2 < 0.5
  const liq = m.find((x) => x.agentId === "liq")!;
  assert.equal(liq.maxDrawdownPct, 0);
  assert.equal(liq.netPnlUsdc, 300);
});

test("computeVictimOutcomes: HF<1 検知と検知遅延", () => {
  const run = parseStressRun(buildEvents(), BLOCKS_CSV);
  const v = computeVictimOutcomes(run);
  assert.equal(v.length, 1);
  const v0 = v[0];
  assert.equal(v0.victimId, "victim-0");
  assert.ok(Math.abs((v0.setupHf ?? 0) - 1.05) < 1e-9);
  assert.ok(Math.abs((v0.minHf ?? 0) - 0.95) < 1e-9);
  assert.equal(v0.wentBelowOne, true);
  assert.equal(v0.firstBelowOneBlock, 108);
  assert.equal(v0.liquidatedBlock, 110);
  assert.equal(v0.detectionDelayBlocks, 2); // 110 − 108
  assert.ok(Math.abs(v0.totalRepaidBaseUsd - USD8(500)) < 1);
});

test("computeLiquidatorMetrics(block-heuristic): agent ログ無しは success agent tx で近似", () => {
  const run = parseStressRun(buildEvents(), BLOCKS_CSV);
  const l = computeLiquidatorMetrics(run);
  assert.equal(l.attribution, "block-heuristic");
  assert.equal(l.metrics.length, 1); // lev は reverted なので除外
  assert.equal(l.metrics[0].agentId, "liq");
  assert.equal(l.metrics[0].captures, 1);
  assert.deepEqual(l.metrics[0].capturedVictims, ["victim-0"]);
});

test("computeLiquidatorMetrics(raw-tx-log): liquidationCall を出した agent に限定", () => {
  // simple は同ブロックに swap success を持つが rawTx は出さない → 誤計上しない。
  const agentLogs = new Map<string, string[]>([
    [
      "liq",
      [
        JSON.stringify({
          kind: "mempool",
          event: "submitted",
          actionType: "rawTx",
          blockSeen: 109,
        }),
      ],
    ],
    [
      "simple",
      [
        JSON.stringify({
          kind: "mempool",
          event: "submitted",
          actionType: "swap",
          blockSeen: 110,
        }),
      ],
    ],
  ]);
  // simple の success swap を清算ブロックに追加（heuristic なら誤計上されるはずの罠）
  const csv = `${BLOCKS_CSV}\n110,110,2,0xh4,0xsimple,2000000000,success,simple,agent,swap,,`;
  const run = parseStressRun(buildEvents(), csv, agentLogs);
  const l = computeLiquidatorMetrics(run);
  assert.equal(l.attribution, "raw-tx-log");
  assert.deepEqual(
    l.metrics.map((m) => m.agentId),
    ["liq"],
  ); // simple は除外される
  assert.equal(l.metrics[0].captures, 1);
});

test("buildStressReport + renderStressMarkdown が成立", () => {
  const run = parseStressRun(buildEvents(), BLOCKS_CSV);
  const report = buildStressReport(run);
  assert.equal(report.competitors.length, 3);
  assert.equal(report.victims.length, 1);
  assert.equal(report.liquidators.length, 1);
  assert.equal(report.liquidatorAttribution, "block-heuristic");
  const md = renderStressMarkdown(report);
  assert.match(md, /Stress 評価レポート/);
  assert.match(md, /victim-0/);
  assert.match(md, /liq/);
});

test("schedule 無し run でも例外なく空指標を返す", () => {
  const lines = [
    JSON.stringify({
      type: "agents_registered",
      agents: [{ id: "a", baseline: false }],
    }),
    obs("a", 1, 100),
    obs("a", 2, 110),
  ];
  const run = parseStressRun(lines, "round,blockNumber\n");
  const report = buildStressReport(run);
  assert.equal(report.schedule.length, 0);
  assert.equal(report.competitors.length, 1);
  assert.equal(report.competitors[0].postEventPnlUsdc, null); // イベント無し
  assert.equal(report.victims.length, 0);
  assert.equal(report.liquidators.length, 0);
});
