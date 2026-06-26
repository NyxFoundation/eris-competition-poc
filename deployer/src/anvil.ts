import { spawn, type ChildProcess } from "node:child_process";
import { RPC_URL, RPC_PORT } from "./config.js";

let proc: ChildProcess | null = null;

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "web3_clientVersion",
        params: [],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntilUp(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isUp()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`anvil が ${RPC_URL} で起動しませんでした`);
}

/**
 * anvil を起動する。既に稼働中ならそれを使う。
 * - --code-size-limit: Uniswap V3 等の大型コントラクト対策で必須
 * - --base-fee 0: gas 計算を単純化
 * - --gas-limit: GMX のような重い tx に備え大きめ
 */
export async function startAnvil(): Promise<void> {
  if (await isUp()) {
    console.log(`anvil は既に起動済み (${RPC_URL}) — そのまま利用します`);
    return;
  }
  console.log(`anvil を起動します (port ${RPC_PORT})...`);
  proc = spawn(
    "anvil",
    [
      "--port",
      String(RPC_PORT),
      "--code-size-limit",
      "50000",
      "--base-fee",
      "0",
      "--gas-limit",
      "3000000000",
      "--accounts",
      "10",
      "--balance",
      "1000000",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  proc.on("exit", (code) => {
    if (code && code !== 0)
      console.error(`anvil が終了しました (code ${code})`);
  });
  await waitUntilUp();
  console.log("anvil 起動完了");
}

export function stopAnvil() {
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
    proc = null;
  }
}

export function anvilManagedHere(): boolean {
  return proc !== null;
}
