import type { Address } from "viem";
import type {
  AgentAction,
  AgentObservation,
  BalanceSnapshot,
  BundleActionItem,
  LeafAction,
  ProtocolId,
  RawTx,
} from "./types.js";
import {
  adapterForAction,
  enabledAdapters,
  getAdapter,
} from "./protocols/registry.js";

export type ValidatedIntent = {
  action: LeafAction;
  protocol: ProtocolId;
  priorityFeeWei: bigint;
  bundleId?: string;
  bundleIndex?: number;
};
export type ValidatedRawIntent = {
  tx: RawTx;
  priorityFeeWei: bigint;
  bundleId?: string;
  bundleIndex?: number;
};

export type ActionValidation =
  | {
      ok: true;
      action: { type: "noop"; reason?: string };
      intents: [];
      rawIntents: [];
      priorityFeeWei: 0n;
      slippageBps: 0;
    }
  | {
      ok: true;
      action: AgentAction;
      intents: ValidatedIntent[];
      rawIntents: ValidatedRawIntent[];
    }
  | { ok: false; reason: string };

const DECIMAL_INTEGER = /^[0-9]+$/;
const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

export function parseAction(raw: unknown): AgentAction {
  if (!raw || typeof raw !== "object")
    throw new Error("action must be an object");
  const obj = raw as Record<string, unknown>;
  if (obj.type === "noop") {
    return {
      type: "noop",
      reason: typeof obj.reason === "string" ? obj.reason : undefined,
    };
  }
  if (obj.type === "bundle") return parseBundleAction(obj);
  if (obj.type === "rawTx") return parseRawTxAction(obj);
  if (obj.type === "rawBundle") return parseRawBundleAction(obj);
  return parseLeafAction(obj);
}

// 各 adapter の parse を順に試し、最初に非 null を返したものを採用。
function parseLeafAction(obj: Record<string, unknown>): LeafAction {
  for (const adapter of enabledAdapters()) {
    const parsed = adapter.parse(obj);
    if (parsed) return parsed;
  }
  throw new Error(`unknown or disabled action type: ${String(obj.type)}`);
}

function parseBundleAction(obj: Record<string, unknown>): AgentAction {
  if (!Array.isArray(obj.actions))
    throw new Error("bundle actions must be an array");
  const action: Extract<AgentAction, { type: "bundle" }> = {
    type: "bundle",
    actions: obj.actions.map((item) => {
      if (!item || typeof item !== "object")
        throw new Error("bundle action must be an object");
      const itemType = (item as Record<string, unknown>).type;
      if (itemType === "noop") throw new Error("bundle cannot contain noop");
      if (itemType === "bundle")
        throw new Error("bundle cannot contain nested bundle");
      const parsed = parseLeafAction(item as Record<string, unknown>);
      const adapter = adapterForAction(parsed);
      if (!adapter.bundleable(parsed))
        throw new Error(`action type ${itemType} cannot be bundled`);
      return parsed as BundleActionItem;
    }),
  };
  addPriorityFee(action, obj);
  return action;
}

function parseRawTxAction(obj: Record<string, unknown>): AgentAction {
  if (!obj.tx || typeof obj.tx !== "object")
    throw new Error("rawTx must have a tx object");
  const tx = parseRawTx(obj.tx as Record<string, unknown>);
  const action: Extract<AgentAction, { type: "rawTx" }> = { type: "rawTx", tx };
  addPriorityFee(action, obj);
  return action;
}

function parseRawBundleAction(obj: Record<string, unknown>): AgentAction {
  if (!Array.isArray(obj.txs))
    throw new Error("rawBundle txs must be an array");
  if (obj.txs.length === 0) throw new Error("rawBundle txs must not be empty");
  const txs = obj.txs.map((item: unknown, i: number) => {
    if (!item || typeof item !== "object")
      throw new Error(`rawBundle txs[${i}] must be an object`);
    return parseRawTx(item as Record<string, unknown>);
  });
  const action: Extract<AgentAction, { type: "rawBundle" }> = {
    type: "rawBundle",
    txs,
  };
  addPriorityFee(action, obj);
  return action;
}

function parseRawTx(obj: Record<string, unknown>): RawTx {
  if (typeof obj.to !== "string" || !HEX_PATTERN.test(obj.to))
    throw new Error("raw tx to must be a hex string");
  if (typeof obj.data !== "string" || !HEX_PATTERN.test(obj.data))
    throw new Error("raw tx data must be a hex string");
  const tx: RawTx = { to: obj.to, data: obj.data };
  if (obj.value !== undefined) {
    requireDecimalString(obj.value, "raw tx value");
    tx.value = obj.value;
  }
  return tx;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

export function validateAction(
  action: AgentAction,
  observation: AgentObservation,
  balances: BalanceSnapshot,
): ActionValidation {
  if (action.type === "noop")
    return {
      ok: true,
      action,
      intents: [],
      rawIntents: [],
      priorityFeeWei: 0n,
      slippageBps: 0,
    };
  if (action.type === "rawTx") return validateRawTxAction(action, observation);
  if (action.type === "rawBundle")
    return validateRawBundleAction(action, observation);
  if (action.type === "bundle") {
    if (action.actions.length === 0)
      return { ok: false, reason: "bundle actions must not be empty" };
    if (action.actions.length > observation.limits.maxBundleActions)
      return {
        ok: false,
        reason: "bundle action count exceeds configured max",
      };
    const bundlePriority = action.maxPriorityFeePerGasWei;
    const bundleId = `${observation.runId}:${observation.round}:${hashAction(action)}`;
    return validateLeafItems(
      action,
      action.actions,
      observation,
      balances,
      bundlePriority === undefined ? undefined : BigInt(bundlePriority),
      bundleId,
    );
  }
  return validateLeafItems(
    action,
    [action as LeafAction],
    observation,
    balances,
  );
}

function validateLeafItems(
  original: AgentAction,
  actions: LeafAction[],
  observation: AgentObservation,
  balances: BalanceSnapshot,
  bundlePriorityFeeWei?: bigint,
  bundleId?: string,
): ActionValidation {
  if (
    bundlePriorityFeeWei !== undefined &&
    bundlePriorityFeeWei > BigInt(observation.limits.maxPriorityFeePerGasWei)
  ) {
    return { ok: false, reason: "priority fee exceeds configured max" };
  }

  // bundle 横断の累積残高/ポジション数を強制する。各 leaf を「これまでの leaf で消費した分を
  // 差し引いた残高」に対して検証し、複数 leaf が合計でウォレット残高や maxOpenPositions を
  // 超えるのを防ぐ（単発アクションでは効果なし）。
  const work: BalanceSnapshot = {
    ethWei: balances.ethWei,
    wethWei: balances.wethWei,
    usdcUnits: balances.usdcUnits,
    stables: { ...(balances.stables ?? {}) },
  };
  const baseLpPositions = observation.protocols.uniswap?.positions.length ?? 0;
  let newLpPositions = 0;

  const intents: ValidatedIntent[] = [];
  for (let i = 0; i < actions.length; i++) {
    const item = actions[i];
    const priorityFeeWei =
      bundlePriorityFeeWei ??
      BigInt(
        item.maxPriorityFeePerGasWei ??
          observation.limits.defaultPriorityFeePerGasWei,
      );
    if (priorityFeeWei > BigInt(observation.limits.maxPriorityFeePerGasWei)) {
      return { ok: false, reason: "priority fee exceeds configured max" };
    }

    const adapter = adapterForAction(item);
    const result = adapter.validate(item, observation, work);
    if (!result.ok) return result;

    if (item.type === "mintLiquidity") {
      if (
        baseLpPositions + newLpPositions >=
        observation.limits.maxOpenPositions
      ) {
        return {
          ok: false,
          reason: "open LP position count exceeds configured max",
        };
      }
      newLpPositions++;
    }
    applyLeafSpend(work, item, observation, adapter.stableToken);

    intents.push({
      action: item,
      protocol: adapter.id,
      priorityFeeWei,
      bundleId,
      bundleIndex: bundleId === undefined ? undefined : i,
    });
  }
  return { ok: true, action: original, intents, rawIntents: [] };
}

// swap leg が執行される venue の価格（USDC per WETH）。bundle 内のスワップ出力見積りに使う。
function swapVenuePrice(obs: AgentObservation, item: LeafAction): number {
  if (item.type === "swap")
    return (
      obs.protocols.uniswap?.pool.priceUsdcPerWeth ?? obs.fairPriceUsdcPerWeth
    );
  if (item.type === "balancerSwap")
    return obs.protocols.balancer?.priceUsdcPerWeth ?? obs.fairPriceUsdcPerWeth;
  if (item.type === "curveSwap")
    return obs.protocols.curve?.priceUsdcPerWeth ?? obs.fairPriceUsdcPerWeth;
  return obs.fairPriceUsdcPerWeth;
}

// leaf が消費する WETH / stable を working 残高から差し引き、スワップは出力トークンを見積って戻す
// （bundle 累積検証用）。出力 credit が無いと「USDC→WETH 買い → WETH→USDC 売り」の 2-leg 裁定が
// 売り leg で WETH 残高 0 と判定され reject される（USDC-only 配布で純 α を測る前提を壊す）。
// 見積りは venue 価格ベース。実際の slippage はオンチェーンで検査される（validator は粗い over-spend だけ防ぐ）。
function applyLeafSpend(
  work: BalanceSnapshot,
  item: LeafAction,
  observation: AgentObservation,
  stableToken?: Address,
): void {
  const stableKey = (stableToken ?? "").toLowerCase();
  const spendWeth = (amount: bigint) => {
    work.wethWei = work.wethWei > amount ? work.wethWei - amount : 0n;
  };
  const spendStable = (amount: bigint) => {
    work.usdcUnits = work.usdcUnits > amount ? work.usdcUnits - amount : 0n;
    if (work.stables && stableKey in work.stables) {
      const cur = work.stables[stableKey];
      work.stables[stableKey] = cur > amount ? cur - amount : 0n;
    }
  };
  const creditWeth = (amount: bigint) => {
    work.wethWei += amount;
  };
  const creditStable = (amount: bigint) => {
    work.usdcUnits += amount;
    if (work.stables && stableKey in work.stables)
      work.stables[stableKey] += amount;
  };
  const currentStable = (): bigint =>
    work.stables?.[stableKey] ?? work.usdcUnits;

  switch (item.type) {
    case "swap":
    case "balancerSwap":
    case "curveSwap": {
      const amt = BigInt(item.amountIn);
      const price = swapVenuePrice(observation, item);
      if (item.tokenIn === "WETH") {
        spendWeth(amt);
        // WETH→stable: 出力 stable ≈ amountWeth × price
        if (price > 0)
          creditStable(BigInt(Math.floor((Number(amt) / 1e18) * price * 1e6)));
      } else {
        spendStable(amt);
        // stable→WETH: 出力 WETH ≈ amountStable / price
        if (price > 0)
          creditWeth(BigInt(Math.floor((Number(amt) / 1e6 / price) * 1e18)));
      }
      break;
    }
    case "mintLiquidity":
      spendWeth(BigInt(item.amountWethDesired));
      spendStable(BigInt(item.amountUsdcDesired));
      break;
    case "aaveSupply":
      if (item.asset === "WETH") spendWeth(BigInt(item.amount));
      else spendStable(BigInt(item.amount));
      break;
    case "aaveRepay": {
      const amt =
        item.amount === "max"
          ? item.asset === "WETH"
            ? work.wethWei
            : currentStable()
          : BigInt(item.amount);
      if (item.asset === "WETH") spendWeth(amt);
      else spendStable(amt);
      break;
    }
    default:
      break; // borrow/withdraw/collectFees/removeLiquidity/gmx は入力を消費しない
  }
}

function validateRawTxAction(
  action: Extract<AgentAction, { type: "rawTx" }>,
  observation: AgentObservation,
): ActionValidation {
  const priorityFeeWei = BigInt(
    action.maxPriorityFeePerGasWei ??
      observation.limits.defaultPriorityFeePerGasWei,
  );
  if (priorityFeeWei > BigInt(observation.limits.maxPriorityFeePerGasWei)) {
    return { ok: false, reason: "priority fee exceeds configured max" };
  }
  return {
    ok: true,
    action,
    intents: [],
    rawIntents: [{ tx: action.tx, priorityFeeWei }],
  };
}

function validateRawBundleAction(
  action: Extract<AgentAction, { type: "rawBundle" }>,
  observation: AgentObservation,
): ActionValidation {
  if (action.txs.length > observation.limits.maxBundleActions) {
    return { ok: false, reason: "rawBundle tx count exceeds configured max" };
  }
  const priorityFeeWei = BigInt(
    action.maxPriorityFeePerGasWei ??
      observation.limits.defaultPriorityFeePerGasWei,
  );
  if (priorityFeeWei > BigInt(observation.limits.maxPriorityFeePerGasWei)) {
    return { ok: false, reason: "priority fee exceeds configured max" };
  }
  const bundleId = `${observation.runId}:${observation.round}:${hashAction(action)}`;
  const rawIntents = action.txs.map((tx, i) => ({
    tx,
    priorityFeeWei,
    bundleId,
    bundleIndex: i,
  }));
  return { ok: true, action, intents: [], rawIntents };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function addPriorityFee(
  action: { maxPriorityFeePerGasWei?: string },
  obj: Record<string, unknown>,
): void {
  if (obj.maxPriorityFeePerGasWei === undefined) return;
  requireDecimalString(obj.maxPriorityFeePerGasWei, "maxPriorityFeePerGasWei");
  action.maxPriorityFeePerGasWei = obj.maxPriorityFeePerGasWei;
}

function requireDecimalString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    throw new Error(`${name} must be a decimal integer string`);
}

function hashAction(action: AgentAction): string {
  const json = JSON.stringify(action);
  let hash = 0;
  for (let i = 0; i < json.length; i++)
    hash = (hash * 31 + json.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

// getAdapter re-export（coordinator から buildTxs 用に使う場合に備え）
export { getAdapter };
