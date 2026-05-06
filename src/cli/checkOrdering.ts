import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type BlockRow = {
  round: number;
  blockNumber: string;
  txIndex: number;
  priorityFeeWei: bigint;
  hash: string;
  ownerId: string;
};

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run check:ordering -- <run_dir|blocks.csv>");
  process.exit(1);
}

const csvPath = input.endsWith(".csv") ? input : join(input, "blocks.csv");
if (!existsSync(csvPath)) {
  console.error(`Missing blocks.csv: ${csvPath}`);
  process.exit(1);
}

const rows = parseBlocksCsv(readFileSync(csvPath, "utf8"));
const failures = checkOrdering(rows);
if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`priority fee ordering ok: ${rows.length} tx rows checked`);

function parseBlocksCsv(csv: string): BlockRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length <= 1) return [];
  const header = lines[0].split(",");
  const required = ["round", "blockNumber", "txIndex", "hash", "priorityFeeWei", "ownerId"];
  for (const column of required) {
    if (!header.includes(column)) throw new Error(`blocks.csv missing required column: ${column}`);
  }

  return lines.slice(1).map((line, index) => {
    const values = line.split(",");
    const row = Object.fromEntries(header.map((column, columnIndex) => [column, values[columnIndex] ?? ""]));
    return {
      round: Number(row.round),
      blockNumber: row.blockNumber,
      txIndex: Number(row.txIndex),
      priorityFeeWei: BigInt(row.priorityFeeWei),
      hash: row.hash,
      ownerId: row.ownerId
    };
  }).sort((a, b) => a.round - b.round || Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || a.txIndex - b.txIndex);
}

function checkOrdering(rows: BlockRow[]): string[] {
  const failures: string[] = [];
  const grouped = new Map<string, BlockRow[]>();
  for (const row of rows) {
    const key = `${row.round}:${row.blockNumber}`;
    const blockRows = grouped.get(key) ?? [];
    blockRows.push(row);
    grouped.set(key, blockRows);
  }

  for (const [key, blockRows] of grouped) {
    blockRows.sort((a, b) => a.txIndex - b.txIndex);
    for (let i = 1; i < blockRows.length; i++) {
      const previous = blockRows[i - 1];
      const current = blockRows[i];
      if (previous.priorityFeeWei < current.priorityFeeWei && previous.ownerId !== current.ownerId) {
        failures.push(
          `priority fee ordering violation in ${key}: txIndex ${previous.txIndex} ${previous.ownerId} ${previous.priorityFeeWei} < txIndex ${current.txIndex} ${current.ownerId} ${current.priorityFeeWei}`
        );
      }
    }
  }
  return failures;
}
