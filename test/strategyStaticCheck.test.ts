import test from "node:test";
import assert from "node:assert/strict";
import { findCheatcodeUsage } from "../src/strategyStaticCheck.js";

test("findCheatcodeUsage: cheatcode RPC を行番号つきで検出する", () => {
  const source = [
    "const obs = JSON.parse(line);",
    'await client.request({ method: "anvil_setBalance", params: [me, cap] });',
    'await client.request({ method: "evm_increaseTime", params: [3600] });',
  ].join("\n");
  const findings = findCheatcodeUsage(source);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => [f.line, f.match]),
    [
      [2, "anvil_setBalance"],
      [3, "evm_increaseTime"],
    ],
  );
});

test("findCheatcodeUsage: 環境専用の特権ヘルパ import も検出する", () => {
  const findings = findCheatcodeUsage(
    'import { dealErc20, setEthBalance } from "../../src/chain.js";',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "chain.ts の特権ヘルパ（環境専用）");
});

test("findCheatcodeUsage: 健全な戦略コードは素通しする", () => {
  const source = [
    "const gap = fair / pool - 1;",
    'emit({ type: "swap", tokenIn: "WETH", amountIn: amountIn.toString() });',
    "const evmCompatible = true; // evm という語単体は検出しない",
  ].join("\n");
  assert.deepEqual(findCheatcodeUsage(source), []);
});
