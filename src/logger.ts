import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// blocks.csv の列スキーマ（単一の真実）。読む側（postRunCheck 等）はこのインデックスを使う。
export const BLOCKS_CSV_COLUMNS = [
  "round",
  "blockNumber",
  "txIndex",
  "hash",
  "from",
  "priorityFeeWei",
  "status",
  "ownerId",
  "role",
  "actionType",
  "bundleId",
  "bundleIndex",
] as const;

export const BLOCKS_CSV_INDEX = Object.fromEntries(
  BLOCKS_CSV_COLUMNS.map((name, i) => [name, i]),
) as Record<(typeof BLOCKS_CSV_COLUMNS)[number], number>;

export class RunLogger {
  readonly runDir: string;

  constructor(root: string, runId: string) {
    this.runDir = join(root, runId);
    mkdirSync(this.runDir, { recursive: true });
    writeFileSync(join(this.runDir, "events.jsonl"), "");
    writeFileSync(
      join(this.runDir, "blocks.csv"),
      `${BLOCKS_CSV_COLUMNS.join(",")}\n`,
    );
  }

  event(event: Record<string, unknown>): void {
    appendFileSync(
      join(this.runDir, "events.jsonl"),
      `${safeStringify({ ts: new Date().toISOString(), ...event })}\n`,
    );
  }

  blockRow(row: {
    round: number;
    blockNumber: bigint;
    txIndex: number;
    hash: string;
    from: string;
    priorityFeeWei: bigint;
    status: string;
    ownerId: string;
    role: string;
    actionType?: string;
    bundleId?: string;
    bundleIndex?: number;
  }): void {
    appendFileSync(
      join(this.runDir, "blocks.csv"),
      `${row.round},${row.blockNumber.toString()},${row.txIndex},${row.hash},${row.from},${row.priorityFeeWei.toString()},${row.status},${row.ownerId},${row.role},${row.actionType ?? ""},${row.bundleId ?? ""},${row.bundleIndex ?? ""}\n`,
    );
  }

  summary(summary: Record<string, unknown>): void {
    writeFileSync(
      join(this.runDir, "summary.json"),
      `${safeStringify(summary, 2)}\n`,
    );
  }
}

export function safeStringify(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, current) =>
      typeof current === "bigint" ? current.toString() : current,
    space,
  );
}
