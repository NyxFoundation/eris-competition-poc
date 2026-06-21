import test from "node:test";
import assert from "node:assert/strict";
import { bigintToStorageWord } from "../src/chain.js";
import { toPriceFeedAnswer } from "../src/realtime/priceFeed.js";
import { loadConfig } from "../src/config.js";

// ADR 0011 §1: env の価格確定を mempool tx から storage 直書きへ移す際の 32-byte ワード
// エンコード。slot 値の正しさ（int256 の two's complement・幅）はオンチェーンに出さず単体で固める。

test("bigintToStorageWord: 32-byte 幅でゼロパディングする", () => {
  assert.equal(bigintToStorageWord(0n), `0x${"0".repeat(64)}`);
  assert.equal(bigintToStorageWord(1n), `0x${"0".repeat(63)}1`);
  // hex 文字列は常に 0x + 64 桁
  assert.match(bigintToStorageWord(123456789n), /^0x[0-9a-f]{64}$/);
});

test("bigintToStorageWord: 正の価格 answer をそのまま格納する", () => {
  // $3000（8 桁固定小数）= 3000_00000000
  const answer = toPriceFeedAnswer(3000);
  assert.equal(answer, 300000000000n);
  const word = bigintToStorageWord(answer);
  // 下位バイトに 300000000000 が入り、上位はゼロ
  assert.equal(BigInt(word), answer);
});

test("bigintToStorageWord: int256 の負値は two's complement で表現する", () => {
  assert.equal(bigintToStorageWord(-1n), `0x${"f".repeat(64)}`);
  // -2^255（int256 最小値）も 32-byte に収まる
  const min = -(1n << 255n);
  const word = bigintToStorageWord(min);
  assert.equal(BigInt(word), (1n << 256n) + min);
  assert.match(word, /^0x[0-9a-f]{64}$/);
});

test("config: ERIS_ECONOMIC_GAS=1 で economicGas が立つ（既定 false）", () => {
  assert.equal(loadConfig({}).economicGas, false);
  assert.equal(loadConfig({ ERIS_ECONOMIC_GAS: "1" }).economicGas, true);
  assert.equal(loadConfig({ ERIS_ECONOMIC_GAS: "0" }).economicGas, false);
});

test("config: economicGas は endowment を控えめな placeholder へ縮小する（ADR 0011 §2）", () => {
  // 既定（0010）は 100 ETH 不変
  assert.equal(loadConfig({}).initialEthWei, 100_000_000_000_000_000_000n);
  // 経済化は placeholder（3 ETH）へ。0010 より小さく gas を実コスト化する
  const eco = loadConfig({ ERIS_ECONOMIC_GAS: "1" }).initialEthWei;
  assert.equal(eco, 3_000_000_000_000_000_000n);
  assert.ok(eco < 100_000_000_000_000_000_000n);
  // INITIAL_ETH_WEI 明示指定は経済化でも優先される（較正値の上書き）
  assert.equal(
    loadConfig({
      ERIS_ECONOMIC_GAS: "1",
      INITIAL_ETH_WEI: "7000000000000000000",
    }).initialEthWei,
    7_000_000_000_000_000_000n,
  );
});
