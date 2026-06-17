import { test } from "node:test";
import assert from "node:assert/strict";
import { softResetWarning } from "../src/multiSeedRun.js";

test("softResetWarning: forkUrl があれば警告しない(null)", () => {
  assert.equal(softResetWarning("https://rpc.example", [1, 2], 3), null);
});

test("softResetWarning: forkUrl 未設定なら警告文字列を返す", () => {
  const w = softResetWarning(undefined, [3, 4], 2);
  assert.ok(w, "警告が返る");
  assert.match(w as string, /ARB_RPC_URL/);
  assert.match(w as string, /soft-reset/);
  // run 総数(regime×rep)を伝える
  assert.match(w as string, /4 run = 2 regime × 2 rep/);
});

test("softResetWarning: 空文字も未設定扱い(soft-reset へ落ちるため)", () => {
  assert.ok(softResetWarning("", [1], 1), "空 forkUrl は警告対象");
});
