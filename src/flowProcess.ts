import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { FlowKind } from "./protocols/types.js";
import type { LeafAction, ProtocolId } from "./types.js";
import type { FlowContextWire } from "./flow/logic.js";
import { safeStringify } from "./logger.js";

// bot から返る 1 注文の wire 形（JSON 経由なので priorityFeeWei は文字列）。
export type FlowOrderWire = {
  protocol: ProtocolId;
  kind: FlowKind;
  action: LeafAction;
  priorityFeeWei: string;
};

// orderflow bot を独立プロセスとして起動し、毎ラウンド FlowContext を渡して
// FlowOrder[] を受け取る。AgentProcess と同じ行 JSON プロトコル。
// bot は RPC に触れず（agent と同じ分離原則）、注文を決めるだけ。
export class FlowProcess {
  private child: ChildProcessWithoutNullStreams;
  private pending: Array<(line: string) => void> = [];
  private stderr = "";
  private alive = true;

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
      },
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
    // spawn 失敗・プロセス終了・stdin pipe error で sim をクラッシュさせず、以後は空注文で継続する。
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

  async requestOrders(
    context: FlowContextWire,
    timeoutMs: number,
  ): Promise<FlowOrderWire[]> {
    if (!this.alive || this.child.killed) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const linePromise = new Promise<string>((resolve) =>
        this.pending.push(resolve),
      );
      // write は同期 throw（EPIPE 等）し得るため try 内に置く。
      this.child.stdin.write(`${safeStringify(context)}\n`);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("flow bot timeout")),
          timeoutMs,
        );
        timer.unref();
      });
      const line = await Promise.race([linePromise, timeout]);
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? (parsed as FlowOrderWire[]) : [];
    } catch {
      // bot 不調時は「市場注文なし」で安全に継続（sim は止めない）。
      return [];
    } finally {
      // 成功時に未発火の timeout を残さない（round 数に比例したタイマー滞留を防ぐ）。
      if (timer) clearTimeout(timer);
    }
  }

  close(): void {
    this.child.kill();
  }

  getStderr(): string {
    return this.stderr;
  }
}
