import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  maxUint128,
  maxUint256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  erc20Abi,
  nonfungiblePositionManagerAbi,
  poolAbi,
  quoterV2Abi,
  swapRouterAbi,
  wethAbi,
} from "../abis.js";
import { TOKENS, UNISWAP, stableBalanceOf } from "../constants.js";
import {
  marketFor,
  marketsFor,
  tokenInfo,
  type MarketConfig,
} from "../markets.js";
import { resolveMarket } from "./marketHelpers.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  LeafAction,
  LpPositionObservation,
  SwapAction,
  TokenSymbol,
  UniswapMarketObservation,
  UniswapObservation,
} from "../types.js";
import type {
  BuiltTx,
  ProtocolAdapter,
  SimContext,
  ValidationResult,
} from "./types.js";

const DECIMAL_INTEGER = /^[0-9]+$/;

type UniswapMarketState = {
  market: MarketConfig;
  priceUsdcPerWeth: number; // base/USD（命名は WETH 互換。値は当該 base の price）
  tick: number;
  tickSpacing: number;
};

type UniswapState = {
  // WETH market（後方互換でトップレベル維持）。
  priceUsdcPerWeth: number;
  tick: number;
  tickSpacing: number;
  // 全 uniswap market（WETH 含む）。fork 既定では WETH のみ。
  markets: UniswapMarketState[];
};

function wethMarket(): MarketConfig {
  const m = marketFor("uniswap", "WETH");
  if (!m) throw new Error("uniswap: WETH market not configured");
  return m;
}

function legOf(market: MarketConfig) {
  if (!market.uniswap)
    throw new Error(`uniswap: market ${market.key} has no leg`);
  return market.uniswap;
}

// market の base/quote とソート（token0/token1 はアドレス昇順）。
function sortedTokensFor(market: MarketConfig): {
  token0: Address;
  token1: Address;
  baseIsToken0: boolean;
} {
  const baseAddr = tokenInfo(market.base).address;
  const quoteAddr = tokenInfo(market.quote).address;
  const baseIsToken0 = baseAddr.toLowerCase() < quoteAddr.toLowerCase();
  return baseIsToken0
    ? { token0: baseAddr, token1: quoteAddr, baseIsToken0 }
    : { token0: quoteAddr, token1: baseAddr, baseIsToken0 };
}

// swap の tokenIn(base|quote シンボル) -> in/out アドレス。
function swapLeg(
  market: MarketConfig,
  tokenIn: TokenSymbol,
): { assetIn: Address; assetOut: Address } {
  const baseAddr = tokenInfo(market.base).address;
  const quoteAddr = tokenInfo(market.quote).address;
  return tokenIn === market.base
    ? { assetIn: baseAddr, assetOut: quoteAddr }
    : { assetIn: quoteAddr, assetOut: baseAddr };
}

// slot0 の sqrtPriceX96 -> quote per base（decimals 一般化。base/quote の桁差を吸収）。
export function poolPriceFromSqrtX96(
  sqrtPriceX96: bigint,
  market: MarketConfig,
): number {
  const { baseIsToken0 } = sortedTokensFor(market);
  const baseDec = tokenInfo(market.base).decimals;
  const quoteDec = tokenInfo(market.quote).decimals;
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const rawToken1PerToken0 = ratio * ratio;
  const scale = 10 ** (baseDec - quoteDec);
  // raw(token1/token0) -> quote per base
  return baseIsToken0 ? rawToken1PerToken0 * scale : scale / rawToken1PerToken0;
}

// 後方互換: WETH/USDC の sqrtPriceX96 -> USDC per WETH。reconstruct/dashboard が共有する。
export function poolPriceUsdcPerWethFromSqrtX96(sqrtPriceX96: bigint): number {
  return poolPriceFromSqrtX96(sqrtPriceX96, wethMarket());
}

async function getMarketState(
  publicClient: PublicClient,
  market: MarketConfig,
): Promise<UniswapMarketState> {
  const leg = legOf(market);
  const [slot0, tickSpacing] = await Promise.all([
    publicClient.readContract({
      address: leg.pool,
      abi: poolAbi,
      functionName: "slot0",
    }),
    publicClient
      .readContract({
        address: leg.pool,
        abi: poolAbi,
        functionName: "tickSpacing",
      })
      .catch(() => leg.tickSpacing),
  ]);
  return {
    market,
    priceUsdcPerWeth: poolPriceFromSqrtX96(slot0[0], market),
    tick: Number(slot0[1]),
    tickSpacing: Number(tickSpacing),
  };
}

export async function getPoolState(
  publicClient: PublicClient,
): Promise<UniswapState> {
  const markets = marketsFor("uniswap");
  const states = await Promise.all(
    markets.map((m) => getMarketState(publicClient, m)),
  );
  const weth = states.find((s) => s.market.base === "WETH") ?? states[0];
  return {
    priceUsdcPerWeth: weth.priceUsdcPerWeth,
    tick: weth.tick,
    tickSpacing: weth.tickSpacing,
    markets: states,
  };
}

export async function getPoolPriceUsdcPerWeth(
  publicClient: PublicClient,
): Promise<number> {
  return (await getPoolState(publicClient)).priceUsdcPerWeth;
}

async function quoteExactInput(
  publicClient: PublicClient,
  market: MarketConfig,
  assetIn: Address,
  assetOut: Address,
  amountIn: bigint,
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: assetIn,
        tokenOut: assetOut,
        amountIn,
        fee: legOf(market).fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const result = await publicClient.call({ to: UNISWAP.quoterV2, data });
  const [amountOut] = decodeFunctionResult({
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    data: result.data ?? "0x",
  });
  return amountOut;
}

async function buildSwapData(
  publicClient: PublicClient,
  recipient: Address,
  market: MarketConfig,
  action: SwapAction,
  slippageBps: number,
): Promise<Hex> {
  const amountIn = BigInt(action.amountIn);
  const { assetIn, assetOut } = swapLeg(market, action.tokenIn);
  const quoted = await quoteExactInput(
    publicClient,
    market,
    assetIn,
    assetOut,
    amountIn,
  );
  return encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: assetIn,
        tokenOut: assetOut,
        fee: legOf(market).fee,
        recipient,
        deadline: deadline(),
        amountIn,
        amountOutMinimum: applySlippage(quoted, slippageBps),
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

async function buildLpActionData(
  publicClient: PublicClient,
  owner: Address,
  market: MarketConfig,
  action: LeafAction,
  slippageBps: number,
): Promise<Hex> {
  const { token0, token1, baseIsToken0 } = sortedTokensFor(market);
  const fee = legOf(market).fee;
  if (action.type === "mintLiquidity") {
    // base 指定時は amountBase/QuoteDesired、未指定（WETH 既定）は amountWeth/UsdcDesired。
    const amountBase = BigInt(
      action.amountBaseDesired ?? action.amountWethDesired,
    );
    const amountQuote = BigInt(
      action.amountQuoteDesired ?? action.amountUsdcDesired,
    );
    const amount0Desired = baseIsToken0 ? amountBase : amountQuote;
    const amount1Desired = baseIsToken0 ? amountQuote : amountBase;
    const mintParams = (amount0Min: bigint, amount1Min: bigint) => ({
      token0,
      token1,
      fee,
      tickLower: action.tickLower,
      tickUpper: action.tickUpper,
      amount0Desired,
      amount1Desired,
      amount0Min,
      amount1Min,
      recipient: owner,
      deadline: deadline(),
    });
    const simulated = await publicClient.simulateContract({
      account: owner,
      address: UNISWAP.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "mint",
      args: [mintParams(0n, 0n)],
    });
    const [, , amount0, amount1] = simulated.result;
    return encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "mint",
      args: [
        mintParams(
          applySlippage(amount0, slippageBps),
          applySlippage(amount1, slippageBps),
        ),
      ],
    });
  }

  if (action.type === "removeLiquidity") {
    const amountBaseMin = BigInt(action.amountWethMin ?? "0");
    const amountQuoteMin = BigInt(action.amountUsdcMin ?? "0");
    return encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId: BigInt(action.tokenId),
          liquidity: BigInt(action.liquidity),
          amount0Min: baseIsToken0 ? amountBaseMin : amountQuoteMin,
          amount1Min: baseIsToken0 ? amountQuoteMin : amountBaseMin,
          deadline: deadline(),
        },
      ],
    });
  }

  if (action.type === "collectFees") {
    return encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "collect",
      args: [
        {
          tokenId: BigInt(action.tokenId),
          recipient: owner,
          amount0Max: maxUint128,
          amount1Max: maxUint128,
        },
      ],
    });
  }

  throw new Error(`Unsupported LP action: ${action.type}`);
}

// position の (token0,token1,fee) が属する uniswap market を解決。WETH/USDC 以外も対応。
function positionMarketOf(
  token0: Address,
  token1: Address,
  fee: number,
  markets: MarketConfig[],
): MarketConfig | undefined {
  for (const m of markets) {
    const { token0: t0, token1: t1 } = sortedTokensFor(m);
    if (
      token0.toLowerCase() === t0.toLowerCase() &&
      token1.toLowerCase() === t1.toLowerCase() &&
      fee === legOf(m).fee
    ) {
      return m;
    }
  }
  return undefined;
}

export async function getLpPositions(
  publicClient: PublicClient,
  owner: Address,
  // base シンボル -> fair price(USD)。WETH のみのとき従来と一致。
  fairPriceByBase: Record<string, number>,
  // pool アドレス(lower) -> tick。observe が readState 済みの tick を渡せば再読取を省く。
  knownTickByPool?: Record<string, number>,
): Promise<LpPositionObservation[]> {
  const markets = marketsFor("uniswap");
  // 各 market の tick（未提供なら読む）。
  const tickByPool: Record<string, number> = { ...(knownTickByPool ?? {}) };
  await Promise.all(
    markets.map(async (m) => {
      const pool = legOf(m).pool.toLowerCase();
      if (tickByPool[pool] === undefined) {
        const s = await getMarketState(publicClient, m);
        tickByPool[pool] = s.tick;
      }
    }),
  );

  const balance = await publicClient.readContract({
    address: UNISWAP.nonfungiblePositionManager,
    abi: nonfungiblePositionManagerAbi,
    functionName: "balanceOf",
    args: [owner],
  });

  const indices = Array.from({ length: Number(balance) }, (_, i) => BigInt(i));
  const tokenIds = await Promise.all(
    indices.map((i) =>
      publicClient.readContract({
        address: UNISWAP.nonfungiblePositionManager,
        abi: nonfungiblePositionManagerAbi,
        functionName: "tokenOfOwnerByIndex",
        args: [owner, i],
      }),
    ),
  );
  const rawPositions = await Promise.all(
    tokenIds.map((tokenId) =>
      publicClient.readContract({
        address: UNISWAP.nonfungiblePositionManager,
        abi: nonfungiblePositionManagerAbi,
        functionName: "positions",
        args: [tokenId],
      }),
    ),
  );

  const positions: LpPositionObservation[] = [];
  for (let i = 0; i < tokenIds.length; i++) {
    const tokenId = tokenIds[i];
    const [
      ,
      ,
      token0,
      token1,
      fee,
      tickLower,
      tickUpper,
      liquidity,
      ,
      ,
      tokensOwed0,
      tokensOwed1,
    ] = rawPositions[i];
    const market = positionMarketOf(token0, token1, fee, markets);
    if (!market) continue;
    const { baseIsToken0 } = sortedTokensFor(market);
    const tick = tickByPool[legOf(market).pool.toLowerCase()] ?? 0;
    const amounts = liquidityToTokenAmounts({
      liquidity,
      tick,
      tickLower,
      tickUpper,
    });
    const amountBase = baseIsToken0 ? amounts.amount0 : amounts.amount1;
    const amountQuote = baseIsToken0 ? amounts.amount1 : amounts.amount0;
    const owedBase = baseIsToken0 ? tokensOwed0 : tokensOwed1;
    const owedQuote = baseIsToken0 ? tokensOwed1 : tokensOwed0;
    const basePrice = fairPriceByBase[market.base] ?? 0;
    positions.push({
      tokenId: tokenId.toString(),
      tickLower,
      tickUpper,
      liquidity: liquidity.toString(),
      tokensOwedWethWei: owedBase.toString(),
      tokensOwedUsdcUnits: owedQuote.toString(),
      amountWethWei: amountBase.toString(),
      amountUsdcUnits: amountQuote.toString(),
      valueUsdc: valuePositionUsdc(
        amountBase,
        amountQuote,
        owedBase,
        owedQuote,
        market,
        basePrice,
      ),
      ...(market.base === "WETH" ? {} : { market: market.key }),
    });
  }
  return positions;
}

export function liquidityToTokenAmounts(input: {
  liquidity: bigint;
  tick: number;
  tickLower: number;
  tickUpper: number;
}): { amount0: bigint; amount1: bigint } {
  const liquidity = Number(input.liquidity);
  const sqrtLower = Math.pow(1.0001, input.tickLower / 2);
  const sqrtUpper = Math.pow(1.0001, input.tickUpper / 2);
  const sqrtCurrent = Math.pow(1.0001, input.tick / 2);

  let amount0 = 0;
  let amount1 = 0;
  if (input.tick < input.tickLower) {
    amount0 = (liquidity * (sqrtUpper - sqrtLower)) / (sqrtUpper * sqrtLower);
  } else if (input.tick >= input.tickUpper) {
    amount1 = liquidity * (sqrtUpper - sqrtLower);
  } else {
    amount0 =
      (liquidity * (sqrtUpper - sqrtCurrent)) / (sqrtUpper * sqrtCurrent);
    amount1 = liquidity * (sqrtCurrent - sqrtLower);
  }

  return {
    amount0: BigInt(Math.max(0, Math.floor(amount0))),
    amount1: BigInt(Math.max(0, Math.floor(amount1))),
  };
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

// Date.now() ベースだと evm_increaseTime で EVM time が wall clock を追い越した時に
// "Transaction too old" になる。実害のない MEV 保護用フィールドなので遠未来定数を使う。
function deadline(): bigint {
  return DEADLINE_FAR_FUTURE;
}
const DEADLINE_FAR_FUTURE = BigInt(2 ** 32 - 1); // ~ year 2106

// base/quote 量 + owed を当該 base の USD 価格で評価（quote は $1）。
function valuePositionUsdc(
  amountBaseWei: bigint,
  amountQuoteUnits: bigint,
  owedBaseWei: bigint,
  owedQuoteUnits: bigint,
  market: MarketConfig,
  basePriceUsd: number,
): number {
  const baseDec = tokenInfo(market.base).decimals;
  const quoteDec = tokenInfo(market.quote).decimals;
  const base = Number(formatUnits(amountBaseWei + owedBaseWei, baseDec));
  const quote = Number(
    formatUnits(amountQuoteUnits + owedQuoteUnits, quoteDec),
  );
  return quote + base * basePriceUsd;
}

// 歴史ブロック再構成（ADR 0006 §4）: positions(tokenId) の生 tuple から LP 価値を出す純粋関数。
// reconstruct は WETH 価格を渡すため、当面 WETH/USDC market のみ評価する（WBTC 等は Phase 7 で
// fairByBase を渡せるようになるまで 0）。WETH 既定の採点は従来と byte 一致。
export function lpPositionValueUsdc(
  position: readonly [
    bigint,
    Address,
    Address,
    Address,
    number,
    number,
    number,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ],
  tick: number,
  fairPriceUsdcPerWeth: number,
): number {
  const [
    ,
    ,
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    liquidity,
    ,
    ,
    tokensOwed0,
    tokensOwed1,
  ] = position;
  const markets = marketsFor("uniswap");
  const market = positionMarketOf(token0, token1, fee, markets);
  // 後方互換: reconstruct が単一 WETH 価格を渡すため、WETH market 以外は当面 0（Phase 7 で対応）。
  if (!market || market.base !== "WETH") return 0;
  const { baseIsToken0 } = sortedTokensFor(market);
  const amounts = liquidityToTokenAmounts({
    liquidity,
    tick,
    tickLower,
    tickUpper,
  });
  return valuePositionUsdc(
    baseIsToken0 ? amounts.amount0 : amounts.amount1,
    baseIsToken0 ? amounts.amount1 : amounts.amount0,
    baseIsToken0 ? tokensOwed0 : tokensOwed1,
    baseIsToken0 ? tokensOwed1 : tokensOwed0,
    market,
    fairPriceUsdcPerWeth,
  );
}

// reconstruct（採点）用: position の market を解決し、tickByPool と fairByBase で全 base 対応の
// LP 価値を出す（WBTC/USDC 等）。fork 既定（WETH のみ）では lpPositionValueUsdc と一致。
export function lpPositionValueUsdcMulti(
  position: Parameters<typeof lpPositionValueUsdc>[0],
  tickByPool: Record<string, number>,
  fairByBase: Record<string, number>,
): number {
  const [
    ,
    ,
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    liquidity,
    ,
    ,
    tokensOwed0,
    tokensOwed1,
  ] = position;
  const market = positionMarketOf(token0, token1, fee, marketsFor("uniswap"));
  if (!market) return 0;
  const { baseIsToken0 } = sortedTokensFor(market);
  const tick = tickByPool[legOf(market).pool.toLowerCase()] ?? 0;
  const amounts = liquidityToTokenAmounts({
    liquidity,
    tick,
    tickLower,
    tickUpper,
  });
  return valuePositionUsdc(
    baseIsToken0 ? amounts.amount0 : amounts.amount1,
    baseIsToken0 ? amounts.amount1 : amounts.amount0,
    baseIsToken0 ? tokensOwed0 : tokensOwed1,
    baseIsToken0 ? tokensOwed1 : tokensOwed0,
    market,
    fairByBase[market.base] ?? 0,
  );
}

// ---------------------------------------------------------------------------
// parse / validate
// ---------------------------------------------------------------------------

function requireDecimalString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    throw new Error(`${name} must be a decimal integer string`);
}
function requireInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`${name} must be an integer`);
  return value;
}
function addPriorityFee(
  action: { maxPriorityFeePerGasWei?: string },
  obj: Record<string, unknown>,
): void {
  if (obj.maxPriorityFeePerGasWei === undefined) return;
  requireDecimalString(obj.maxPriorityFeePerGasWei, "maxPriorityFeePerGasWei");
  action.maxPriorityFeePerGasWei = obj.maxPriorityFeePerGasWei;
}
function addSlippage(
  action: { slippageBps?: number },
  obj: Record<string, unknown>,
): void {
  if (obj.slippageBps === undefined) return;
  const slippageBps = requireInteger(obj.slippageBps, "slippageBps");
  if (slippageBps < 0 || slippageBps > 1000)
    throw new Error("slippageBps must be an integer between 0 and 1000");
  action.slippageBps = slippageBps;
}

// action.base（既定 WETH）を読み、当該 market を解決する（parse 用）。
function parseBase(obj: Record<string, unknown>): {
  base: string;
  market: MarketConfig;
} {
  const base = typeof obj.base === "string" ? obj.base : "WETH";
  const market = marketFor("uniswap", base);
  if (!market) throw new Error(`uniswap: no market for base "${base}"`);
  return { base, market };
}

function parse(obj: Record<string, unknown>): LeafAction | null {
  if (obj.type === "swap") {
    const { base, market } = parseBase(obj);
    if (obj.tokenIn !== market.base && obj.tokenIn !== market.quote)
      throw new Error(`tokenIn must be ${market.base} or ${market.quote}`);
    requireDecimalString(obj.amountIn, "amountIn");
    const action: SwapAction = {
      type: "swap",
      tokenIn: obj.tokenIn,
      amountIn: obj.amountIn,
    };
    if (base !== "WETH") action.base = base;
    addPriorityFee(action, obj);
    addSlippage(action, obj);
    return action;
  }
  if (obj.type === "mintLiquidity") {
    const { base } = parseBase(obj);
    const tickLower = requireInteger(obj.tickLower, "tickLower");
    const tickUpper = requireInteger(obj.tickUpper, "tickUpper");
    const action: LeafAction = {
      type: "mintLiquidity",
      tickLower,
      tickUpper,
      // 後方互換: WETH 既定は amountWeth/UsdcDesired を必須。base 指定は amountBase/QuoteDesired。
      amountWethDesired: "0",
      amountUsdcDesired: "0",
    };
    if (base === "WETH") {
      requireDecimalString(obj.amountWethDesired, "amountWethDesired");
      requireDecimalString(obj.amountUsdcDesired, "amountUsdcDesired");
      action.amountWethDesired = obj.amountWethDesired;
      action.amountUsdcDesired = obj.amountUsdcDesired;
    } else {
      requireDecimalString(obj.amountBaseDesired, "amountBaseDesired");
      requireDecimalString(obj.amountQuoteDesired, "amountQuoteDesired");
      action.base = base;
      action.amountBaseDesired = obj.amountBaseDesired;
      action.amountQuoteDesired = obj.amountQuoteDesired;
    }
    addPriorityFee(action, obj);
    addSlippage(action as { slippageBps?: number }, obj);
    return action;
  }
  if (obj.type === "removeLiquidity") {
    requireDecimalString(obj.tokenId, "tokenId");
    requireDecimalString(obj.liquidity, "liquidity");
    const action: LeafAction = {
      type: "removeLiquidity",
      tokenId: obj.tokenId,
      liquidity: obj.liquidity,
    };
    if (typeof obj.base === "string" && obj.base !== "WETH")
      action.base = obj.base;
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
  if (obj.type === "collectFees") {
    requireDecimalString(obj.tokenId, "tokenId");
    const action: LeafAction = { type: "collectFees", tokenId: obj.tokenId };
    if (typeof obj.base === "string" && obj.base !== "WETH")
      action.base = obj.base;
    addPriorityFee(action, obj);
    return action;
  }
  return null;
}

function validate(
  action: LeafAction,
  obs: AgentObservation,
  balances: BalanceSnapshot,
): ValidationResult {
  const uni = obs.protocols.uniswap;
  if (!uni) return { ok: false, reason: "uniswap not enabled" };
  if (action.type === "swap") {
    const amountIn = BigInt(action.amountIn);
    if (amountIn <= 0n)
      return { ok: false, reason: "amountIn must be positive" };
    const base = action.base ?? "WETH";
    const market = marketFor("uniswap", base);
    if (!market) return { ok: false, reason: `no uniswap market for ${base}` };
    const inIsBase = action.tokenIn === market.base;
    // WETH market は従来の per-round limit を維持。WBTC 等は balance チェックのみ（limits は Phase 8）。
    if (base === "WETH") {
      const maxAllowed = inIsBase
        ? BigInt(obs.limits.maxWethInWei)
        : BigInt(obs.limits.maxUsdcInUnits);
      if (amountIn > maxAllowed)
        return {
          ok: false,
          reason: "amountIn exceeds configured per-round limit",
        };
    }
    const balance = inIsBase
      ? (balances.bases?.[market.base] ?? balances.wethWei)
      : stableBalanceOf(balances, TOKENS.USDC.address);
    if (amountIn > balance)
      return { ok: false, reason: "amountIn exceeds balance" };
    return { ok: true };
  }
  if (action.type === "mintLiquidity") {
    const base = action.base ?? "WETH";
    const baseAmt = BigInt(
      action.amountBaseDesired ?? action.amountWethDesired,
    );
    const quoteAmt = BigInt(
      action.amountQuoteDesired ?? action.amountUsdcDesired,
    );
    if (baseAmt <= 0n && quoteAmt <= 0n)
      return { ok: false, reason: "LP desired amount must be positive" };
    if (action.tickLower >= action.tickUpper)
      return { ok: false, reason: "tickLower must be less than tickUpper" };
    if (
      action.tickLower % uni.pool.tickSpacing !== 0 ||
      action.tickUpper % uni.pool.tickSpacing !== 0
    ) {
      return { ok: false, reason: "ticks must align to pool tick spacing" };
    }
    if (base === "WETH") {
      if (
        baseAmt > BigInt(obs.limits.maxLpWethWei) ||
        quoteAmt > BigInt(obs.limits.maxLpUsdcUnits)
      )
        return {
          ok: false,
          reason: "LP desired amounts exceed configured LP limits",
        };
    }
    const baseBal = balances.bases?.[base] ?? balances.wethWei;
    if (
      baseAmt > baseBal ||
      quoteAmt > stableBalanceOf(balances, TOKENS.USDC.address)
    )
      return { ok: false, reason: "LP desired amounts exceed balance" };
    if (uni.positions.length >= obs.limits.maxOpenPositions)
      return {
        ok: false,
        reason: "open LP position count exceeds configured max",
      };
    return { ok: true };
  }
  const position = uni.positions.find(
    (p) => p.tokenId === (action as { tokenId: string }).tokenId,
  );
  if (!position) return { ok: false, reason: "tokenId is not owned by agent" };
  if (action.type === "removeLiquidity") {
    const liquidity = BigInt(action.liquidity);
    if (liquidity <= 0n)
      return { ok: false, reason: "liquidity must be positive" };
    if (liquidity > BigInt(position.liquidity))
      return {
        ok: false,
        reason: "liquidity exceeds owned position liquidity",
      };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

export const uniswapAdapter: ProtocolAdapter = {
  id: "uniswap",
  parse,
  bundleable: () => true,
  validate,

  async readState(ctx) {
    return getPoolState(ctx.publicClient);
  },

  async observe(ctx, state, agent, fairPrice): Promise<UniswapObservation> {
    const s = state as UniswapState;
    const fairByBase = ctx.fairPrices ?? { WETH: fairPrice };
    const tickByPool: Record<string, number> = {};
    for (const ms of s.markets)
      tickByPool[legOf(ms.market).pool.toLowerCase()] = ms.tick;
    const positions = await getLpPositions(
      ctx.publicClient,
      agent,
      fairByBase,
      tickByPool,
    );
    const weth =
      s.markets.find((m) => m.market.base === "WETH") ?? s.markets[0];
    const obs: UniswapObservation = {
      pool: {
        pair: "WETH/USDC",
        fee: legOf(weth.market).fee,
        priceUsdcPerWeth: weth.priceUsdcPerWeth,
        tick: weth.tick,
        tickSpacing: weth.tickSpacing,
      },
      positions,
    };
    const extra: Record<string, UniswapMarketObservation> = {};
    for (const ms of s.markets) {
      if (ms.market.base === "WETH") continue;
      extra[ms.market.key] = {
        pair: ms.market.key,
        fee: legOf(ms.market).fee,
        priceUsdcPerWeth: ms.priceUsdcPerWeth,
        tick: ms.tick,
        tickSpacing: ms.tickSpacing,
      };
    }
    if (Object.keys(extra).length > 0) obs.markets = extra;
    return obs;
  },

  async buildTxs(ctx, owner, action): Promise<BuiltTx[]> {
    if (action.type === "swap") {
      const market = resolveMarket("uniswap", action as SwapAction);
      const slippageBps = (action as SwapAction).slippageBps ?? 50;
      const data = await buildSwapData(
        ctx.publicClient,
        owner,
        market,
        action as SwapAction,
        slippageBps,
      );
      return [{ to: UNISWAP.swapRouter, data }];
    }
    const market = resolveMarket("uniswap", action as { base?: TokenSymbol });
    const slippageBps =
      action.type === "mintLiquidity" ? (action.slippageBps ?? 50) : 0;
    const data = await buildLpActionData(
      ctx.publicClient,
      owner,
      market,
      action,
      slippageBps,
    );
    return [{ to: UNISWAP.nonfungiblePositionManager, data }];
  },

  async valueUsdc(ctx, agent, _state, fairPrice): Promise<number> {
    const fairByBase = ctx.fairPrices ?? { WETH: fairPrice };
    const positions = await getLpPositions(ctx.publicClient, agent, fairByBase);
    return positions.reduce((sum, p) => sum + p.valueUsdc, 0);
  },

  async setupWallet(): Promise<BuiltTx[]> {
    const txs: BuiltTx[] = [];
    const seen = new Set<string>();
    const approveBoth = (token: Address) => {
      const key = token.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      txs.push(
        approveTx(token, UNISWAP.swapRouter),
        approveTx(token, UNISWAP.nonfungiblePositionManager),
      );
    };
    for (const m of marketsFor("uniswap")) {
      approveBoth(tokenInfo(m.base).address);
      approveBoth(tokenInfo(m.quote).address);
    }
    return txs;
  },
};

// approve 1 件分の BuiltTx を組む（balancer/curve/aave/gmx の setupWallet でも再利用）
export function approveTx(token: Address, spender: Address): BuiltTx {
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, maxUint256],
    }),
  };
}

export { wethAbi };
