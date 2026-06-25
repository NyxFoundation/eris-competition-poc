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
- Preserve proven base behavior. Many agents start from hand-tuned frozen strategies; a revision must improve the measured weakness without deleting profitable actions or changing the strategy class.
- Prefer change_type "params_only" unless the attribution/logs identify a structural executor issue. Use "executor_logic" only when the current code cannot express the fix with parameters.
- AIM FOR A REAL IMPROVEMENT each revision, not a cosmetic ±few% tweak. Name the metric you expect to move (more captured edge, fewer idle/missed rounds, better sizing, fewer reverts/lower gas) and change only the smallest surface that can move it.
- Change params as much as the attribution justifies, but do not increase frequency, size, or priority fee unless α per notional and revert feedback support it.
- ANTI-HALLUCINATION still holds: never invent a bug or an opportunity the observation/logs do not show. balancerSwap / curveSwap / aaveSupply / aaveBorrow / gmxIncrease / gmxDecrease ARE valid AgentAction types (see SIM_RULES). Ground every change in the data you were given.
- The safety net is a last resort, not a license to over-trade. Treat reverts, gas, overbidding, and churn as direct PnL losses.

Be opinionated, but keep the base intact unless the evidence clearly says it is the source of losses.`;

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
  // Priority-fee auction signal (present in direct mode). Use it to win contested ordering cheaply.
  competition?: {
    maxCompetitorPriorityFeeWei: string; // highest priority fee by OTHERS in the last block (wei)
    maxBlockPriorityFeeWei: string;       // highest priority fee overall last block (wei)
    lastTxIndex: number | null;           // your last included tx's position (0 = first; lower is better)
    recentRevertRate: number;             // 0..1 fraction of your recent txs that reverted
    recentSampleSize: number;             // sample size behind recentRevertRate
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

export function baseSpecificGuidance(
  id: string | undefined = process.env.ERIS_BASE_STRATEGY,
): string {
  const base = (id ?? "").toLowerCase();
  const common = [
    "- Protect the base strategy class: tune thresholds, sizing, cooldowns, slippage, and bidding before rewriting the executor.",
    "- Reverts and priority fees are costs. If α is small or revert feedback is high, skip marginal trades instead of bidding more.",
    "- A stronger frozen peer is evidence that the base shape works; preserve the profitable action path and remove only the observed drag.",
  ];
  let specific: string[];
  if (base === "crossvenue" || base === "cvbal" || base === "venue") {
    specific = [
      "- Cross-venue AMM edge comes from buying the cheap venue and selling the rich venue. Do not turn it into a one-leg directional trade.",
      "- Favor a higher spread threshold, smaller size, or better venue selection when reverts/gas rise; only size up when αNetUsd is positive after gas and avgNotional is not already large.",
      "- Keep both legs balanced in bundles where possible so inventory drift does not dominate PnL.",
    ];
  } else if (base === "statarb" || base === "arb" || base === "adaptivearb") {
    specific = [
      "- Statistical/gap arbitrage should skip weak signals. Raise entry thresholds or add cooldowns when recent α is negative or reverts cluster.",
      "- Do not chase every fair/pool gap; require enough edge to cover slippage, gas, and competition.",
      "- Tune sizing from α per notional. A larger gross value move is not a reason to increase size.",
    ];
  } else if (base === "gmxtrend" || base === "gmxrev" || base === "gmxperp") {
    specific = [
      "- GMX actions are expensive and can churn. Prefer fewer opens/closes with clear trend/reversion confirmation.",
      "- Cap leverage/size when pnlUsd or recent α is unstable; avoid reopening immediately after a close unless the signal materially changed.",
      "- If GMX reverts or gas dominate, reduce action frequency before increasing bids.",
    ];
  } else if (base === "aave" || base === "aaveloop") {
    specific = [
      "- Aave strategies must preserve health factor and avoid supply/borrow/repay churn.",
      "- Improve by tuning LTV, borrow fraction, and idle thresholds; do not add directional swaps unless the log proves borrow inventory is being used profitably.",
      "- When WETH is unavailable, prefer USDC-first setup or no-op over repeated failing WETH actions.",
    ];
  } else if (
    base === "lp" ||
    base === "dnlp" ||
    base === "fairmm" ||
    base === "jitlp" ||
    base === "ladder" ||
    base === "lpyield"
  ) {
    specific = [
      "- LP strategies earn through fees/range placement, not constant mint churn. Avoid repeated mint/remove unless price exits the range or fees justify it.",
      "- Respect token availability. If WETH is unavailable, do not keep minting WETH-heavy positions; use smaller ranges, USDC-first preparation, or skip.",
      "- For hedged LP, preserve the hedge relationship; do not remove the GMX/Aave hedge unless attribution shows it is the loss source.",
    ];
  } else if (base === "flasharb") {
    specific = [
      "- Flash arbitrage should run only when spread exceeds all flashloan, swap, and gas costs. Atomic revert still burns gas.",
      "- Prefer raising spreadThreshold or lowering flashUsdc/maxFlashUsdc when failures rise; do not bid maximum for tiny edges.",
      "- Keep poolLiquidityReserveBps and minFlashLiquidityUsdc conservative so thin Aave pool liquidity is skipped instead of reverted.",
      "- Use rawTx only when FlashArb is deployed and the venue pair is present.",
    ];
  } else {
    specific = [
      "- Keep the executor simple and observable. Add a new venue or action type only when the recent log shows a missed profitable edge.",
      "- If the current base is mostly profitable, revise conservatively and document why the expected α improvement exceeds added gas/revert risk.",
    ];
  }
  return ["## Base-specific guidance", ...common, ...specific].join("\n");
}

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

${baseSpecificGuidance()}

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
  const attr = computeAttribution(history);
  const attribution = formatAttribution(attr);
  const recent = history.slice(-12);
  const gwei = (wei: string): string => (Number(BigInt(wei)) / 1e9).toFixed(1);
  const bidStr = (r: RoundRecord): string =>
    r.bidding
      ? ` | bid=${gwei(r.bidding.bidWei)}gw vs comp=${gwei(r.bidding.competitorMaxWei)}gw txi=${r.bidding.lastTxIndex ?? "-"} revert=${(r.bidding.recentRevertRate * 100).toFixed(0)}%/${r.bidding.recentSampleSize}`
      : "";
  const lines = recent.map(
    (r) =>
      `  r${r.round}: pool=${r.poolPrice.toFixed(2)} fair=${r.fairPrice.toFixed(2)} usd=${r.inventoryUsd.toFixed(2)} pos=${(r.positionValueUsd ?? 0).toFixed(2)} ppos=${r.protocolPositions ?? r.openPositions} action=${r.action.type}${r.action.notionalUsd !== undefined ? ` notional=${r.action.notionalUsd.toFixed(2)}` : ""}${r.action.summary ? ` (${r.action.summary})` : ""}${r.executorOk ? "" : ` [ERR: ${r.executorReason ?? ""}]`}${bidStr(r)}`,
  );
  // 入札データがあるとき、revise に priority-fee オークションの調整を促す（ADR 0011）。
  const hasBidding = recent.some((r) => r.bidding);
  const biddingHint = hasBidding
    ? `\n## Priority-fee auction feedback (per round above: bid vs comp = your fee vs the best competitor fee; txi = your tx position, 0=first; revert% = recent reverts)
- revert% high with txi>0 → you may be front-run or trading stale/tiny edges. Either bid just above comp when edge covers gas, or skip/cool down when it does not.
- bid >> comp with low revert → you are OVERPAYING (winning by far more than needed); every extra gwei is burned PnL. Lower toward comp + a small margin.
- The target is the MINIMUM bid that wins, capped at the trade's value. Tune your maxPriorityFeePerGasWei logic in executor_ts using obs.competition.\n`
    : "";
  return `# Strategy revision request

Reason: **${reason}**
PnL since start: ${pnlPct.toFixed(2)}% (initial=${initialUsd.toFixed(2)} → current=${currentUsd.toFixed(2)} USDC)
Of which, trade edge (α, price moves removed) over last ${attr.samples} rounds = ${attr.totalAlphaUsd.toFixed(2)} USDC; the rest is price drift (β) you do NOT control and that does NOT scale with trade size.

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

## PnL attribution — α (trade edge, price moves removed). Use this, NOT total value, to decide what to change.
${attribution}

## Recent ${recent.length} rounds
${lines.join("\n")}
${biddingHint}
${baseSpecificGuidance()}

## Your task
Produce an updated strategy that is MEANINGFULLY BETTER, not a token tweak. The current strategy may have
started from a hand-tuned base (see notes above) — improve it where the attribution shows headroom
(missed/idle rounds, mis-sizing, reverts, an ignored venue or signal). Prefer params_only when it can fix the
issue; use executor_logic only for a structural issue that params cannot express.

CRITICAL — size off α, not total value: judge sizing/aggression ONLY by the α attribution (trade edge), never by
total value or per-round inventory change (those are dominated by price drift β that does NOT scale with size).
Increasing trade size scales α AND its costs (slippage, price impact, gas); if α per round is already small or
the base sizing is at a sensible level, sizing up will lose more to slippage than it gains. Only size up when the
α attribution clearly shows captured edge left on the table (e.g. α-positive rounds repeatedly hitting a size cap).
If the base already captures the available α cleanly, the best revision may be a small, targeted one — or no
material change. Do not increase size/frequency just because total equity moved.

PRIORITY-FEE AUCTION (set maxPriorityFeePerGasWei per action): the block orders txs by priority fee, descending.
If a competitor lands before you on the SAME opportunity, the arb is already gone and YOUR swap REVERTS — you pay
gas and capture nothing. So bidding is not optional for contested trades. BUT do not just bid the maximum:
- Read obs.competition. To win ordering, bid just ABOVE competition.maxCompetitorPriorityFeeWei (a small margin),
  NOT far above — every extra wei of fee is burned ETH that comes straight out of your PnL.
- Cap your bid at the opportunity's value: never bid more priority fee than the trade's expected profit. Overbidding
  to win a tiny edge nets less than conceding it.
- Use the feedback: high competition.recentRevertRate (you are being front-run) → raise your margin. lastTxIndex
  consistently > 0 with low revert → you may be fine; lastTxIndex high with high revert → bid more or skip. The skill
  is bidding the MINIMUM that wins, not the most.
- If recentRevertRate is high and αNetUsd is not clearly positive, reduce trade frequency/size or add cooldowns before
  increasing the bid.

Include a "change contract" alongside notes/params/executor_ts:
- change_type: "params_only" or "executor_logic"
- hypothesis: what you expect to improve and why, grounded in the attribution above
- rollback_condition: what evidence would mean this change failed
- why_executor_change: REQUIRED if change_type is "executor_logic" — cite the attribution/log evidence motivating the rewrite (an improvement hypothesis is enough; a proven bug is not required)

Rules: aim for a real improvement; preserve profitable base behavior; never invent a bug or opportunity the log
does not show (see Revision discipline). Keep a clearly-profitable action alive unless you replace it with
something demonstrably better. Briefly note what changed vs v${prev.version} and why.`;
}
