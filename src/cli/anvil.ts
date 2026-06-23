import { spawn } from "node:child_process";

const required = ["ARB_RPC_URL"] as const;
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const args = [
  "--fork-url",
  process.env.ARB_RPC_URL!,
  "--no-mining",
  "--order",
  "fees",
  "--auto-impersonate",
  "--port",
  process.env.ANVIL_PORT ?? "8545",
  "--chain-id",
  process.env.CHAIN_ID ?? "42161",
  "--block-base-fee-per-gas",
  process.env.BASE_FEE_WEI ?? "100000000",
];

if (process.env.FORK_BLOCK_NUMBER) {
  args.splice(2, 0, "--fork-block-number", process.env.FORK_BLOCK_NUMBER);
}

// eth_getAccountInfo(Alchemy Arbitrum 非対応)の失敗リトライ待ちを削る。既定 1000ms の
// バックオフが cold state フェッチごとに累積して oracleMs を膨らませるため、0 で即フォールバックさせる。
if (process.env.FORK_RETRY_BACKOFF !== undefined) {
  args.push("--fork-retry-backoff", process.env.FORK_RETRY_BACKOFF);
}
// Alchemy 共有プランのレート制限(CUPS 推定)で頭打ちにしない。
if (process.env.ANVIL_NO_RATE_LIMIT === "1") {
  args.push("--no-rate-limit");
}

const child = spawn("anvil", args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
