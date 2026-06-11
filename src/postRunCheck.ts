// 事後ルール検査（ADR 0006 §5）。direct モードでは validateAction の事前検査を agent が
// 素通りできるため、ルール執行は「チェーンに残った事実（blocks.csv）」の機械検査へ移す。
// fee 上限超過は --order fees の順序に影響する market-distorting 違反なので、検出時は
// 違反 agent のフラグに加えて当該 run を無効化する（evaluate が再実行する）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BLOCKS_CSV_INDEX } from "./logger.js";

export type FeeViolation = {
  ownerId: string;
  hash: string;
  blockNumber: number;
  priorityFeeWei: string;
  maxPriorityFeeWei: string;
};

// blocks.csv の agent 行から priority fee 上限超過を検出する純粋関数。
// fee はチェーン上の tx フィールド由来（自己申告ではない）なので改竄できない。
export function checkFeeViolations(
  blocksCsv: string,
  maxPriorityFeeWei: bigint,
): FeeViolation[] {
  const I = BLOCKS_CSV_INDEX;
  const violations: FeeViolation[] = [];
  for (const line of blocksCsv.split("\n").slice(1)) {
    if (line.length === 0) continue;
    const cols = line.split(",");
    if (cols[I.role] !== "agent") continue;
    let fee: bigint;
    try {
      fee = BigInt(cols[I.priorityFeeWei]);
    } catch {
      continue;
    }
    if (fee > maxPriorityFeeWei) {
      violations.push({
        ownerId: cols[I.ownerId],
        hash: cols[I.hash],
        blockNumber: Number(cols[I.blockNumber]),
        priorityFeeWei: cols[I.priorityFeeWei],
        maxPriorityFeeWei: maxPriorityFeeWei.toString(),
      });
    }
  }
  return violations;
}

export function checkRunFeeViolations(
  runDir: string,
  maxPriorityFeeWei: bigint,
): FeeViolation[] {
  const path = join(runDir, "blocks.csv");
  if (!existsSync(path)) return [];
  return checkFeeViolations(readFileSync(path, "utf8"), maxPriorityFeeWei);
}
