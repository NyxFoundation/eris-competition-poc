import test from "node:test";
import assert from "node:assert/strict";
import {
  ClaudeCliStrategist,
  extractJsonObject,
  type SpawnLike,
} from "../src/llm/claudeCliStrategist.js";
import type { AgentObservation } from "../src/types.js";

// stdout を返して close する fake spawn（実 claude を呼ばずに strategist をテスト）。
function fakeSpawn(stdout: string, code = 0): SpawnLike {
  return () => {
    const stdoutCbs: Array<(c: unknown) => void> = [];
    const handlers: Record<string, (arg: never) => void> = {};
    const child = {
      stdout: {
        on: (_ev: "data", cb: (c: unknown) => void) => stdoutCbs.push(cb),
      },
      stderr: { on: () => {} },
      on: (ev: "close" | "error", cb: (arg: never) => void) => {
        handlers[ev] = cb;
      },
      kill: () => {},
    };
    setTimeout(() => {
      for (const cb of stdoutCbs) cb(Buffer.from(stdout));
      handlers.close?.(code as never);
    }, 0);
    return child;
  };
}

function obs(): AgentObservation {
  return {
    kind: "observation",
    runId: "t",
    round: 0,
    blockNumber: "1",
    agentAddress: "0x0000000000000000000000000000000000000001",
    fairPriceUsdcPerWeth: 1700,
    oraclePrices: { wethUsd: 1700, usdcUsd: 1 },
    enabledProtocols: ["uniswap"],
    balances: { ethWei: "1", wethWei: "1", usdcUnits: "1" },
    inventory: { valueUsdc: 100, weth: 1, usdc: 1, eth: 1 },
    history: [],
    limits: {
      maxWethInWei: "1",
      maxUsdcInUnits: "1",
      defaultPriorityFeePerGasWei: "100000000",
      maxPriorityFeePerGasWei: "5000000000",
      defaultSlippageBps: 75,
      maxBundleActions: 5,
      maxLpWethWei: "1",
      maxLpUsdcUnits: "1",
      maxOpenPositions: 10,
      maxGmxSizeUsd: "0",
      maxAaveSupplyWethWei: "0",
      maxAaveBorrowUsdcUnits: "0",
    },
    protocols: {
      uniswap: {
        pool: {
          pair: "WETH/USDC",
          fee: 500,
          priceUsdcPerWeth: 1690,
          tick: 0,
          tickSpacing: 10,
        },
        positions: [],
      },
    },
  } as AgentObservation;
}

test("extractJsonObject: 素の JSON / 前後に prose / コード内の中括弧・クォート", () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('Here is the strategy:\n{"a":1}\nDone.'), {
    a: 1,
  });
  // executor_ts にコード(中括弧・エスケープされたクォート)が入っても balanced に取れる
  const code =
    '{"notes":"n","params":{"x":1},"executor_ts":"if (g) { return { type: \\"noop\\" }; }"}';
  const parsed = extractJsonObject(code) as Record<string, unknown>;
  assert.equal((parsed.params as Record<string, number>).x, 1);
  assert.match(parsed.executor_ts as string, /return \{ type: "noop" \}/);
  assert.equal(extractJsonObject("no json here"), null);
});

test("ClaudeCliStrategist.init: stdout の JSON を戦略にパースする", async () => {
  const stdout =
    '{"notes":"spread arb v1","params":{"minGapBps":15},"executor_ts":"return { type: \\"noop\\", reason: \\"flat\\" };"}';
  const s = new ClaudeCliStrategist({ spawnFn: fakeSpawn(stdout) });
  const r = await s.init(obs(), 1);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.strategy.version, 1);
    assert.equal((r.strategy.params as Record<string, number>).minGapBps, 15);
    assert.match(r.strategy.executorTs, /noop/);
  }
});

test("ClaudeCliStrategist: 非ゼロ終了は失敗", async () => {
  const s = new ClaudeCliStrategist({ spawnFn: fakeSpawn("boom", 1) });
  const r = await s.init(obs(), 1);
  assert.equal(r.ok, false);
});

test("ClaudeCliStrategist: JSON が無ければ失敗", async () => {
  const s = new ClaudeCliStrategist({
    spawnFn: fakeSpawn("I refuse to do that.", 0),
  });
  const r = await s.init(obs(), 1);
  assert.equal(r.ok, false);
});
