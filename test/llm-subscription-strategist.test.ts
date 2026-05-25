import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscriptionStrategist, type SdkLike } from "../src/llm/claudeSubscriptionStrategist.js";
import type { AgentObservation } from "../src/types.js";

const obs: AgentObservation = {
  kind: "observation",
  runId: "sub-test",
  round: 0,
  blockNumber: "1",
  agentAddress: "0x0000000000000000000000000000000000000001",
  pool: { pair: "WETH/USDC", fee: 500, priceUsdcPerWeth: 3000, tick: 0, tickSpacing: 10 },
  positions: [],
  fairPriceUsdcPerWeth: 3030,
  balances: { ethWei: "1000000000000000000", wethWei: "10000000000000000000", usdcUnits: "25000000000" },
  inventory: { valueUsdc: 55000, weth: 10, usdc: 25000, eth: 1 },
  history: [],
  limits: {
    maxWethInWei: "1000000000000000000",
    maxUsdcInUnits: "5000000000",
    defaultPriorityFeePerGasWei: "100000000",
    maxPriorityFeePerGasWei: "5000000000",
    defaultSlippageBps: 50,
    maxBundleActions: 5,
    maxLpWethWei: "1000000000000000000",
    maxLpUsdcUnits: "5000000000",
    maxOpenPositions: 10
  }
};

type FakeScript = {
  callTool?: { args: Record<string, unknown> };
  resultMessage?: Record<string, unknown> | null;
  throwInsteadOf?: "query" | null;
};

/**
 * Minimal fake of the SdkLike interface. The SDK's real `query` is replaced
 * with one that invokes the registered handler (if `callTool` is provided)
 * then yields a synthetic result message.
 */
function makeFakeSdk(script: FakeScript): { sdk: SdkLike; calls: { options: unknown }[] } {
  const calls: { options: unknown }[] = [];
  let registeredHandler: ((args: unknown) => Promise<unknown>) | null = null;

  const sdk: SdkLike = {
    createSdkMcpServer: ((opts: { name: string; tools?: Array<{ handler?: (args: unknown) => Promise<unknown> }> }) => {
      // Pick the first tool's handler and stash it for the fake query.
      const t = (opts.tools ?? [])[0];
      registeredHandler = t?.handler ?? null;
      return { type: "sdk", name: opts.name, instance: {} };
    }) as unknown as SdkLike["createSdkMcpServer"],
    tool: ((name: string, description: string, _schema: unknown, handler: (args: unknown) => Promise<unknown>) =>
      ({ name, description, handler })) as unknown as SdkLike["tool"],
    query: (({ options }: { options: unknown }) => {
      calls.push({ options });
      if (script.throwInsteadOf === "query") throw new Error("query exploded");

      async function* generator() {
        if (script.callTool && registeredHandler) {
          await registeredHandler(script.callTool.args);
        }
        if (script.resultMessage !== null) {
          yield (script.resultMessage ?? {
            type: "result",
            subtype: "success",
            duration_ms: 4321,
            usage: {
              input_tokens: 12345,
              output_tokens: 678,
              cache_read_input_tokens: 9000,
              cache_creation_input_tokens: 100
            }
          }) as unknown;
        }
      }
      return generator();
    }) as unknown as SdkLike["query"]
  };
  return { sdk, calls };
}

test("init captures the tool handler input and returns a Strategy", async () => {
  const { sdk } = makeFakeSdk({
    callTool: {
      args: {
        notes: "Spread arb",
        params: { minGapBps: 25 },
        executor_ts: `return { type: "noop", reason: "ok" };`
      }
    }
  });
  const strat = new ClaudeSubscriptionStrategist({ sdk });
  const result = await strat.init(obs, 1);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.strategy.version, 1);
    assert.equal(result.strategy.notes, "Spread arb");
    assert.equal(result.strategy.params.minGapBps, 25);
    assert.equal(result.meta.phase, "init");
    assert.equal(result.meta.inputTokens, 12345);
    assert.equal(result.meta.cacheReadInputTokens, 9000);
    assert.equal(result.meta.latencyMs, 4321);
  }
});

test("revise wires through buildReviseMessage and bumps version", async () => {
  const { sdk, calls } = makeFakeSdk({
    callTool: {
      args: {
        notes: "tighter",
        params: { minGapBps: 50 },
        executor_ts: `return { type: "noop", reason: "ok" };`
      },
    },
    resultMessage: {
      type: "result",
      subtype: "success",
      duration_ms: 1000,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }
    }
  });
  const strat = new ClaudeSubscriptionStrategist({ sdk });
  const prev = {
    version: 1,
    notes: "v1",
    params: { minGapBps: 25 },
    executorTs: `return { type: "noop" };`
  };
  const result = await strat.revise(prev, [], "scheduled", 100, 90, 2);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.strategy.version, 2);
    assert.equal(result.meta.phase, "revise");
  }
  // The user message in the prompt should be a single string; we just sanity-check
  // that options propagated.
  assert.equal(calls.length, 1);
  const opts = calls[0].options as { allowedTools: string[]; disallowedTools: string[]; permissionMode: string };
  assert.deepEqual(opts.allowedTools, ["mcp__strategy__set_strategy"]);
  assert.ok(opts.disallowedTools.includes("Bash"));
  assert.equal(opts.permissionMode, "bypassPermissions");
});

test("returns 'model did not call set_strategy' when handler never fires", async () => {
  const { sdk } = makeFakeSdk({}); // no callTool
  const strat = new ClaudeSubscriptionStrategist({ sdk });
  const result = await strat.init(obs, 1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /did not call set_strategy/);
    assert.ok(result.meta, "still records meta from the result message");
  }
});

test("propagates parse failures (invalid executor_ts)", async () => {
  const { sdk } = makeFakeSdk({
    callTool: {
      args: {
        notes: "broken",
        params: {},
        executor_ts: "return { type: 'noop' "   // unclosed
      }
    }
  });
  const strat = new ClaudeSubscriptionStrategist({ sdk });
  const result = await strat.init(obs, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /executor_ts syntax error/);
});

test("returns error when query throws", async () => {
  const { sdk } = makeFakeSdk({ throwInsteadOf: "query" });
  const strat = new ClaudeSubscriptionStrategist({ sdk });
  const result = await strat.init(obs, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /claude call failed: query exploded/);
});

test("surfaces error subtype from the SDK result message", async () => {
  const { sdk } = makeFakeSdk({
    resultMessage: {
      type: "result",
      subtype: "error_max_turns",
      duration_ms: 500,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    }
  });
  const strat = new ClaudeSubscriptionStrategist({ sdk });
  const result = await strat.init(obs, 1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /claude returned error_max_turns/);
    assert.equal(result.meta?.phase, "init");
  }
});
