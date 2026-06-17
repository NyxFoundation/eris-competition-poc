import test from "node:test";
import assert from "node:assert/strict";
import { CodexCliStrategist } from "../src/llm/codexCliStrategist.js";
import type { SpawnLike } from "../src/llm/claudeCliStrategist.js";
import type { AgentObservation } from "../src/types.js";

// stdout を返して close する fake spawn（実 codex を呼ばずに strategist をテスト）。
// 実引数(codex exec ...)も検証できるよう capture する。
function fakeSpawn(
  stdout: string,
  code = 0,
  captured?: { command?: string; args?: string[] },
): SpawnLike {
  return (command, args) => {
    if (captured) {
      captured.command = command;
      captured.args = args;
    }
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

test("CodexCliStrategist.init: codex stdout の JSON を戦略にパースする", async () => {
  const stdout =
    '{"notes":"codex spread arb","params":{"minGapBps":12},"executor_ts":"return { type: \\"noop\\", reason: \\"flat\\" };"}';
  const s = new CodexCliStrategist({ spawnFn: fakeSpawn(stdout) });
  const r = await s.init(obs(), 1);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.strategy.version, 1);
    assert.equal((r.strategy.params as Record<string, number>).minGapBps, 12);
    assert.match(r.strategy.executorTs, /noop/);
  }
});

test("CodexCliStrategist: `codex exec ... --sandbox read-only` で起動する", async () => {
  const cap: { command?: string; args?: string[] } = {};
  const s = new CodexCliStrategist({
    bin: "codex",
    spawnFn: fakeSpawn(
      '{"notes":"n","params":{},"executor_ts":"return {type:\\"noop\\"};"}',
      0,
      cap,
    ),
  });
  await s.init(obs(), 1);
  assert.equal(cap.command, "codex");
  assert.equal(cap.args?.[0], "exec");
  assert.ok(cap.args?.includes("--sandbox"), "--sandbox 指定");
  assert.ok(cap.args?.includes("read-only"), "read-only sandbox");
  assert.ok(cap.args?.includes("--skip-git-repo-check"));
  // system 契約がプロンプト(args[1])に畳まれている
  assert.match(cap.args?.[1] ?? "", /Output \(codex exec mode/);
});

test("CodexCliStrategist: model 指定時は --model を渡す / 未指定なら渡さない", async () => {
  const cap: { args?: string[] } = {};
  const okOut =
    '{"notes":"n","params":{},"executor_ts":"return {type:\\"noop\\"};"}';
  await new CodexCliStrategist({
    model: "gpt-5-codex",
    spawnFn: fakeSpawn(okOut, 0, cap),
  }).init(obs(), 1);
  assert.ok(cap.args?.includes("--model") && cap.args?.includes("gpt-5-codex"));
  const cap2: { args?: string[] } = {};
  await new CodexCliStrategist({
    model: undefined,
    spawnFn: fakeSpawn(okOut, 0, cap2),
  }).init(obs(), 1);
  assert.ok(
    !cap2.args?.includes("--model"),
    "model 未指定なら --model 無し(codex 既定に従う)",
  );
});

test("CodexCliStrategist: 非ゼロ終了 / JSON 無しは失敗", async () => {
  assert.equal(
    (
      await new CodexCliStrategist({ spawnFn: fakeSpawn("boom", 1) }).init(
        obs(),
        1,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await new CodexCliStrategist({ spawnFn: fakeSpawn("no json", 0) }).init(
        obs(),
        1,
      )
    ).ok,
    false,
  );
});
