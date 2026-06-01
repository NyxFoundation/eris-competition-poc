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
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // Strip parent Claude Code session vars so SDK-spawned claude
    // subprocesses authenticate via their own OAuth rather than inheriting
    // a foreign session id from the surrounding Claude Code harness.
    for (const k of Object.keys(childEnv)) {
      if (k.startsWith("CLAUDE_CODE_")) delete childEnv[k];
    }
    Object.assign(childEnv, spec.env ?? {});
    childEnv.NODE_ENV = process.env.NODE_ENV ?? "development";
    childEnv.ERIS_AGENT_ID = spec.id;
    childEnv.ERIS_RPC_URL = rpcUrl;
    childEnv.ERIS_AGENT_ADDRESS = agentAddress;
    childEnv.REPORT_DIR = process.env.REPORT_DIR ?? "./runs";

    this.child = spawn(spec.command, spec.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv
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

