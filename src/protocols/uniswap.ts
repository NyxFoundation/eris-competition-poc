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
import {
  TOKENS,
  UNISWAP,
  tokenAddress,
  oppositeToken,
  stableBalanceOf,
} from "../constants.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  LeafAction,
  LpPositionObservation,
  SwapAction,
  TokenSymbol,
  UniswapObservation,
} from "../types.js";
import type { BuiltTx, ProtocolAdapter, ValidationResult } from "./types.js";

const DECIMAL_INTEGER = /^[0-9]+$/;

type UniswapState = {
  priceUsdcPerWeth: number;
  tick: number;
  tickSpacing: number;
};

// Arbitrum では WETH(0x82aF) < USDC(0xaf88) → token0=WETH。アドレス比較で動的判定。
function wethIsToken0(): boolean {
  return TOKENS.WETH.address.toLowerCase() < TOKENS.USDC.address.toLowerCase();
}

function sortedTokens(): { token0: Address; token1: Address } {
  return wethIsToken0()
    ? { token0: TOKENS.WETH.address, token1: TOKENS.USDC.address }
    : { token0: TOKENS.USDC.address, token1: TOKENS.WETH.address };
}

export async function getPoolState(
  publicClient: PublicClient,
): Promise<UniswapState> {
  const [slot0, tickSpacing] = await Promise.all([
    publicClient.readContract({
      address: UNISWAP.poolWethUsdc500,
      abi: poolAbi,
      functionName: "slot0",
    }),
    publicClient
      .readContract({
        address: UNISWAP.poolWethUsdc500,
        abi: poolAbi,
        functionName: "tickSpacing",
      })
      .catch(() => UNISWAP.tickSpacing),
  ]);
  const sqrtPriceX96 = slot0[0];
  const tick = slot0[1];
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const rawToken1PerToken0 = ratio * ratio;
  // raw(token1/token0) -> USDC per WETH
  const priceUsdcPerWeth = wethIsToken0()
    ? rawToken1PerToken0 * 1e12
    : 1e12 / rawToken1PerToken0;
  return {
    priceUsdcPerWeth,
    tick: Number(tick),
    tickSpacing: Number(tickSpacing),
  };
}

export async function getPoolPriceUsdcPerWeth(
  publicClient: PublicClient,
): Promise<number> {
  return (await getPoolState(publicClient)).priceUsdcPerWeth;
}

async function quoteExactInput(
  publicClient: PublicClient,
  tokenIn: TokenSymbol,
  amountIn: bigint,
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: tokenAddress(tokenIn),
        tokenOut: tokenAddress(oppositeToken(tokenIn)),
        amountIn,
        fee: UNISWAP.fee,
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
  action: SwapAction,
  slippageBps: number,
): Promise<Hex> {
  const amountIn = BigInt(action.amountIn);
  const quoted = await quoteExactInput(publicClient, action.tokenIn, amountIn);
  return encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: tokenAddress(action.tokenIn),
        tokenOut: tokenAddress(oppositeToken(action.tokenIn)),
        fee: UNISWAP.fee,
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
  action: LeafAction,
  slippageBps: number,
): Promise<Hex> {
  const { token0, token1 } = sortedTokens();
  const w0 = wethIsToken0();
  if (action.type === "mintLiquidity") {
    const amountWeth = BigInt(action.amountWethDesired);
    const amountUsdc = BigInt(action.amountUsdcDesired);
    const amount0Desired = w0 ? amountWeth : amountUsdc;
    const amount1Desired = w0 ? amountUsdc : amountWeth;
    const mintParams = (amount0Min: bigint, amount1Min: bigint) => ({
      token0,
      token1,
      fee: UNISWAP.fee,
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
    const amountWethMin = BigInt(action.amountWethMin ?? "0");
    const amountUsdcMin = BigInt(action.amountUsdcMin ?? "0");
    return encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId: BigInt(action.tokenId),
          liquidity: BigInt(action.liquidity),
          amount0Min: w0 ? amountWethMin : amountUsdcMin,
          amount1Min: w0 ? amountUsdcMin : amountWethMin,
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

export async function getLpPositions(
  publicClient: PublicClient,
  owner: Address,
  fairPriceUsdcPerWeth: number,
  // 呼び側が readState 済みの tick を渡せば pool の再読取を省く（observe の二重読み防止）
  knownTick?: number,
): Promise<LpPositionObservation[]> {
  const [tick, balance] = await Promise.all([
    knownTick !== undefined
      ? Promise.resolve(knownTick)
      : getPoolState(publicClient).then((s) => s.tick),
    publicClient.readContract({
      address: UNISWAP.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "balanceOf",
      args: [owner],
    }),
  ]);

  // NFT 列挙は直列にせず並列発行する（batch=true クライアントでは multicall に束なる）
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

  const w0 = wethIsToken0();
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
    if (!isWethUsdcPosition(token0, token1, fee)) continue;
    const amounts = liquidityToTokenAmounts({
      liquidity,
      tick,
      tickLower,
      tickUpper,
    });
    const amountWeth = w0 ? amounts.amount0 : amounts.amount1;
    const amountUsdc = w0 ? amounts.amount1 : amounts.amount0;
    const owedWeth = w0 ? tokensOwed0 : tokensOwed1;
    const owedUsdc = w0 ? tokensOwed1 : tokensOwed0;
    positions.push({
      tokenId: tokenId.toString(),
      tickLower,
      tickUpper,
      liquidity: liquidity.toString(),
      tokensOwedWethWei: owedWeth.toString(),
      tokensOwedUsdcUnits: owedUsdc.toString(),
      amountWethWei: amountWeth.toString(),
      amountUsdcUnits: amountUsdc.toString(),
      valueUsdc: valuePositionUsdc(
        amountWeth,
        amountUsdc,
        owedWeth,
        owedUsdc,
        fairPriceUsdcPerWeth,
      ),
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

function isWethUsdcPosition(
  token0: Address,
  token1: Address,
  fee: number,
): boolean {
  const { token0: t0, token1: t1 } = sortedTokens();
  return (
    token0.toLowerCase() === t0.toLowerCase() &&
    token1.toLowerCase() === t1.toLowerCase() &&
    fee === UNISWAP.fee
  );
}

function valuePositionUsdc(
  amountWethWei: bigint,
  amountUsdcUnits: bigint,
  owedWethWei: bigint,
  owedUsdcUnits: bigint,
  fairPriceUsdcPerWeth: number,
): number {
  const weth = Number(formatUnits(amountWethWei + owedWethWei, 18));
  const usdc = Number(formatUnits(amountUsdcUnits + owedUsdcUnits, 6));
  return usdc + weth * fairPriceUsdcPerWeth;
}

// 歴史ブロック再構成（ADR 0006 §4）: positions(tokenId) の生 tuple から
// getLpPositions と同じ式で LP 価値を出す純粋関数。WETH/USDC 以外のポジションは 0。
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
  if (!isWethUsdcPosition(token0, token1, fee)) return 0;
  const amounts = liquidityToTokenAmounts({
    liquidity,
    tick,
    tickLower,
    tickUpper,
  });
  const w0 = wethIsToken0();
  return valuePositionUsdc(
    w0 ? amounts.amount0 : amounts.amount1,
    w0 ? amounts.amount1 : amounts.amount0,
    w0 ? tokensOwed0 : tokensOwed1,
    w0 ? tokensOwed1 : tokensOwed0,
    fairPriceUsdcPerWeth,
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

function parse(obj: Record<string, unknown>): LeafAction | null {
  if (obj.type === "swap") {
    if (obj.tokenIn !== "WETH" && obj.tokenIn !== "USDC")
      throw new Error("tokenIn must be WETH or USDC");
    requireDecimalString(obj.amountIn, "amountIn");
    const action: SwapAction = {
      type: "swap",
      tokenIn: obj.tokenIn,
      amountIn: obj.amountIn,
    };
    addPriorityFee(action, obj);
    addSlippage(action, obj);
    return action;
  }
  if (obj.type === "mintLiquidity") {
    const tickLower = requireInteger(obj.tickLower, "tickLower");
    const tickUpper = requireInteger(obj.tickUpper, "tickUpper");
    requireDecimalString(obj.amountWethDesired, "amountWethDesired");
    requireDecimalString(obj.amountUsdcDesired, "amountUsdcDesired");
    const action: LeafAction = {
      type: "mintLiquidity",
      tickLower,
      tickUpper,
      amountWethDesired: obj.amountWethDesired,
      amountUsdcDesired: obj.amountUsdcDesired,
    };
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
    const maxAllowed =
      action.tokenIn === "WETH"
        ? BigInt(obs.limits.maxWethInWei)
        : BigInt(obs.limits.maxUsdcInUnits);
    if (amountIn > maxAllowed)
      return {
        ok: false,
        reason: "amountIn exceeds configured per-round limit",
      };
    const balance =
      action.tokenIn === "WETH"
        ? balances.wethWei
        : stableBalanceOf(balances, TOKENS.USDC.address);
    if (amountIn > balance)
      return { ok: false, reason: "amountIn exceeds balance" };
    return { ok: true };
  }
  if (action.type === "mintLiquidity") {
    const weth = BigInt(action.amountWethDesired);
    const usdc = BigInt(action.amountUsdcDesired);
    if (weth <= 0n && usdc <= 0n)
      return { ok: false, reason: "LP desired amount must be positive" };
    if (action.tickLower >= action.tickUpper)
      return { ok: false, reason: "tickLower must be less than tickUpper" };
    if (
      action.tickLower % uni.pool.tickSpacing !== 0 ||
      action.tickUpper % uni.pool.tickSpacing !== 0
    ) {
      return { ok: false, reason: "ticks must align to pool tick spacing" };
    }
    if (
      weth > BigInt(obs.limits.maxLpWethWei) ||
      usdc > BigInt(obs.limits.maxLpUsdcUnits)
    )
      return {
        ok: false,
        reason: "LP desired amounts exceed configured LP limits",
      };
    if (
      weth > balances.wethWei ||
      usdc > stableBalanceOf(balances, TOKENS.USDC.address)
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

function capToBalance(
  tokenIn: TokenSymbol,
  desired: bigint,
  balances: BalanceSnapshot,
): bigint {
  const balance = tokenIn === "WETH" ? balances.wethWei : balances.usdcUnits;
  return desired > balance ? balance : desired;
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
    const positions = await getLpPositions(
      ctx.publicClient,
      agent,
      fairPrice,
      s.tick,
    );
    return {
      pool: {
        pair: "WETH/USDC",
        fee: UNISWAP.fee,
        priceUsdcPerWeth: s.priceUsdcPerWeth,
        tick: s.tick,
        tickSpacing: s.tickSpacing,
      },
      positions,
    };
  },

  async buildTxs(ctx, owner, action): Promise<BuiltTx[]> {
    if (action.type === "swap") {
      const slippageBps = (action as SwapAction).slippageBps ?? 50;
      const data = await buildSwapData(
        ctx.publicClient,
        owner,
        action as SwapAction,
        slippageBps,
      );
      return [{ to: UNISWAP.swapRouter, data }];
    }
    const slippageBps =
      action.type === "mintLiquidity" ? (action.slippageBps ?? 50) : 0;
    const data = await buildLpActionData(
      ctx.publicClient,
      owner,
      action,
      slippageBps,
    );
    return [{ to: UNISWAP.nonfungiblePositionManager, data }];
  },

  async valueUsdc(ctx, agent, _state, fairPrice): Promise<number> {
    const positions = await getLpPositions(ctx.publicClient, agent, fairPrice);
    return positions.reduce((sum, p) => sum + p.valueUsdc, 0);
  },

  async setupWallet(): Promise<BuiltTx[]> {
    return [
      approveTx(TOKENS.WETH.address, UNISWAP.swapRouter),
      approveTx(TOKENS.WETH.address, UNISWAP.nonfungiblePositionManager),
      approveTx(TOKENS.USDC.address, UNISWAP.swapRouter),
      approveTx(TOKENS.USDC.address, UNISWAP.nonfungiblePositionManager),
    ];
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
