import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { buildSource, loadRunConfig, toEnvString } from "../src/runConfig.js";

test("toEnvString: 型ごとに loadConfig が読める文字列へ正規化する", () => {
  assert.equal(toEnvString(true), "1");
  assert.equal(toEnvString(false), "0");
  assert.equal(toEnvString(42), "42");
  assert.equal(toEnvString("uniswap"), "uniswap");
  // 文字列/数値配列 → CSV
  assert.equal(
    toEnvString(["uniswap", "balancer", "curve"]),
    "uniswap,balancer,curve",
  );
  // object / object 配列 → JSON
  assert.equal(toEnvString({ a: 1 }), '{"a":1}');
  assert.equal(toEnvString([{ type: "crash" }]), '[{"type":"crash"}]');
  assert.equal(toEnvString(null), "");
  assert.equal(toEnvString(undefined), "");
});

test("buildSource(ネストスキーマ) → loadConfig: SimConfig に反映される", () => {
  const source = buildSource({
    run: {
      seed: 7,
      blocks: 24,
      protocols: ["uniswap", "balancer"],
      economicGas: true,
    },
    funding: { wethWei: "0" },
    agents: [{ id: "x" }], // agents は source から除外される
  });
  // ネストキーは内部 env 名へ写される
  assert.equal(source.SEED, "7");
  assert.equal(source.ERIS_RUN_BLOCKS, "24");
  assert.equal(source.ENABLED_PROTOCOLS, "uniswap,balancer");
  assert.equal(source.ERIS_ECONOMIC_GAS, "1");
  assert.equal(source.INITIAL_WETH_WEI, "0");
  assert.equal("agents" in source, false);

  const config = loadConfig(source);
  assert.equal(config.seed, 7);
  assert.equal(config.runBlocks, 24);
  assert.deepEqual(config.enabledProtocols, ["uniswap", "balancer"]);
  assert.equal(config.economicGas, true);
  assert.equal(config.initialWethWei, 0n);
});

test("buildSource: per-base マップを <prefix>_<SYM>_<unit> へ展開（WETH=WEI）", () => {
  // WETH は fork 既定 registry にあるので unit 接尾辞（WEI）を導出できる。
  const source = buildSource({ funding: { base: { WETH: "5" } } });
  assert.equal(source.INITIAL_WETH_WEI, "5");
});

test("buildSource: 後方互換で大文字キーは env 名として通す", () => {
  const source = buildSource({ ENABLED_PROTOCOLS: ["uniswap"] });
  assert.equal(source.ENABLED_PROTOCOLS, "uniswap");
});

test("buildSource: overrides(内部 env 名) が最優先", () => {
  const source = buildSource({ run: { seed: 1 } }, { SEED: 99 });
  assert.equal(source.SEED, "99");
});

test("buildSource: 秘密 env のみ process.env から持ち込む（設定 env は持ち込まない）", () => {
  const prevRpc = process.env.ARB_RPC_URL;
  const prevBlocks = process.env.ERIS_RUN_BLOCKS;
  process.env.ARB_RPC_URL = "https://secret.example";
  process.env.ERIS_RUN_BLOCKS = "999"; // 設定 env はソースに混ぜない
  try {
    const source = buildSource({ SEED: 1 });
    assert.equal(source.ARB_RPC_URL, "https://secret.example"); // 秘密は持ち込む
    assert.equal(source.ERIS_RUN_BLOCKS, undefined); // 設定 env は無視（YAML 一本化）
  } finally {
    if (prevRpc === undefined) delete process.env.ARB_RPC_URL;
    else process.env.ARB_RPC_URL = prevRpc;
    if (prevBlocks === undefined) delete process.env.ERIS_RUN_BLOCKS;
    else process.env.ERIS_RUN_BLOCKS = prevBlocks;
  }
});

test("loadRunConfig: YAML ファイルから config + inline ロスターを解決する", () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-yaml-"));
  const path = join(dir, "eris.config.yaml");
  writeFileSync(
    path,
    [
      "run:",
      "  seed: 3",
      "  blocks: 12",
      "  protocols: [uniswap, curve]",
      "agents:",
      "  - id: noop",
      "    command: node",
      "    args: [--import, tsx, examples/agents/noop.ts]",
      "    wallet: AGENT1_PRIVATE_KEY",
      "  - id: arb",
      "    command: node",
      "    args: [--import, tsx, examples/agents/venue-arb.ts]",
      "    wallet: AGENT2_PRIVATE_KEY",
      "",
    ].join("\n"),
  );
  const { config, agents, configPath, source } = loadRunConfig(path);
  assert.equal(config.seed, 3);
  assert.equal(config.runBlocks, 12);
  assert.deepEqual(config.enabledProtocols, ["uniswap", "curve"]);
  assert.equal(configPath, path);
  assert.equal(source.ERIS_CONFIG, path); // 子へ伝播する設定ファイルパス
  assert.equal(agents.length, 2);
  assert.deepEqual(
    agents.map((a) => a.id),
    ["noop", "arb"],
  );
});

test("loadRunConfig: 存在しないパスは明示エラー", () => {
  assert.throws(() => loadRunConfig("/no/such/eris.config.yaml"), /not found/);
});
