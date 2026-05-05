import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", () => {
  process.stdout.write(`${JSON.stringify({ type: "noop", reason: "baseline" })}\n`);
});
