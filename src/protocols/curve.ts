import { encodeFunctionData, type PublicClient } from "viem";
import { curveTricryptoAbi } from "../abis.js";
import { CURVE, TOKENS, stableBalanceOf } from "../constants.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  CurveSwapAction,
  LeafAction,
} from "../types.js";
import type { BuiltTx, ProtocolAdapter, ValidationResult } from "./types.js";
import { approveTx } from "./uniswap.js";

const DECIMAL_INTEGER = /^[0-9]+$/;

type CurveState = { priceUsdcPerWeth: number };

const PROBE_WETH = 100_000_000_000_000_000n; // 0.1 WETH

async function getDy(
  publicClient: PublicClient,
  i: number,
  j: number,
  dx: bigint,
): Promise<bigint> {
  return publicClient.readContract({
    address: CURVE.pool,
    abi: curveTricryptoAbi,
    functionName: "get_dy",
    args: [BigInt(i), BigInt(j), dx],
  }) as Promise<bigint>;
}

export async function getCurvePrice(
  publicClient: PublicClient,
): Promise<number> {
  // 0.1 WETH -> USDT(6dec) を 10 倍して 1 WETH あたりの USDC 相当価格に
  const out = await getDy(
    publicClient,
    CURVE.wethIndex,
    CURVE.usdtIndex,
    PROBE_WETH,
  );
  return (Number(out) * 10) / 1e6;
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

function requireDecimalString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    throw new Error(`${name} must be a decimal integer string`);
}

function parse(obj: Record<string, unknown>): LeafAction | null {
  if (obj.type !== "curveSwap") return null;
  if (obj.tokenIn !== "WETH" && obj.tokenIn !== "USDC")
    throw new Error("tokenIn must be WETH or USDC");
  requireDecimalString(obj.amountIn, "amountIn");
  const action: CurveSwapAction = {
    type: "curveSwap",
    tokenIn: obj.tokenIn,
    amountIn: obj.amountIn,
  };
  if (obj.maxPriorityFeePerGasWei !== undefined) {
    requireDecimalString(
      obj.maxPriorityFeePerGasWei,
      "maxPriorityFeePerGasWei",
    );
    action.maxPriorityFeePerGasWei = obj.maxPriorityFeePerGasWei;
  }
  if (obj.slippageBps !== undefined) {
    if (
      typeof obj.slippageBps !== "number" ||
      !Number.isInteger(obj.slippageBps) ||
      obj.slippageBps < 0 ||
      obj.slippageBps > 1000
    ) {
      throw new Error("slippageBps must be an integer between 0 and 1000");
    }
    action.slippageBps = obj.slippageBps;
  }
  return action;
}

function validate(
  action: LeafAction,
  obs: AgentObservation,
  balances: BalanceSnapshot,
): ValidationResult {
  if (action.type !== "curveSwap")
    return { ok: false, reason: "not a curve action" };
  const amountIn = BigInt(action.amountIn);
  if (amountIn <= 0n) return { ok: false, reason: "amountIn must be positive" };
  const maxAllowed =
    action.tokenIn === "WETH"
      ? BigInt(obs.limits.maxWethInWei)
      : BigInt(obs.limits.maxUsdcInUnits);
  if (amountIn > maxAllowed)
    return { ok: false, reason: "amountIn exceeds configured per-round limit" };
  const balance =
    action.tokenIn === "WETH"
      ? balances.wethWei
      : stableBalanceOf(balances, CURVE.usdcToken);
  if (amountIn > balance)
    return { ok: false, reason: "amountIn exceeds balance" };
  return { ok: true };
}

async function buildSwapTx(
  publicClient: PublicClient,
  action: CurveSwapAction,
): Promise<BuiltTx> {
  const amountIn = BigInt(action.amountIn);
  const slippageBps = action.slippageBps ?? 50;
  const [i, j] =
    action.tokenIn === "WETH"
      ? [CURVE.wethIndex, CURVE.usdtIndex]
      : [CURVE.usdtIndex, CURVE.wethIndex];
  const quoted = await getDy(publicClient, i, j, amountIn);
  const minDy = applySlippage(quoted, slippageBps);
  return {
    to: CURVE.pool,
    data: encodeFunctionData({
      abi: curveTricryptoAbi,
      functionName: "exchange",
      args: [BigInt(i), BigInt(j), amountIn, minDy],
    }),
  };
}

export const curveAdapter: ProtocolAdapter = {
  id: "curve",
  stableToken: CURVE.usdcToken,
  parse,
  bundleable: () => true,
  validate,

  async readState(ctx): Promise<CurveState> {
    return { priceUsdcPerWeth: await getCurvePrice(ctx.publicClient) };
  },

  async observe(_ctx, state) {
    const s = state as CurveState;
    return { priceUsdcPerWeth: s.priceUsdcPerWeth };
  },

  async buildTxs(ctx, _owner, action): Promise<BuiltTx[]> {
    if (action.type !== "curveSwap")
      throw new Error("curve buildTxs: unexpected action");
    return [await buildSwapTx(ctx.publicClient, action)];
  },

  async valueUsdc(): Promise<number> {
    return 0; // swap のみ。残高は wallet 側 (stable 合算) に計上済み
  },

  async setupWallet(): Promise<BuiltTx[]> {
    return [
      approveTx(TOKENS.WETH.address, CURVE.pool),
      approveTx(CURVE.usdcToken, CURVE.pool),
    ];
  },
};

export type { CurveState };
