import { run } from "../../src/llm/claudeAgent.js";

run().catch((error) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
