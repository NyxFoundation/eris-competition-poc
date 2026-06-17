import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { FlowContextWire } from "../flow/logic.js";
import type { FlowOrderWire } from "../flowProcess.js";
import { safeStringify } from "../logger.js";

export type FlowOrdersHandler = (orders: FlowOrderWire[]) => void;

// 実時間モードの flow-bot プロセス。RealtimeAgentProcess と同じ push/stream モデル。
// coordinator → 子: 新ブロック毎に FlowContext を push。子 → coordinator: stdout の各行を
// FlowOrder[] として逐次ハンドラへ渡す（即 mempool relay 用）。bot は RPC に触れない。
export class RealtimeFlowProcess {
  private child: ChildProcessWithoutNullStreams;
  private stderr = "";
  private alive = true;
  private handler: FlowOrdersHandler | null = null;

  constructor(
    command: string,
    args: string[],
    flowSeed: number,
    runDir: string,
  ) {
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        NODE_ENV: process.env.NODE_ENV ?? "development",
        ERIS_FLOW_SEED: String(flowSeed),
        ERIS_RUN_DIR: runDir,
        ERIS_REALTIME: "1",
      },
    });

    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => {
      if (!this.handler) return;
      const trimmed = line.trim();
      if (trimmed === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        this.stderr += `bad flow line: ${
          error instanceof Error ? error.message : String(error)
        }\n`;
        return;
      }
      if (Array.isArray(parsed)) this.handler(parsed as FlowOrderWire[]);
    });
    this.child.stderr.on("data", (data) => {
      this.stderr += data.toString();
      if (this.stderr.length > 20_000) this.stderr = this.stderr.slice(-20_000);
    });
    this.child.on("error", (err) => {
      this.alive = false;
      this.stderr += `flow bot process error: ${err.message}\n`;
    });
    this.child.on("exit", () => {
      this.alive = false;
    });
    this.child.stdin.on("error", () => {
      this.alive = false;
    });
  }

  onOrders(handler: FlowOrdersHandler): void {
    this.handler = handler;
  }

  pushContext(context: FlowContextWire): void {
    if (!this.alive || this.child.killed) return;
    try {
      this.child.stdin.write(`${safeStringify(context)}\n`);
    } catch {
      this.alive = false;
    }
  }

  isAlive(): boolean {
    return this.alive && !this.child.killed;
  }

  close(): void {
    this.child.kill();
  }

  getStderr(): string {
    return this.stderr;
  }
}
