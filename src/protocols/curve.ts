import { encodeFunctionData, type PublicClient } from "viem";
import { curveTricryptoAbi } from "../abis.js";
import { CURVE, TOKENS, stableBalanceOf } from "../constants.js";
import {
  marketFor,
  marketsFor,
  tokenInfo,
  type MarketConfig,
} from "../markets.js";
import { baseFairPrice, resolveMarket } from "./marketHelpers.js";
import type {
  AgentObservation,
  AmmObservation,
  BalanceSnapshot,
  CurveLeg,
  CurveSwapAction,
  LeafAction,
} from "../types.js";
import type {
  BuiltTx,
  ProtocolAdapter,
  SimContext,
  ValidationResult,
} from "./types.js";
import { approveTx } from "./uniswap.js";

const DECIMAL_INTEGER = /^[0-9]+$/;

type CurveMarketState = {
  market: MarketConfig;
  priceUsdcPerWeth: number; // base/USD（命名は WETH 互換。値は当該 base の price）
};

type CurveState = {
  // WETH market（後方互換でトップレベル維持）。
  priceUsdcPerWeth: number;
  // 全 curve market（WETH 含む）。fork 既定では WETH のみ。
  markets: CurveMarketState[];
};

function wethMarket(): MarketConfig {
  const m = marketFor("curve", "WETH");
  if (!m) throw new Error("curve: WETH market not configured");
  return m;
}

function legOf(market: MarketConfig): CurveLeg {
  if (!market.curve) throw new Error(`curve: market ${market.key} has no leg`);
  return market.curve;
}

// base 0.1 単位を probe に使う（量は小さくして slippage 影響を抑える。価格は出力/probe で割戻す）。
function probeBaseAmount(market: MarketConfig): bigint {
  return 10n ** BigInt(tokenInfo(market.base).decimals) / 10n;
}

async function getDy(
  publicClient: PublicClient,
  leg: CurveLeg,
  i: number,
  j: number,
  dx: bigint,
): Promise<bigint> {
  return publicClient.readContract({
    address: leg.pool,
    abi: curveTricryptoAbi,
    functionName: "get_dy",
    args: [BigInt(i), BigInt(j), dx],
  }) as Promise<bigint>;
}

async function getMarketPrice(
  publicClient: PublicClient,
  market: MarketConfig,
): Promise<number> {
  // base の probe 量 -> quote。1 base あたりの quote(=USDC 相当) 価格へ換算（decimals 一般化）。
  const leg = legOf(market);
  const dx = probeBaseAmount(market);
  const out = await getDy(publicClient, leg, leg.baseIndex, leg.quoteIndex, dx);
  const baseDec = tokenInfo(market.base).decimals;
  const quoteDec = tokenInfo(market.quote).decimals;
  // (out / 10^quoteDec) / (dx / 10^baseDec) = quote per base
  return Number(out) / 10 ** quoteDec / (Number(dx) / 10 ** baseDec);
}

export async function getCurveState(
  publicClient: PublicClient,
): Promise<CurveState> {
  const markets = marketsFor("curve");
  const states = await Promise.all(
    markets.map(async (m) => ({
      market: m,
      priceUsdcPerWeth: await getMarketPrice(publicClient, m),
    })),
  );
  const weth = states.find((s) => s.market.base === "WETH") ?? states[0];
  return {
    priceUsdcPerWeth: weth?.priceUsdcPerWeth ?? 0,
    markets: states,
  };
}

// 後方互換: WETH/USDC の curve price（USDC per WETH）。dashboard/reconstruct が共有する。
export async function getCurvePrice(
  publicClient: PublicClient,
): Promise<number> {
  return getMarketPrice(publicClient, wethMarket());
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

// action.base（既定 WETH）を読み、当該 market を解決する（parse 用）。
function parseBase(obj: Record<string, unknown>): {
  base: string;
  market: MarketConfig;
} {
  const base = typeof obj.base === "string" ? obj.base : "WETH";
  const market = marketFor("curve", base);
  if (!market) throw new Error(`curve: no market for base "${base}"`);
  return { base, market };
}

function parse(obj: Record<string, unknown>): LeafAction | null {
  if (obj.type !== "curveSwap") return null;
  const { base, market } = parseBase(obj);
  if (obj.tokenIn !== market.base && obj.tokenIn !== market.quote)
    throw new Error(`tokenIn must be ${market.base} or ${market.quote}`);
  requireDecimalString(obj.amountIn, "amountIn");
  const action: CurveSwapAction = {
    type: "curveSwap",
    tokenIn: obj.tokenIn,
    amountIn: obj.amountIn,
  };
  if (base !== "WETH") action.base = base;
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
  const base = action.base ?? "WETH";
  const market = marketFor("curve", base);
  if (!market) return { ok: false, reason: `no curve market for ${base}` };
  const inIsBase = action.tokenIn === market.base;
  // ADR 0013: per-round 上限を全 base で適用。base 側は per-base 上限（WETH=maxWethInWei、追加 base は
  // limits.baseLimits[base]。"0"=上限なし）。quote 側は共有 maxUsdcInUnits。WETH は byte 互換。
  if (inIsBase) {
    const maxBaseIn =
      base === "WETH"
        ? BigInt(obs.limits.maxWethInWei)
        : BigInt(obs.limits.baseLimits?.[base]?.maxSwapInBaseWei ?? "0");
    if (maxBaseIn > 0n && amountIn > maxBaseIn)
      return {
        ok: false,
        reason: "amountIn exceeds configured per-round limit",
      };
  } else if (amountIn > BigInt(obs.limits.maxUsdcInUnits)) {
    return {
      ok: false,
      reason: "amountIn exceeds configured per-round limit",
    };
  }
  const balance = inIsBase
    ? (balances.bases?.[market.base] ?? balances.wethWei)
    : stableBalanceOf(balances, legOf(market).stable);
  if (amountIn > balance)
    return { ok: false, reason: "amountIn exceeds balance" };
  return { ok: true };
}

async function buildSwapTx(
  publicClient: PublicClient,
  market: MarketConfig,
  action: CurveSwapAction,
): Promise<BuiltTx> {
  const leg = legOf(market);
  const amountIn = BigInt(action.amountIn);
  const slippageBps = action.slippageBps ?? 50;
  const [i, j] =
    action.tokenIn === market.base
      ? [leg.baseIndex, leg.quoteIndex]
      : [leg.quoteIndex, leg.baseIndex];
  const quoted = await getDy(publicClient, leg, i, j, amountIn);
  const minDy = applySlippage(quoted, slippageBps);
  return {
    to: leg.pool,
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
    return getCurveState(ctx.publicClient);
  },

  async observe(ctx, state, _agent, fairPrice): Promise<AmmObservation> {
    const s = state as CurveState;
    const weth =
      s.markets.find((m) => m.market.base === "WETH") ?? s.markets[0];
    const obs: AmmObservation = {
      priceUsdcPerWeth: weth?.priceUsdcPerWeth ?? s.priceUsdcPerWeth,
    };
    const extra: NonNullable<AmmObservation["markets"]> = {};
    for (const ms of s.markets) {
      if (ms.market.base === "WETH") continue;
      extra[ms.market.key] = {
        priceUsdcPerWeth: baseFairPrice(
          ctx,
          ms.market.base,
          ms.priceUsdcPerWeth,
        ),
      };
    }
    if (Object.keys(extra).length > 0) obs.markets = extra;
    return obs;
  },

  async buildTxs(ctx, _owner, action): Promise<BuiltTx[]> {
    if (action.type !== "curveSwap")
      throw new Error("curve buildTxs: unexpected action");
    const market = resolveMarket("curve", action);
    return [await buildSwapTx(ctx.publicClient, market, action)];
  },

  async valueUsdc(): Promise<number> {
    return 0; // swap のみ。残高は wallet 側 (stable 合算) に計上済み
  },

  async setupWallet(): Promise<BuiltTx[]> {
    const txs: BuiltTx[] = [];
    const seen = new Set<string>();
    const approve = (token: string, spender: string) => {
      const key = `${token.toLowerCase()}:${spender.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      txs.push(approveTx(token as `0x${string}`, spender as `0x${string}`));
    };
    for (const m of marketsFor("curve")) {
      const leg = legOf(m);
      approve(tokenInfo(m.base).address, leg.pool);
      approve(leg.stable, leg.pool);
    }
    return txs;
  },
};

export type { CurveState };
