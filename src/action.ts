import type { AgentAction, AgentObservation, BalanceSnapshot } from "./types.js";

export type ActionValidation =
  | { ok: true; action: AgentAction & { type: "swap" }; priorityFeeWei: bigint; slippageBps: number }
  | { ok: true; action: { type: "noop"; reason?: string }; priorityFeeWei: 0n; slippageBps: 0 }
  | { ok: false; reason: string };

export function parseAction(raw: unknown): AgentAction {
  if (!raw || typeof raw !== "object") throw new Error("action must be an object");
  const obj = raw as Record<string, unknown>;
  if (obj.type === "noop") {
    return { type: "noop", reason: typeof obj.reason === "string" ? obj.reason : undefined };
  }
  if (obj.type !== "swap") throw new Error("type must be noop or swap");
  if (obj.tokenIn !== "WETH" && obj.tokenIn !== "USDC") throw new Error("tokenIn must be WETH or USDC");
  if (typeof obj.amountIn !== "string" || !/^[0-9]+$/.test(obj.amountIn)) throw new Error("amountIn must be a decimal integer string");
  const action: AgentAction = {
    type: "swap",
    tokenIn: obj.tokenIn,
    amountIn: obj.amountIn
  };
  if (obj.maxPriorityFeePerGasWei !== undefined) {
    if (typeof obj.maxPriorityFeePerGasWei !== "string" || !/^[0-9]+$/.test(obj.maxPriorityFeePerGasWei)) {
      throw new Error("maxPriorityFeePerGasWei must be a decimal integer string");
    }
    action.maxPriorityFeePerGasWei = obj.maxPriorityFeePerGasWei;
  }
  if (obj.slippageBps !== undefined) {
    if (typeof obj.slippageBps !== "number" || !Number.isInteger(obj.slippageBps) || obj.slippageBps < 0 || obj.slippageBps > 1000) {
      throw new Error("slippageBps must be an integer between 0 and 1000");
    }
    action.slippageBps = obj.slippageBps;
  }
  return action;
}

export function validateAction(action: AgentAction, observation: AgentObservation, balances: BalanceSnapshot): ActionValidation {
  if (action.type === "noop") return { ok: true, action, priorityFeeWei: 0n, slippageBps: 0 };
  const amountIn = BigInt(action.amountIn);
  if (amountIn <= 0n) return { ok: false, reason: "amountIn must be positive" };
  const maxAllowed = action.tokenIn === "WETH" ? BigInt(observation.limits.maxWethInWei) : BigInt(observation.limits.maxUsdcInUnits);
  if (amountIn > maxAllowed) return { ok: false, reason: "amountIn exceeds configured per-round limit" };
  const balance = action.tokenIn === "WETH" ? balances.wethWei : balances.usdcUnits;
  if (amountIn > balance) return { ok: false, reason: "amountIn exceeds balance" };

  const priorityFeeWei = BigInt(action.maxPriorityFeePerGasWei ?? observation.limits.defaultPriorityFeePerGasWei);
  if (priorityFeeWei > BigInt(observation.limits.maxPriorityFeePerGasWei)) {
    return { ok: false, reason: "priority fee exceeds configured max" };
  }

  return {
    ok: true,
    action,
    priorityFeeWei,
    slippageBps: action.slippageBps ?? observation.limits.defaultSlippageBps
  };
}
