import test from "node:test";
import assert from "node:assert/strict";
import {
  OllamaStrategist,
  type OllamaFetch,
} from "../src/llm/ollamaStrategist.js";
import type { AgentObservation } from "../src/types.js";

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

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      model: "gpt-oss:120b",
      message: { role: "assistant", content },
      done: true,
      prompt_eval_count: 11,
      eval_count: 13,
    }),
    { status: 200 },
  );
}

const strategyJson =
  '{"notes":"ollama spread arb","params":{"minGapBps":12},"executor_ts":"return { type: \\"noop\\", reason: \\"flat\\" };"}';

test("OllamaStrategist.init: direct Cloud API に /api/chat で POST し戦略 JSON をパースする", async () => {
  const captured: { url?: string; init?: RequestInit } = {};
  const fetchFn: OllamaFetch = async (input, init) => {
    captured.url = String(input);
    captured.init = init;
    return okResponse(strategyJson);
  };
  const s = new OllamaStrategist({
    apiKey: "test-key",
    baseUrl: "https://ollama.com",
    fetchFn,
  });

  const r = await s.init(obs(), 1);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.strategy.version, 1);
    assert.equal((r.strategy.params as Record<string, number>).minGapBps, 12);
    assert.equal(r.meta.inputTokens, 11);
    assert.equal(r.meta.outputTokens, 13);
  }
  assert.equal(captured.url, "https://ollama.com/api/chat");
  assert.equal(
    (captured.init?.headers as Record<string, string>).Authorization,
    "Bearer test-key",
  );
  const body = JSON.parse(String(captured.init?.body)) as {
    model: string;
    stream: boolean;
    format: string;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.model, "gpt-oss:120b");
  assert.equal(body.stream, false);
  assert.equal(body.format, "json");
  assert.match(body.messages[0].content, /Output \(Ollama Cloud API mode/);
});

test("OllamaStrategist: 429 は retry し、404 は retry しない", async () => {
  let retryCalls = 0;
  const retryFetch: OllamaFetch = async () => {
    retryCalls++;
    if (retryCalls === 1) return new Response("rate limited", { status: 429 });
    return okResponse(strategyJson);
  };
  const retried = await new OllamaStrategist({
    apiKey: "test-key",
    fetchFn: retryFetch,
    sleepFn: async () => {},
    maxRetries: 2,
  }).init(obs(), 1);
  assert.equal(retried.ok, true);
  assert.equal(retryCalls, 2);

  let notFoundCalls = 0;
  const notFoundFetch: OllamaFetch = async () => {
    notFoundCalls++;
    return new Response("missing model", { status: 404 });
  };
  const notFound = await new OllamaStrategist({
    apiKey: "test-key",
    fetchFn: notFoundFetch,
    sleepFn: async () => {},
    maxRetries: 3,
  }).init(obs(), 1);
  assert.equal(notFound.ok, false);
  assert.match(notFound.reason, /HTTP 404/);
  assert.equal(notFoundCalls, 1);
});

test("OllamaStrategist: API key 未設定 / JSON 無しは失敗する", async () => {
  const noKey = await new OllamaStrategist({
    apiKey: "",
    fetchFn: async () => okResponse(strategyJson),
  }).init(obs(), 1);
  assert.equal(noKey.ok, false);
  assert.match(noKey.reason, /OLLAMA_API_KEY/);

  const noJson = await new OllamaStrategist({
    apiKey: "test-key",
    fetchFn: async () => okResponse("not json"),
  }).init(obs(), 1);
  assert.equal(noJson.ok, false);
  assert.match(noJson.reason, /no JSON object/);
});
