/**
 * analyze-priority-bids: aggregate per-agent priority-fee bids and inclusion
 *                       order from a sim run's blocks.csv.
 *
 * Reads `runs/<id>/blocks.csv` (columns: round, blockNumber, txIndex, hash,
 * from, priorityFeeWei, status, ownerId, role, actionType, bundleId,
 * bundleIndex) and prints a per-ownerId table with:
 *
 *   - tx count, success count, revert count
 *   - mean / p50 / p90 / max priority-fee bid (gwei)
 *   - mean txIndex (lower = included earlier within a block)
 *   - "win rate" = fraction of rounds where this owner had the lowest txIndex
 *     among agent-role tx (informed/uninformed-flow excluded).
 *
 * Usage:
 *   npx tsx scripts/analyze-priority-bids.ts runs/<run-id>
 *   npx tsx scripts/analyze-priority-bids.ts runs/2026-06-01T15-23-07-473Z
 *
 * Output is plain-text columnar so it can be eyeballed or piped into other
 * tools. Exits non-zero only on read/parse errors.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = {
  round: number;
  blockNumber: number;
  txIndex: number;
  priorityFeeWei: bigint;
  status: string;
  ownerId: string;
  role: string;
  actionType: string;
};

function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(",");
  const idx = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`missing column '${name}' in blocks.csv header: ${header.join(",")}`);
    return i;
  };
  const cRound = idx("round");
  const cBlock = idx("blockNumber");
  const cTxIdx = idx("txIndex");
  const cFee = idx("priorityFeeWei");
  const cStatus = idx("status");
  const cOwner = idx("ownerId");
  const cRole = idx("role");
  const cAction = idx("actionType");

  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length < header.length) continue;
    try {
      rows.push({
        round: Number(cells[cRound]),
        blockNumber: Number(cells[cBlock]),
        txIndex: Number(cells[cTxIdx]),
        priorityFeeWei: BigInt(cells[cFee] || "0"),
        status: cells[cStatus] ?? "",
        ownerId: cells[cOwner] ?? "",
        role: cells[cRole] ?? "",
        actionType: cells[cAction] ?? ""
      });
    } catch {
      // skip malformed line silently
    }
  }
  return rows;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

type Agg = {
  ownerId: string;
  txCount: number;
  successCount: number;
  revertCount: number;
  bidsGwei: number[];
  txIndices: number[];
  wins: number;
  rounds: Set<number>;
};

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padLeft(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function main(): void {
  const runDir = process.argv[2];
  if (!runDir) {
    process.stderr.write("usage: tsx scripts/analyze-priority-bids.ts <run-dir>\n");
    process.exit(2);
  }
  const csvPath = join(runDir, "blocks.csv");
  let text: string;
  try {
    text = readFileSync(csvPath, "utf8");
  } catch (err) {
    process.stderr.write(`failed to read ${csvPath}: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const rows = parseCsv(text);
  if (rows.length === 0) {
    process.stdout.write(`no rows in ${csvPath}\n`);
    return;
  }

  // Aggregate by ownerId. Per-round win = lowest agent-role txIndex.
  const aggs = new Map<string, Agg>();
  const agentRolesPerRound = new Map<number, Row[]>();

  for (const r of rows) {
    let agg = aggs.get(r.ownerId);
    if (!agg) {
      agg = {
        ownerId: r.ownerId,
        txCount: 0,
        successCount: 0,
        revertCount: 0,
        bidsGwei: [],
        txIndices: [],
        wins: 0,
        rounds: new Set()
      };
      aggs.set(r.ownerId, agg);
    }
    agg.txCount += 1;
    if (r.status === "success") agg.successCount += 1;
    else agg.revertCount += 1;
    agg.bidsGwei.push(Number(r.priorityFeeWei) / 1e9);
    agg.txIndices.push(r.txIndex);
    agg.rounds.add(r.round);

    if (r.role === "agent") {
      const list = agentRolesPerRound.get(r.round) ?? [];
      list.push(r);
      agentRolesPerRound.set(r.round, list);
    }
  }

  for (const [, list] of agentRolesPerRound) {
    if (list.length === 0) continue;
    let minIdx = Infinity;
    for (const r of list) if (r.txIndex < minIdx) minIdx = r.txIndex;
    const winners = new Set<string>();
    for (const r of list) if (r.txIndex === minIdx) winners.add(r.ownerId);
    for (const owner of winners) {
      const agg = aggs.get(owner);
      if (agg) agg.wins += 1;
    }
  }

  const ordered = [...aggs.values()].sort((a, b) => a.ownerId.localeCompare(b.ownerId));

  const totalAgentRounds = agentRolesPerRound.size;
  process.stdout.write(`run: ${runDir}\n`);
  process.stdout.write(`rows: ${rows.length}, agent-rounds: ${totalAgentRounds}\n\n`);

  const cols = [
    pad("ownerId", 22),
    padLeft("tx", 5),
    padLeft("ok", 5),
    padLeft("rev", 5),
    padLeft("rounds", 7),
    padLeft("bid_mean_gwei", 14),
    padLeft("bid_p50", 9),
    padLeft("bid_p90", 9),
    padLeft("bid_max", 9),
    padLeft("txIdx_mean", 11),
    padLeft("wins", 6),
    padLeft("win_rate", 9)
  ];
  process.stdout.write(`${cols.join(" ")}\n`);

  for (const agg of ordered) {
    const sortedBids = [...agg.bidsGwei].sort((a, b) => a - b);
    const bidMean = sortedBids.reduce((s, x) => s + x, 0) / Math.max(1, sortedBids.length);
    const bidP50 = quantile(sortedBids, 0.5);
    const bidP90 = quantile(sortedBids, 0.9);
    const bidMax = sortedBids.length > 0 ? sortedBids[sortedBids.length - 1] : 0;
    const txIdxMean = agg.txIndices.reduce((s, x) => s + x, 0) / Math.max(1, agg.txIndices.length);
    const winRate = totalAgentRounds > 0 ? agg.wins / totalAgentRounds : 0;
    const line = [
      pad(agg.ownerId, 22),
      padLeft(String(agg.txCount), 5),
      padLeft(String(agg.successCount), 5),
      padLeft(String(agg.revertCount), 5),
      padLeft(String(agg.rounds.size), 7),
      padLeft(bidMean.toFixed(3), 14),
      padLeft(bidP50.toFixed(3), 9),
      padLeft(bidP90.toFixed(3), 9),
      padLeft(bidMax.toFixed(3), 9),
      padLeft(txIdxMean.toFixed(2), 11),
      padLeft(String(agg.wins), 6),
      padLeft((winRate * 100).toFixed(1) + "%", 9)
    ];
    process.stdout.write(`${line.join(" ")}\n`);
  }
}

main();
