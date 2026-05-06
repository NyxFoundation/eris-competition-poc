import type { AgentAction, AgentObservation, BalanceSnapshot, BundleActionItem } from "./types.js";

export type ActionValidation =
  | { ok: true; action: { type: "noop"; reason?: string }; intents: []; priorityFeeWei: 0n; slippageBps: 0 }
  | { ok: true; action: AgentAction; intents: Array<{ action: BundleActionItem; priorityFeeWei: bigint; bundleId?: string; bundleIndex?: number }> }
  | { ok: false; reason: string };

const DECIMAL_INTEGER = /^[0-9]+$/;

export function parseAction(raw: unknown): AgentAction {
  if (!raw || typeof raw !== "object") throw new Error("action must be an object");
  const obj = raw as Record<string, unknown>;
  if (obj.type === "noop") {
    return { type: "noop", reason: typeof obj.reason === "string" ? obj.reason : undefined };
  }
  if (obj.type === "bundle") return parseBundleAction(obj);
  return parseBundleActionItem(obj);
}

export function validateAction(action: AgentAction, observation: AgentObservation, balances: BalanceSnapshot): ActionValidation {
  if (action.type === "noop") return { ok: true, action, intents: [], priorityFeeWei: 0n, slippageBps: 0 };
  if (action.type === "bundle") {
    if (action.actions.length === 0) return { ok: false, reason: "bundle actions must not be empty" };
    if (action.actions.length > observation.limits.maxBundleActions) return { ok: false, reason: "bundle action count exceeds configured max" };
    const bundlePriority = action.maxPriorityFeePerGasWei;
    const bundleId = `${observation.runId}:${observation.round}:${hashAction(action)}`;
    return validateActionItems(
      action,
      action.actions,
      observation,
      balances,
      bundlePriority === undefined ? undefined : BigInt(bundlePriority),
      bundleId
    );
  }
  return validateActionItems(action, [action], observation, balances);
}

function parseBundleAction(obj: Record<string, unknown>): AgentAction {
  if (!Array.isArray(obj.actions)) throw new Error("bundle actions must be an array");
  const action: Extract<AgentAction, { type: "bundle" }> = {
    type: "bundle",
    actions: obj.actions.map((item) => {
      if (!item || typeof item !== "object") throw new Error("bundle action must be an object");
      const itemType = (item as Record<string, unknown>).type;
      if (itemType === "noop") throw new Error("bundle cannot contain noop");
      if (itemType === "bundle") throw new Error("bundle cannot contain nested bundle");
      const parsed = parseBundleActionItem(item as Record<string, unknown>);
      return parsed;
    })
  };
  addPriorityFee(action, obj);
  return action;
}

function parseBundleActionItem(obj: Record<string, unknown>): BundleActionItem {
  if (obj.type === "swap") return parseSwapAction(obj);
  if (obj.type === "mintLiquidity") return parseMintLiquidityAction(obj);
  if (obj.type === "removeLiquidity") return parseRemoveLiquidityAction(obj);
  if (obj.type === "collectFees") return parseCollectFeesAction(obj);
  throw new Error("type must be noop, swap, mintLiquidity, removeLiquidity, collectFees, or bundle");
}

function parseSwapAction(obj: Record<string, unknown>): BundleActionItem {
  if (obj.tokenIn !== "WETH" && obj.tokenIn !== "USDC") throw new Error("tokenIn must be WETH or USDC");
  requireDecimalString(obj.amountIn, "amountIn");
  const action: BundleActionItem = {
    type: "swap",
    tokenIn: obj.tokenIn,
    amountIn: obj.amountIn
  };
  addPriorityFee(action, obj);
  addSlippage(action, obj);
  return action;
}

function parseMintLiquidityAction(obj: Record<string, unknown>): BundleActionItem {
  const tickLower = requireInteger(obj.tickLower, "tickLower");
  const tickUpper = requireInteger(obj.tickUpper, "tickUpper");
  requireDecimalString(obj.amountWethDesired, "amountWethDesired");
  requireDecimalString(obj.amountUsdcDesired, "amountUsdcDesired");
  const action: BundleActionItem = {
    type: "mintLiquidity",
    tickLower,
    tickUpper,
    amountWethDesired: obj.amountWethDesired,
    amountUsdcDesired: obj.amountUsdcDesired
  };
  addPriorityFee(action, obj);
  addSlippage(action, obj);
  return action;
}

function parseRemoveLiquidityAction(obj: Record<string, unknown>): BundleActionItem {
  requireDecimalString(obj.tokenId, "tokenId");
  requireDecimalString(obj.liquidity, "liquidity");
  const action: BundleActionItem = {
    type: "removeLiquidity",
    tokenId: obj.tokenId,
    liquidity: obj.liquidity
  };
  if (obj.amountWethMin !== undefined) {
    requireDecimalString(obj.amountWethMin, "amountWethMin");
    action.amountWethMin = obj.amountWethMin;
  }
  if (obj.amountUsdcMin !== undefined) {
    requireDecimalString(obj.amountUsdcMin, "amountUsdcMin");
    action.amountUsdcMin = obj.amountUsdcMin;
  }
  addPriorityFee(action, obj);
  return action;
}

function parseCollectFeesAction(obj: Record<string, unknown>): BundleActionItem {
  requireDecimalString(obj.tokenId, "tokenId");
  const action: BundleActionItem = { type: "collectFees", tokenId: obj.tokenId };
  addPriorityFee(action, obj);
  return action;
}

function validateActionItems(
  original: AgentAction,
  actions: BundleActionItem[],
  observation: AgentObservation,
  balances: BalanceSnapshot,
  bundlePriorityFeeWei?: bigint,
  bundleId?: string
): ActionValidation {
  if (bundlePriorityFeeWei !== undefined && bundlePriorityFeeWei > BigInt(observation.limits.maxPriorityFeePerGasWei)) {
    return { ok: false, reason: "priority fee exceeds configured max" };
  }

  let totalLpWeth = 0n;
  let totalLpUsdc = 0n;
  let newLpPositions = 0;
  const intents = [];
  for (let i = 0; i < actions.length; i++) {
    const item = actions[i];
    const priorityFeeWei = bundlePriorityFeeWei ?? BigInt(item.maxPriorityFeePerGasWei ?? observation.limits.defaultPriorityFeePerGasWei);
    if (priorityFeeWei > BigInt(observation.limits.maxPriorityFeePerGasWei)) {
      return { ok: false, reason: "priority fee exceeds configured max" };
    }

    const result = validateSingleAction(item, observation, balances);
    if (!result.ok) return result;
    if (item.type === "mintLiquidity") {
      newLpPositions++;
      totalLpWeth += BigInt(item.amountWethDesired);
      totalLpUsdc += BigInt(item.amountUsdcDesired);
      if (totalLpWeth > balances.wethWei || totalLpUsdc > balances.usdcUnits) return { ok: false, reason: "LP desired amounts exceed confirmed balances" };
      if (totalLpWeth > BigInt(observation.limits.maxLpWethWei) || totalLpUsdc > BigInt(observation.limits.maxLpUsdcUnits)) {
        return { ok: false, reason: "LP desired amounts exceed configured LP limits" };
      }
      if (observation.positions.length + newLpPositions > observation.limits.maxOpenPositions) {
        return { ok: false, reason: "open LP position count exceeds configured max" };
      }
    }
    intents.push({
      action: item,
      priorityFeeWei,
      bundleId,
      bundleIndex: bundleId === undefined ? undefined : i
    });
  }
  return { ok: true, action: original, intents };
}

function validateSingleAction(action: BundleActionItem, observation: AgentObservation, balances: BalanceSnapshot): { ok: true } | { ok: false; reason: string } {
  if (action.type === "swap") {
    const amountIn = BigInt(action.amountIn);
    if (amountIn <= 0n) return { ok: false, reason: "amountIn must be positive" };
    const maxAllowed = action.tokenIn === "WETH" ? BigInt(observation.limits.maxWethInWei) : BigInt(observation.limits.maxUsdcInUnits);
    if (amountIn > maxAllowed) return { ok: false, reason: "amountIn exceeds configured per-round limit" };
    const balance = action.tokenIn === "WETH" ? balances.wethWei : balances.usdcUnits;
    if (amountIn > balance) return { ok: false, reason: "amountIn exceeds balance" };
    return { ok: true };
  }

  if (action.type === "mintLiquidity") {
    const weth = BigInt(action.amountWethDesired);
    const usdc = BigInt(action.amountUsdcDesired);
    if (weth <= 0n && usdc <= 0n) return { ok: false, reason: "LP desired amount must be positive" };
    if (action.tickLower >= action.tickUpper) return { ok: false, reason: "tickLower must be less than tickUpper" };
    if (action.tickLower % observation.pool.tickSpacing !== 0 || action.tickUpper % observation.pool.tickSpacing !== 0) {
      return { ok: false, reason: "ticks must align to pool tick spacing" };
    }
    if (weth > BigInt(observation.limits.maxLpWethWei) || usdc > BigInt(observation.limits.maxLpUsdcUnits)) {
      return { ok: false, reason: "LP desired amounts exceed configured LP limits" };
    }
    if (weth > balances.wethWei || usdc > balances.usdcUnits) return { ok: false, reason: "LP desired amounts exceed balance" };
    if (observation.positions.length >= observation.limits.maxOpenPositions) return { ok: false, reason: "open LP position count exceeds configured max" };
    return { ok: true };
  }

  const position = observation.positions.find((item) => item.tokenId === action.tokenId);
  if (!position) return { ok: false, reason: "tokenId is not owned by agent" };
  if (action.type === "removeLiquidity") {
    const liquidity = BigInt(action.liquidity);
    if (liquidity <= 0n) return { ok: false, reason: "liquidity must be positive" };
    if (liquidity > BigInt(position.liquidity)) return { ok: false, reason: "liquidity exceeds owned position liquidity" };
  }
  return { ok: true };
}

function addPriorityFee(action: { maxPriorityFeePerGasWei?: string }, obj: Record<string, unknown>): void {
  if (obj.maxPriorityFeePerGasWei === undefined) return;
  requireDecimalString(obj.maxPriorityFeePerGasWei, "maxPriorityFeePerGasWei");
  action.maxPriorityFeePerGasWei = obj.maxPriorityFeePerGasWei;
}

function addSlippage(action: { slippageBps?: number }, obj: Record<string, unknown>): void {
  if (obj.slippageBps === undefined) return;
  const slippageBps = requireInteger(obj.slippageBps, "slippageBps");
  if (slippageBps < 0 || slippageBps > 1000) throw new Error("slippageBps must be an integer between 0 and 1000");
  action.slippageBps = slippageBps;
}

function requireDecimalString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value)) throw new Error(`${name} must be a decimal integer string`);
}

function requireInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function hashAction(action: AgentAction): string {
  const json = JSON.stringify(action);
  let hash = 0;
  for (let i = 0; i < json.length; i++) hash = (hash * 31 + json.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}
