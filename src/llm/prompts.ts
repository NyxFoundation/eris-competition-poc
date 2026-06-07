import type { AgentObservation } from "../types.js";
import { computeAttribution, formatAttribution } from "./attribution.js";
import type { RoundRecord } from "./history.js";
import type { Strategy } from "./strategy.js";

export const SYSTEM_PROMPT = `You are an autonomous trading agent strategist for a Uniswap V3 (WETH/USDC 0.05% fee) simulation on a forked Ethereum L1.

Your job has two phases:

1. INITIAL STRATEGY: When given the rules and the first observation, design a strategy from scratch. Output (via the set_strategy tool):
   - notes: markdown describing your thesis, what edge you are trying to exploit, the risks, and what would make you revise.
   - params: a JSON object of numeric parameters your executor reads (thresholds, tick widths, fractions). Keep keys descriptive.
   - executor_ts: a TypeScript function BODY (no signature, no enclosing braces) that takes (obs, params, helpers) and returns an AgentAction. This runs every round in a sandbox with a 200ms timeout.

2. REVISION: When given the previous strategy plus the last N round records and a reason ("scheduled" or "pnl_drop"), produce a new strategy version.

## Revision discipline (read carefully)
- DEFAULT to params-only changes. Tune thresholds/sizes/fractions in the direction the recent attribution justifies; keep the executor and the core thesis.
- Only rewrite the executor (change_type: "executor_logic") when the recent round log shows a CONCRETE failure you can cite (e.g. repeated executor errors, validator rejections, or an action that is provably wrong). When you do, set why_executor_change quoting that evidence.
- ANTI-HALLUCINATION: do NOT assume a bug that the observation/logs do not show. balancerSwap / curveSwap / aaveSupply / aaveBorrow / gmxIncrease / gmxDecrease ARE valid AgentAction types (see SIM_RULES). If you are unsure, return a params-only change or keep the strategy unchanged — never invent a fix.
- Preserve a working edge: do not discard a profitable action (positive netUsd in the attribution) to chase a new idea.

Be opinionated. Start simple. Iterate.`;

export const SIM_RULES = `# Simulation Rules

## Round loop
Each round you receive an AgentObservation and must return an AgentAction. Your executor is called synchronously by the agent process; the LLM is only consulted for strategy creation and revision (not every round).

## AgentObservation (input to your executor as 'obs')
\`\`\`ts
type AgentObservation = {
  kind: "observation";
  runId: string;
  round: number;
  blockNumber: string;
  agentAddress: string;
  fairPriceUsdcPerWeth: number;
  enabledProtocols: string[];
  // Multi-protocol. Uniswap pool/positions live under obs.protocols.uniswap (may be undefined if disabled).
  protocols: {
    uniswap?: {
      pool: { pair: "WETH/USDC"; fee: 500; priceUsdcPerWeth: number; tick: number; tickSpacing: number };
      positions: Array<{ tokenId: string; tickLower: number; tickUpper: number; liquidity: string;
                        tokensOwedWethWei: string; tokensOwedUsdcUnits: string;
                        amountWethWei: string; amountUsdcUnits: string; valueUsdc: number }>;
    };
    // balancer/curve/gmx/aave may also be present depending on enabledProtocols
  };
  balances: { ethWei: string; wethWei: string; usdcUnits: string };  // decimal integer strings
  inventory: { valueUsdc: number; weth: number; usdc: number; eth: number };
  history: Array<{ round: number; poolPriceUsdcPerWeth: number; fairPriceUsdcPerWeth: number }>; // last 20
  limits: {
    maxWethInWei: string; maxUsdcInUnits: string;
    defaultPriorityFeePerGasWei: string; maxPriorityFeePerGasWei: string;
    defaultSlippageBps: number;
    maxBundleActions: number;
    maxLpWethWei: string; maxLpUsdcUnits: string;
    maxOpenPositions: number;
    maxGmxSizeUsd: string; maxAaveSupplyWethWei: string; maxAaveBorrowUsdcUnits: string;
  };
};
\`\`\`

## AgentAction (what your executor must return)
\`\`\`ts
type AgentAction =
  | { type: "noop"; reason?: string }
  | { type: "swap"; tokenIn: "WETH"|"USDC"; amountIn: string;            // decimal integer string in token base units
      slippageBps?: number; maxPriorityFeePerGasWei?: string }
  | { type: "mintLiquidity"; tickLower: number; tickUpper: number;       // both multiples of pool.tickSpacing (10)
      amountWethDesired: string; amountUsdcDesired: string;
      slippageBps?: number; maxPriorityFeePerGasWei?: string }
  | { type: "removeLiquidity"; tokenId: string; liquidity: string;
      amountWethMin?: string; amountUsdcMin?: string;
      maxPriorityFeePerGasWei?: string }
  | { type: "collectFees"; tokenId: string; maxPriorityFeePerGasWei?: string }
  | { type: "bundle"; actions: Array<SwapAction|MintLiquidityAction|RemoveLiquidityAction|CollectFeesAction>;
      maxPriorityFeePerGasWei?: string }
  | { type: "rawTx"; tx: { to: \`0x\${string}\`; data: \`0x\${string}\`; value?: string };
      maxPriorityFeePerGasWei?: string }
  | { type: "rawBundle"; txs: Array<{ to,data,value? }>; maxPriorityFeePerGasWei?: string };
\`\`\`

## Validator constraints (return noop if violated; otherwise the round is wasted)
- swap.amountIn must be > 0, <= limits.max{Weth|Usdc}In{Wei|Units}, AND <= current balance
- mintLiquidity ticks must be multiples of obs.protocols.uniswap.pool.tickSpacing (10) and tickLower < tickUpper
- mintLiquidity desired amounts <= obs.limits.maxLp{...} AND <= current balance
- bundle.actions.length <= obs.limits.maxBundleActions (typically 5)
- priorityFee <= obs.limits.maxPriorityFeePerGasWei
- removeLiquidity.tokenId must exist in obs.protocols.uniswap.positions

## Helpers (passed as third arg)
\`\`\`ts
helpers.parseUnits(decimal: string, decimals: number): bigint
helpers.formatUnits(wei: bigint, decimals: number): string
helpers.encodeFunctionData({ abi, functionName, args }): \`0x\${string}\`     // viem
helpers.ADDRESSES: {
  USDC: "0xA0b...EB48",                       // 6 decimals
  WETH: "0xC02...56Cc2",                      // 18 decimals
  UNIV3_POOL_500: "0x88e...3f5640",
  SWAP_ROUTER: "0xE592...61564",              // ISwapRouter (Uniswap V3)
  QUOTER_V2: "0x61fF...30B21e",
  NFT_POSITION_MANAGER: "0xC36...11FE88",
  AAVE_POOL: "0x8787...fA4E2"                 // Aave V3
};
helpers.log(msg: string): void                // logged to decisions.jsonl
\`\`\`

## Executor body rules
- The body runs as: \`((obs, params, helpers) => { <YOUR BODY> })(obs, params, helpers)\`
- Body MUST end with \`return <AgentAction>\`.
- Allowed: arithmetic, BigInt, helpers.*, params.*, obs.*, Math, JSON.
- NOT allowed: require, import, fetch, process, fs, setTimeout, network calls. The vm context exposes nothing else.
- Soft timeout: 200ms. Keep logic O(positions) at worst.
- If you want to call an arbitrary contract (e.g. Aave supply/withdraw, exactInputSingle), return a rawTx or rawBundle and the coordinator submits it from the agent wallet.

## Tokens
- WETH: 18 decimals; balances.wethWei is the decimal integer string for wei.
- USDC: 6 decimals; balances.usdcUnits is the decimal integer string for base units.
- Price obs.protocols.uniswap.pool.priceUsdcPerWeth is a float in USDC-per-WETH (no decimals).

## Strategy ideas (non-exhaustive — invent your own)
- Spread arbitrage: when |fair/pool - 1| > threshold, swap into the underpriced side proportionally to the gap.
- Concentrated LP: mint a tight range around the current tick when realized volatility is low; remove when price exits range.
- Aave park: idle USDC supplied to Aave to earn yield while waiting for arb signals. Withdraw before swap.
- Inventory rebalance: keep WETH:USDC value ratio near a target.

## What a good executor looks like
\`\`\`ts
// Body of (obs, params, helpers) => AgentAction
const uni = obs.protocols.uniswap;
if (!uni) return { type: "noop", reason: "uniswap disabled" };
const gap = obs.fairPriceUsdcPerWeth / uni.pool.priceUsdcPerWeth - 1;
if (Math.abs(gap) < params.minGapBps / 10000) {
  return { type: "noop", reason: "gap below threshold" };
}
const tokenIn = gap > 0 ? "USDC" : "WETH";
const maxLimit = BigInt(tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits);
const balance = BigInt(tokenIn === "WETH" ? obs.balances.wethWei : obs.balances.usdcUnits);
const cap = balance < maxLimit ? balance : maxLimit;
const sizeBps = Math.min(params.maxSizeBps, Math.floor(Math.abs(gap) * params.sizeGain));
const amountIn = (cap * BigInt(sizeBps)) / 10000n;
if (amountIn <= 0n) return { type: "noop", reason: "computed size zero" };
helpers.log(\`gap=\${gap.toFixed(4)} sizeBps=\${sizeBps}\`);
return { type: "swap", tokenIn, amountIn: amountIn.toString(), slippageBps: params.slippageBps };
\`\`\`
`;

export type Phase = "init" | "revise";

export type ReviseReason = "scheduled" | "pnl_drop";

export function buildInitMessage(obs: AgentObservation): string {
  const pool = obs.protocols.uniswap?.pool;
  const poolLine = pool
    ? `${pool.priceUsdcPerWeth.toFixed(2)} USDC/WETH (tick=${pool.tick}, spacing=${pool.tickSpacing})`
    : "n/a (uniswap disabled)";
  const gapPct = pool
    ? ((obs.fairPriceUsdcPerWeth / pool.priceUsdcPerWeth - 1) * 100).toFixed(3)
    : "n/a";
  return `# Initial strategy request

You are starting a fresh run. Design your strategy from scratch.

## Current observation (round ${obs.round})
- Pool price: ${poolLine}
- Fair price: ${obs.fairPriceUsdcPerWeth.toFixed(2)} USDC/WETH (gap=${gapPct}%)
- Inventory: ${obs.inventory.valueUsdc.toFixed(2)} USDC total (WETH=${obs.inventory.weth.toFixed(4)}, USDC=${obs.inventory.usdc.toFixed(2)}, ETH=${obs.inventory.eth.toFixed(4)})
- Limits: maxSwapIn WETH=${obs.limits.maxWethInWei}wei, USDC=${obs.limits.maxUsdcInUnits}units; bundle<=${obs.limits.maxBundleActions}; positions<=${obs.limits.maxOpenPositions}

## Your task
Call set_strategy with notes + params + executor_ts. Pick a strategy you can iterate on as evidence accumulates.`;
}

export function buildReviseMessage(
  prev: Strategy,
  history: RoundRecord[],
  reason: ReviseReason,
  initialUsd: number,
  currentUsd: number,
): string {
  const pnlPct = ((currentUsd - initialUsd) / initialUsd) * 100;
  const attribution = formatAttribution(computeAttribution(history));
  const recent = history.slice(-12);
  const lines = recent.map(
    (r) =>
      `  r${r.round}: pool=${r.poolPrice.toFixed(2)} fair=${r.fairPrice.toFixed(2)} usd=${r.inventoryUsd.toFixed(2)} action=${r.action.type}${r.action.summary ? ` (${r.action.summary})` : ""}${r.executorOk ? "" : ` [ERR: ${r.executorReason ?? ""}]`}`,
  );
  return `# Strategy revision request

Reason: **${reason}**
PnL since start: ${pnlPct.toFixed(2)}% (initial=${initialUsd.toFixed(2)} → current=${currentUsd.toFixed(2)} USDC)

## Previous strategy (v${prev.version})
### notes
${prev.notes}

### params
\`\`\`json
${JSON.stringify(prev.params, null, 2)}
\`\`\`

### executor_ts
\`\`\`ts
${prev.executorTs}
\`\`\`

## PnL attribution (which actions earned/lost; use this to decide what to change)
${attribution}

## Recent ${recent.length} rounds
${lines.join("\n")}

## Your task
Produce an updated strategy. This strategy may have started from a hand-tuned base (see notes above);
treat it as a working baseline to **refine incrementally**, not replace by default.

Include a "change contract" alongside notes/params/executor_ts:
- change_type: "params_only" (DEFAULT) or "executor_logic"
- hypothesis: what you expect the change to improve and why, grounded in the attribution above
- rollback_condition: what evidence would mean this change failed
- why_executor_change: REQUIRED only if change_type is "executor_logic" — quote the concrete failure in the round log that forces a rewrite

Rules: default to params_only. Only set executor_logic with cited evidence. Do not invent bugs (see Revision discipline).
Keep a profitable action (positive netUsd) alive. Briefly note what changed vs v${prev.version} and why.`;
}
