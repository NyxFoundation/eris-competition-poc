import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentAction, AgentObservation, AgentSpec } from "./types.js";
import { parseAction } from "./action.js";
import { safeStringify } from "./logger.js";

export class AgentProcess {
  private child: ChildProcessWithoutNullStreams;
  private pending: Array<(line: string) => void> = [];
  private stderr = "";

  constructor(readonly spec: AgentSpec, rpcUrl: string, agentAddress: string) {
    this.child = spawn(spec.command, spec.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        // Forward LLM-related vars from parent (spec.env can override below)
        ...forwardedParentEnv(),
        // Per-agent config from agents.<name>.json
        ...(spec.env ?? {}),
        // Always-forced values
        PATH: process.env.PATH ?? "",
        NODE_ENV: process.env.NODE_ENV ?? "development",
        ERIS_AGENT_ID: spec.id,
        ERIS_RPC_URL: rpcUrl,
        ERIS_AGENT_ADDRESS: agentAddress,
        REPORT_DIR: process.env.REPORT_DIR ?? "./runs"
      }
    });

    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => {
      const resolver = this.pending.shift();
      if (resolver) resolver(line);
    });
    this.child.stderr.on("data", (data) => {
      this.stderr += data.toString();
      if (this.stderr.length > 20_000) this.stderr = this.stderr.slice(-20_000);
    });
  }

  async requestAction(observation: AgentObservation, timeoutMs: number): Promise<AgentAction> {
    if (this.child.killed) return { type: "noop", reason: "agent process killed" };
    const linePromise = new Promise<string>((resolve) => this.pending.push(resolve));
    this.child.stdin.write(`${safeStringify(observation)}\n`);
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("agent timeout")), timeoutMs).unref();
    });
    try {
      const line = await Promise.race([linePromise, timeout]);
      return parseAction(JSON.parse(line));
    } catch (error) {
      return { type: "noop", reason: `${this.spec.id}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  close(): void {
    this.child.kill();
  }

  getStderr(): string {
    return this.stderr;
  }
}

/**
 * Forward a small whitelist of parent env vars to the child agent process.
 * Anything starting with ERIS_LLM_ is passed through (so users can do
 * `ERIS_LLM_MODEL=claude-haiku-4-5 npm run sim`), plus ANTHROPIC_API_KEY.
 * spec.env in the agents JSON overrides these.
 */
function forwardedParentEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) out.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("ERIS_LLM_") && v !== undefined) out[k] = v;
  }
  return out;
}
