import { spawn } from "node:child_process";

const required = ["MAINNET_RPC_URL", "FORK_BLOCK_NUMBER"] as const;
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const args = [
  "--fork-url",
  process.env.MAINNET_RPC_URL!,
  "--fork-block-number",
  process.env.FORK_BLOCK_NUMBER!,
  "--no-mining",
  "--order",
  "fees",
  "--port",
  process.env.ANVIL_PORT ?? "8545",
  "--chain-id",
  process.env.CHAIN_ID ?? "31337",
  "--block-base-fee-per-gas",
  process.env.BASE_FEE_WEI ?? "1000000000"
];

const child = spawn("anvil", args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
