import type { AgentAction, AgentObservation } from "../types.js";

export type RoundRecord = {
  round: number;
  poolPrice: number;
  fairPrice: number;
  inventoryUsd: number;
  weth: number;
  usdc: number;
  eth: number;
  openPositions: number;
  action: { type: string; summary?: string };
  executorLogs: string[];
  executorOk: boolean;
  executorReason?: string;
  // priority-fee オークションの結果（ADR 0011。competition シグナルがある direct モードのみ）。
  // revise が「先約定されて revert していないか／積みすぎていないか」を見て入札を調整できるようにする。
  bidding?: {
    bidWei: string; // この round に積んだ priority fee
    competitorMaxWei: string; // 直近ブロックの競合最高入札
    lastTxIndex: number | null; // 自分の直近 included tx の txIndex（0=先頭）
    recentRevertRate: number; // 直近 included tx の revert 率 0..1
  };
};

/**
 * Ring buffer of the last N round records. Used to give Claude context
 * during revision without blowing up the prompt size.
 */
export class History {
  private buf: RoundRecord[] = [];
  private initialUsd: number | null = null;

  constructor(readonly capacity = 30) {}

  setInitialUsd(usd: number): void {
    if (this.initialUsd === null) this.initialUsd = usd;
  }

  getInitialUsd(): number | null {
    return this.initialUsd;
  }

  push(record: RoundRecord): void {
    this.buf.push(record);
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  recent(): RoundRecord[] {
    return [...this.buf];
  }

  latest(): RoundRecord | null {
    return this.buf.length === 0 ? null : this.buf[this.buf.length - 1];
  }

  size(): number {
    return this.buf.length;
  }
}

/**
 * Summarize an AgentAction down to a small, prompt-friendly string.
 * Keeps token usage low while preserving the decision shape.
 */
export function summarizeAction(action: AgentAction): {
  type: string;
  summary?: string;
} {
  if (action.type === "noop") return { type: "noop", summary: action.reason };
  if (action.type === "swap")
    return { type: "swap", summary: `${action.tokenIn} in=${action.amountIn}` };
  if (action.type === "mintLiquidity") {
    return {
      type: "mintLiquidity",
      summary: `ticks=[${action.tickLower},${action.tickUpper}] weth=${action.amountWethDesired} usdc=${action.amountUsdcDesired}`,
    };
  }
  if (action.type === "removeLiquidity")
    return {
      type: "removeLiquidity",
      summary: `id=${action.tokenId} liq=${action.liquidity}`,
    };
  if (action.type === "collectFees")
    return { type: "collectFees", summary: `id=${action.tokenId}` };
  if (action.type === "bundle")
    return { type: "bundle", summary: `${action.actions.length} actions` };
  if (action.type === "rawTx")
    return { type: "rawTx", summary: `to=${action.tx.to}` };
  if (action.type === "rawBundle")
    return { type: "rawBundle", summary: `${action.txs.length} txs` };
  return { type: "unknown" };
}

/**
 * Build a RoundRecord from this round's observation + the action we are about to emit.
 */
export function buildRoundRecord(
  obs: AgentObservation,
  action: AgentAction,
  executorOk: boolean,
  executorReason: string | undefined,
  executorLogs: string[],
): RoundRecord {
  return {
    round: obs.round,
    poolPrice: obs.protocols.uniswap?.pool.priceUsdcPerWeth ?? 0,
    fairPrice: obs.fairPriceUsdcPerWeth,
    inventoryUsd: obs.inventory.valueUsdc,
    weth: obs.inventory.weth,
    usdc: obs.inventory.usdc,
    eth: obs.inventory.eth,
    openPositions: obs.protocols.uniswap?.positions.length ?? 0,
    action: summarizeAction(action),
    executorLogs,
    executorOk,
    executorReason,
    bidding: obs.competition
      ? {
          bidWei:
            extractBidWei(action) ?? obs.limits.defaultPriorityFeePerGasWei,
          competitorMaxWei: obs.competition.maxCompetitorPriorityFeeWei,
          lastTxIndex: obs.competition.lastTxIndex,
          recentRevertRate: obs.competition.recentRevertRate,
        }
      : undefined,
  };
}

// action が積んだ priority fee（無指定は undefined → 既定にフォールバック）。
function extractBidWei(action: AgentAction): string | undefined {
  if ("maxPriorityFeePerGasWei" in action && action.maxPriorityFeePerGasWei)
    return String(action.maxPriorityFeePerGasWei);
  return undefined;
}
