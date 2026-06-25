import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  maxUint256,
  parseAbiParameters,
  toBytes,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GMX, GMX_MARKETS, TOKENS, stableBalanceOf } from "../constants.js";
import { marketFor, marketsFor, tokenInfo } from "../markets.js";
import { baseFairPrice } from "./marketHelpers.js";
import {
  accountAddress,
  increaseTime,
  mine,
  sendAndMine,
  sendAsImpersonated,
  sendNoMine,
} from "../chain.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  GmxObservation,
  GmxPositionObservation,
  LeafAction,
  TokenSymbol,
} from "../types.js";
import type {
  BuiltTx,
  ProtocolAdapter,
  SimContext,
  ValidationResult,
} from "./types.js";
import { deployContract } from "./deploy.js";

const DECIMAL_INTEGER = /^[0-9]+$/;
export const EXECUTION_FEE = 30_000_000_000_000_000n; // 0.03 ETH
const ORDER_TYPE = { MarketIncrease: 2, MarketDecrease: 4 } as const;
const DECREASE_SWAP_NO_SWAP = 0;
const FLOAT_PRECISION = 10n ** 30n;

// ---- ロール/キー（keccak256(abi.encode(string))）----
function hashString(s: string): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("string"), [s]));
}
const ROLES = {
  ROLE_ADMIN: hashString("ROLE_ADMIN"),
  CONTROLLER: hashString("CONTROLLER"),
  CONFIG_KEEPER: hashString("CONFIG_KEEPER"),
  ORDER_KEEPER: hashString("ORDER_KEEPER"),
  LIQUIDATION_KEEPER: hashString("LIQUIDATION_KEEPER"),
  ADL_KEEPER: hashString("ADL_KEEPER"),
} as const;
const IS_ORACLE_PROVIDER_ENABLED = hashString("IS_ORACLE_PROVIDER_ENABLED");
const ORACLE_PROVIDER_FOR_TOKEN = hashString("ORACLE_PROVIDER_FOR_TOKEN");
const MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR = hashString(
  "MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR",
);
function isOracleProviderEnabledKey(provider: Address): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, address"), [
      IS_ORACLE_PROVIDER_ENABLED,
      provider,
    ]),
  );
}
function oracleProviderForTokenKey(oracle: Address, token: Address): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, address, address"), [
      ORACLE_PROVIDER_FOR_TOKEN,
      oracle,
      token,
    ]),
  );
}

// GMX price = usd * 10^(30 - tokenDecimals)
export function toGmxPrice(usd: number, tokenDecimals: number): bigint {
  const P = 1_000_000n;
  const usdScaled = BigInt(Math.round(usd * Number(P)));
  return (usdScaled * 10n ** BigInt(30 - tokenDecimals)) / P;
}

// ---- ABIs（参照 bot/src/abis.ts より）----
const roleStoreAbi = [
  {
    type: "function",
    name: "grantRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "roleKey", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "roleKey", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "getRoleMembers",
    stateMutability: "view",
    inputs: [
      { name: "roleKey", type: "bytes32" },
      { name: "start", type: "uint256" },
      { name: "end", type: "uint256" },
    ],
    outputs: [{ type: "address[]" }],
  },
] as const;

const dataStoreAbi = [
  {
    type: "function",
    name: "setBool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "bytes32" },
      { name: "value", type: "bool" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "setAddress",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "bytes32" },
      { name: "value", type: "address" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "setUint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "bytes32" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const mockOracleProviderAbi = [
  {
    type: "function",
    name: "setPrice",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "min", type: "uint256" },
      { name: "max", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const createOrderParamsComponents = [
  {
    name: "addresses",
    type: "tuple",
    components: [
      { name: "receiver", type: "address" },
      { name: "cancellationReceiver", type: "address" },
      { name: "callbackContract", type: "address" },
      { name: "uiFeeReceiver", type: "address" },
      { name: "market", type: "address" },
      { name: "initialCollateralToken", type: "address" },
      { name: "swapPath", type: "address[]" },
    ],
  },
  {
    name: "numbers",
    type: "tuple",
    components: [
      { name: "sizeDeltaUsd", type: "uint256" },
      { name: "initialCollateralDeltaAmount", type: "uint256" },
      { name: "triggerPrice", type: "uint256" },
      { name: "acceptablePrice", type: "uint256" },
      { name: "executionFee", type: "uint256" },
      { name: "callbackGasLimit", type: "uint256" },
      { name: "minOutputAmount", type: "uint256" },
      { name: "validFromTime", type: "uint256" },
    ],
  },
  { name: "orderType", type: "uint8" },
  { name: "decreasePositionSwapType", type: "uint8" },
  { name: "isLong", type: "bool" },
  { name: "shouldUnwrapNativeToken", type: "bool" },
  { name: "autoCancel", type: "bool" },
  { name: "referralCode", type: "bytes32" },
  { name: "dataList", type: "bytes32[]" },
] as const;

const exchangeRouterAbi = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
  {
    type: "function",
    name: "sendWnt",
    stateMutability: "payable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sendTokens",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "createOrder",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: createOrderParamsComponents,
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const setPricesParamsComponent = {
  name: "oracleParams",
  type: "tuple",
  components: [
    { name: "tokens", type: "address[]" },
    { name: "providers", type: "address[]" },
    { name: "data", type: "bytes[]" },
  ],
} as const;
const orderHandlerAbi = [
  {
    type: "function",
    name: "executeOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "key", type: "bytes32" }, setPricesParamsComponent],
    outputs: [],
  },
] as const;

const positionPropsComponents = [
  {
    name: "addresses",
    type: "tuple",
    components: [
      { name: "account", type: "address" },
      { name: "market", type: "address" },
      { name: "collateralToken", type: "address" },
    ],
  },
  {
    name: "numbers",
    type: "tuple",
    components: [
      { name: "sizeInUsd", type: "uint256" },
      { name: "sizeInTokens", type: "uint256" },
      { name: "collateralAmount", type: "uint256" },
      { name: "pendingImpactAmount", type: "int256" },
      { name: "borrowingFactor", type: "uint256" },
      { name: "fundingFeeAmountPerSize", type: "uint256" },
      { name: "longTokenClaimableFundingAmountPerSize", type: "uint256" },
      { name: "shortTokenClaimableFundingAmountPerSize", type: "uint256" },
      { name: "increasedAtTime", type: "uint256" },
      { name: "decreasedAtTime", type: "uint256" },
    ],
  },
  {
    name: "flags",
    type: "tuple",
    components: [{ name: "isLong", type: "bool" }],
  },
] as const;
const readerAbi = [
  {
    type: "function",
    name: "getAccountPositions",
    stateMutability: "view",
    inputs: [
      { name: "dataStore", type: "address" },
      { name: "account", type: "address" },
      { name: "start", type: "uint256" },
      { name: "end", type: "uint256" },
    ],
    outputs: [{ type: "tuple[]", components: positionPropsComponents }],
  },
] as const;

type Position = {
  addresses: { account: Address; market: Address; collateralToken: Address };
  numbers: {
    sizeInUsd: bigint;
    sizeInTokens: bigint;
    collateralAmount: bigint;
  };
  flags: { isLong: boolean };
};

const ORDER_CREATED_HASH = keccak256(toBytes("OrderCreated"));
const ORDER_CANCELLED_HASH = keccak256(toBytes("OrderCancelled"));
// 真因究明用(デバッグ): keeper executeOrder の receipt に現れる GMX イベントを名前で識別する。
const GMX_DEBUG_EVENT_HASHES: Record<string, string> = {
  OrderExecuted: keccak256(toBytes("OrderExecuted")),
  OrderCancelled: keccak256(toBytes("OrderCancelled")),
  OrderFrozen: keccak256(toBytes("OrderFrozen")),
  PositionIncrease: keccak256(toBytes("PositionIncrease")),
  PositionDecrease: keccak256(toBytes("PositionDecrease")),
};

function gmxCollateral(symbol: TokenSymbol): Address {
  return symbol === "WETH" ? TOKENS.WETH.address : TOKENS.USDC.address;
}

// action の base（既定 WETH）から index market アドレスを解決する。
// fork 既定（ctx.gmx.markets 未設定・WETH 1 market）では常に ctx.gmx.market を返し、
// 従来挙動と byte 一致する。WBTC 等は ctx.gmx.markets / MARKET_LEGS から解決。
function resolveGmxMarket(ctx: SimContext, base: TokenSymbol): Address {
  if (base === "WETH") return ctx.gmx.markets?.WETH ?? ctx.gmx.market;
  return (
    ctx.gmx.markets?.[base] ??
    marketFor("gmx", base)?.gmx?.market ??
    ctx.gmx.market
  );
}

// 全 gmx market の (base, market アドレス) を列挙する。fork 既定では WETH 1 件。
// ctx.gmx.markets が設定済みならそれを優先（base -> market）、無ければ MARKET_LEGS から導出。
function gmxMarketEntries(
  ctx: SimContext,
): Array<{ base: TokenSymbol; market: Address }> {
  if (ctx.gmx.markets && Object.keys(ctx.gmx.markets).length > 0) {
    return Object.entries(ctx.gmx.markets).map(([base, market]) => ({
      base,
      market,
    }));
  }
  const entries = marketsFor("gmx")
    .filter((m) => m.gmx)
    .map((m) => ({ base: m.base, market: m.gmx!.market }));
  // WETH market は ctx.gmx.market（setupGlobal が確定したアドレス）を一次情報にして互換維持。
  return entries.map((e) =>
    e.base === "WETH" ? { base: e.base, market: ctx.gmx.market } : e,
  );
}

function looseAcceptablePrice(isLong: boolean, isIncrease: boolean): bigint {
  // long増加 / short減少: price <= acceptable を満たすため max
  // short増加 / long減少: price >= acceptable を満たすため 0
  const wantMax = (isLong && isIncrease) || (!isLong && !isIncrease);
  return wantMax ? maxUint256 : 0n;
}

// GMX EventEmitter の eventData(hex)から ASCII 可読の reason 文字列を抽出する(デバッグ用)。
// OrderCancelled の reason は ASCII 文字列(例 "OrderNotFulfillableAtAcceptablePrice")で
// eventData に乗るため、6 文字以上の可読断片を拾えば真因が読める。
function asciiReason(data: string): string {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  let s = "";
  for (let i = 0; i + 2 <= hex.length; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16);
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : ".";
  }
  const words = s.split(/\.+/).filter((w) => w.length >= 6);
  return words.join(" | ") || "(no ascii reason)";
}

function buildCreateOrderParams(args: {
  owner: Address;
  market: Address;
  collateralToken: Address;
  sizeDeltaUsd: bigint;
  collateralDelta: bigint;
  acceptablePrice: bigint;
  orderType: number;
  isLong: boolean;
}) {
  return {
    addresses: {
      receiver: args.owner,
      cancellationReceiver: zeroAddress,
      callbackContract: zeroAddress,
      uiFeeReceiver: zeroAddress,
      market: args.market,
      initialCollateralToken: args.collateralToken,
      swapPath: [] as Address[],
    },
    numbers: {
      sizeDeltaUsd: args.sizeDeltaUsd,
      initialCollateralDeltaAmount: args.collateralDelta,
      triggerPrice: 0n,
      acceptablePrice: args.acceptablePrice,
      executionFee: EXECUTION_FEE,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    orderType: args.orderType,
    decreasePositionSwapType: DECREASE_SWAP_NO_SWAP,
    isLong: args.isLong,
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: zeroHash,
    dataList: [] as Hex[],
  } as const;
}

function enc(
  functionName: "sendWnt" | "sendTokens" | "createOrder" | "multicall",
  args: readonly unknown[],
): Hex {
  return encodeFunctionData({
    abi: exchangeRouterAbi,
    functionName,
    args: args as never,
  });
}

function buildOrderTx(
  owner: Address,
  market: Address,
  action: LeafAction,
): BuiltTx {
  const isIncrease = action.type === "gmxIncrease";
  const a = action as {
    isLong: boolean;
    collateral: TokenSymbol;
    sizeDeltaUsd: string;
    acceptablePrice?: string;
    collateralAmount?: string;
    collateralDeltaAmount?: string;
  };
  const collateralToken = gmxCollateral(a.collateral);
  const sizeDeltaUsd = BigInt(a.sizeDeltaUsd);
  const acceptablePrice = a.acceptablePrice
    ? BigInt(a.acceptablePrice)
    : looseAcceptablePrice(a.isLong, isIncrease);

  if (isIncrease) {
    const collateralAmount = BigInt(a.collateralAmount ?? "0");
    const params = buildCreateOrderParams({
      owner,
      market,
      collateralToken,
      sizeDeltaUsd,
      collateralDelta: collateralAmount,
      acceptablePrice,
      orderType: ORDER_TYPE.MarketIncrease,
      isLong: a.isLong,
    });
    const calls: Hex[] = [];
    let value: bigint;
    if (a.collateral === "WETH") {
      const wnt = EXECUTION_FEE + collateralAmount;
      calls.push(enc("sendWnt", [GMX.OrderVault, wnt]));
      value = wnt;
    } else {
      calls.push(enc("sendWnt", [GMX.OrderVault, EXECUTION_FEE]));
      calls.push(
        enc("sendTokens", [collateralToken, GMX.OrderVault, collateralAmount]),
      );
      value = EXECUTION_FEE;
    }
    calls.push(enc("createOrder", [params]));
    return { to: GMX.ExchangeRouter, data: enc("multicall", [calls]), value };
  }

  // decrease
  const collateralDelta = BigInt(a.collateralDeltaAmount ?? "0");
  const params = buildCreateOrderParams({
    owner,
    market,
    collateralToken,
    sizeDeltaUsd,
    collateralDelta,
    acceptablePrice,
    orderType: ORDER_TYPE.MarketDecrease,
    isLong: a.isLong,
  });
  const calls: Hex[] = [
    enc("sendWnt", [GMX.OrderVault, EXECUTION_FEE]),
    enc("createOrder", [params]),
  ];
  return {
    to: GMX.ExchangeRouter,
    data: enc("multicall", [calls]),
    value: EXECUTION_FEE,
  };
}

function requireDecimalString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    throw new Error(`${name} must be a decimal integer string`);
}

function parse(obj: Record<string, unknown>): LeafAction | null {
  if (obj.type !== "gmxIncrease" && obj.type !== "gmxDecrease") return null;
  if (typeof obj.isLong !== "boolean")
    throw new Error("isLong must be boolean");
  if (obj.collateral !== "WETH" && obj.collateral !== "USDC")
    throw new Error("collateral must be WETH or USDC");
  requireDecimalString(obj.sizeDeltaUsd, "sizeDeltaUsd");
  // index market の base（既定 WETH = ETH/USD。ADR 0013）。WETH 以外は market が必要。
  const base = typeof obj.base === "string" ? obj.base : "WETH";
  if (base !== "WETH" && !marketFor("gmx", base)?.gmx)
    throw new Error(`gmx: no market for base "${base}"`);
  const action = {
    type: obj.type,
    isLong: obj.isLong,
    collateral: obj.collateral,
    sizeDeltaUsd: obj.sizeDeltaUsd,
  } as Record<string, unknown>;
  if (base !== "WETH") action.base = base;
  if (obj.type === "gmxIncrease") {
    requireDecimalString(obj.collateralAmount, "collateralAmount");
    action.collateralAmount = obj.collateralAmount;
  } else {
    requireDecimalString(obj.collateralDeltaAmount, "collateralDeltaAmount");
    action.collateralDeltaAmount = obj.collateralDeltaAmount;
  }
  if (obj.acceptablePrice !== undefined) {
    requireDecimalString(obj.acceptablePrice, "acceptablePrice");
    action.acceptablePrice = obj.acceptablePrice;
  }
  if (obj.maxPriorityFeePerGasWei !== undefined) {
    requireDecimalString(
      obj.maxPriorityFeePerGasWei,
      "maxPriorityFeePerGasWei",
    );
    action.maxPriorityFeePerGasWei = obj.maxPriorityFeePerGasWei;
  }
  return action as unknown as LeafAction;
}

function validate(
  action: LeafAction,
  obs: AgentObservation,
  balances: BalanceSnapshot,
): ValidationResult {
  if (action.type !== "gmxIncrease" && action.type !== "gmxDecrease")
    return { ok: false, reason: "not a gmx action" };
  const a = action as {
    type: string;
    collateral: TokenSymbol;
    sizeDeltaUsd: string;
    collateralAmount?: string;
    collateralDeltaAmount?: string;
  };
  const sizeDeltaUsd = BigInt(a.sizeDeltaUsd);
  if (sizeDeltaUsd <= 0n)
    return { ok: false, reason: "sizeDeltaUsd must be positive" };
  if (sizeDeltaUsd > BigInt(obs.limits.maxGmxSizeUsd))
    return { ok: false, reason: "sizeDeltaUsd exceeds configured max" };
  if (a.type === "gmxIncrease") {
    const collateralAmount = BigInt(a.collateralAmount ?? "0");
    if (collateralAmount <= 0n)
      return { ok: false, reason: "collateralAmount must be positive" };
    if (a.collateral === "USDC") {
      if (collateralAmount > stableBalanceOf(balances, TOKENS.USDC.address))
        return { ok: false, reason: "collateralAmount exceeds balance" };
    } else {
      // WETH 担保は native ETH を sendWnt で wrap して送るため、ETH 残高で担保+実行手数料を確認する
      if (collateralAmount + EXECUTION_FEE > balances.ethWei)
        return {
          ok: false,
          reason: "collateralAmount + execution fee exceeds ETH balance",
        };
    }
  }
  return { ok: true };
}

// account の全 position を 1 回読む（market 走査の元データ）。
async function getAccountPositions(
  publicClient: PublicClient,
  account: Address,
): Promise<Position[]> {
  return (await publicClient.readContract({
    address: GMX.Reader,
    abi: readerAbi,
    functionName: "getAccountPositions",
    args: [GMX.DataStore, account, 0n, 50n],
  })) as unknown as Position[];
}

// 指定 market アドレスの「建っている」position を取り出す（sizeInUsd>0）。
// sizeInUsd===0 は実質ポジション無しとして undefined を返す（従来の observe/value 挙動と一致）。
function positionForMarket(
  positions: readonly Position[],
  market: Address,
): Position | undefined {
  const p = positions.find(
    (q) => q.addresses.market.toLowerCase() === market.toLowerCase(),
  );
  return p && p.numbers.sizeInUsd !== 0n ? p : undefined;
}

// base の index トークン decimals（sizeInTokens のスケール）。既定 WETH=18 で従来と一致。
function baseDecimals(base: TokenSymbol): number {
  return tokenInfo(base).decimals;
}

function positionPnlUsd(
  p: Position,
  markPrice: number,
  base: TokenSymbol = "WETH",
): number {
  if (p.numbers.sizeInTokens === 0n) return 0;
  const sizeTokens = Number(p.numbers.sizeInTokens) / 10 ** baseDecimals(base);
  const entryPrice =
    Number(p.numbers.sizeInUsd) / FLOAT_PRECISION_NUM / sizeTokens;
  const diff = markPrice - entryPrice;
  return (p.flags.isLong ? diff : -diff) * sizeTokens;
}
const FLOAT_PRECISION_NUM = 1e30;

// position の USD 評価（担保 + PnL）。markPrice は index base の価格、wethPrice は WETH 担保
// 評価用の WETH 価格（WETH market では markPrice と同値）。collateral が WETH なら WETH 価格、
// USDC なら $1 換算。fork 既定（WETH market・WETH 担保・1e18）では従来式と byte 一致する
// （markPrice===wethPrice なので (collateralAmount/1e18)*markPrice と一致）。
function positionValueUsd(
  p: Position,
  markPrice: number,
  base: TokenSymbol,
  wethPrice: number,
): number {
  if (p.numbers.sizeInUsd === 0n) return 0;
  const collateralUsd =
    p.addresses.collateralToken.toLowerCase() ===
    TOKENS.WETH.address.toLowerCase()
      ? (Number(p.numbers.collateralAmount) / 1e18) * wethPrice
      : Number(p.numbers.collateralAmount) / 1e6;
  return collateralUsd + positionPnlUsd(p, markPrice, base);
}

// Position -> GmxPositionObservation。entryPrice / pnl は base decimals で一般化。
// 既定 WETH（18 decimals）では従来式と byte 一致する。
function gmxPositionObservation(
  p: Position,
  markPrice: number,
  base: TokenSymbol,
): GmxPositionObservation {
  const sizeTokens = Number(p.numbers.sizeInTokens) / 10 ** baseDecimals(base);
  const entryPrice =
    sizeTokens > 0
      ? Number(p.numbers.sizeInUsd) / FLOAT_PRECISION_NUM / sizeTokens
      : 0;
  const collateral: TokenSymbol =
    p.addresses.collateralToken.toLowerCase() ===
    TOKENS.WETH.address.toLowerCase()
      ? "WETH"
      : "USDC";
  return {
    isLong: p.flags.isLong,
    sizeUsd: p.numbers.sizeInUsd.toString(),
    sizeInTokens: p.numbers.sizeInTokens.toString(),
    collateral,
    collateralAmount: p.numbers.collateralAmount.toString(),
    entryPriceUsd: entryPrice,
    pnlUsd: positionPnlUsd(p, markPrice, base),
  };
}

// ---------------------------------------------------------------------------
// 歴史ブロック再構成（ADR 0006 §4）: blockNumber 指定 multicall で使う読取記述子と、
// その結果から valueUsdc と同じ式でポジション価値を出す純粋関数。
// ---------------------------------------------------------------------------

export function gmxAccountPositionsCall(account: Address) {
  return {
    address: GMX.Reader,
    abi: readerAbi,
    functionName: "getAccountPositions",
    args: [GMX.DataStore, account, 0n, 50n],
  } as const;
}

// 後方互換シグネチャ（reconstruct が import）。WETH(ETH/USD) market のみ markPrice で評価する。
// WBTC 等の市場は reconstruct が WETH 価格しか渡せないため当面評価対象外（後続 Phase で対応）。
export function gmxEthUsdPositionValueUsd(
  positions: readonly Position[] | undefined,
  markPrice: number,
): number {
  const pos = positions
    ? positionForMarket(positions, GMX_MARKETS.ETH_USD)
    : undefined;
  if (!pos) return 0;
  return positionValueUsd(pos, markPrice, "WETH", markPrice);
}

export const gmxAdapter: ProtocolAdapter = {
  id: "gmx",
  stableToken: TOKENS.USDC.address,
  parse,
  bundleable: () => false, // keeper 実行が必要なため単独のみ
  validate,

  async readState() {
    return {};
  },

  async observe(ctx, _state, agent, fairPrice): Promise<GmxObservation> {
    const positions = await getAccountPositions(ctx.publicClient, agent);
    // WETH(ETH/USD) market は従来どおりトップレベルに載せる（byte 互換）。
    const wethMarketAddr = resolveGmxMarket(ctx, "WETH");
    const wethPos = positionForMarket(positions, wethMarketAddr);
    const obs: GmxObservation = {
      marketPriceUsd: fairPrice,
      ...(wethPos
        ? { position: gmxPositionObservation(wethPos, fairPrice, "WETH") }
        : {}),
    };

    // WETH 以外の index market（WBTC 等）を markets に追加。fork 既定では空。
    const extra: Record<
      string,
      { marketPriceUsd: number; position?: GmxPositionObservation }
    > = {};
    for (const { base, market } of gmxMarketEntries(ctx)) {
      if (base === "WETH") continue;
      const price = baseFairPrice(ctx, base, fairPrice);
      const pos = positionForMarket(positions, market);
      const key = marketFor("gmx", base)?.key ?? `${base}/USDC`;
      extra[key] = {
        marketPriceUsd: price,
        ...(pos ? { position: gmxPositionObservation(pos, price, base) } : {}),
      };
    }
    if (Object.keys(extra).length > 0) obs.markets = extra;
    return obs;
  },

  async buildTxs(ctx, owner, action): Promise<BuiltTx[]> {
    const base = (action as { base?: TokenSymbol }).base ?? "WETH";
    return [buildOrderTx(owner, resolveGmxMarket(ctx, base), action)];
  },

  // 競争ブロックで作成された注文を keeper が約定する
  async afterMine(
    ctx: SimContext,
    opts?: {
      noMine?: boolean;
      priorityFeeWei?: bigint;
      blockNumber?: bigint;
      fromBlock?: bigint;
      toBlock?: bigint;
    },
  ): Promise<void> {
    if (!ctx.gmx.mockProvider) return;
    // 範囲指定なら 1 回の getLogs でまとめて走査（realtime の追いつき分をブロックごとに
    // 呼ぶより RPC が 1/N になる）。単一 blockNumber は旧形互換。
    const toBlock =
      opts?.toBlock ??
      opts?.blockNumber ??
      (await ctx.publicClient.getBlockNumber());
    const fromBlock = opts?.fromBlock ?? opts?.blockNumber ?? toBlock;
    const logs = await ctx.publicClient.getLogs({
      address: GMX.EventEmitter,
      fromBlock,
      toBlock,
    });
    const keys = logs
      .filter(
        (l) =>
          (l.topics[1]?.toLowerCase() ?? "") ===
            ORDER_CREATED_HASH.toLowerCase() && l.topics[2],
      )
      .map((l) => l.topics[2] as Hex);
    if (keys.length === 0) return;

    const keeper = privateKeyToAccount(ctx.keeperPk);
    const oracleParams = {
      tokens: [TOKENS.WETH.address, TOKENS.USDC.address],
      providers: [ctx.gmx.mockProvider, ctx.gmx.mockProvider],
      data: ["0x", "0x"] as Hex[],
    };
    const fee = opts?.priorityFeeWei ?? 1_000_000_000n;
    for (const key of keys) {
      try {
        if (opts?.noMine) {
          // realtime: mine も increaseTime もしない。次ブロックに載せるだけ
          //（時間は interval mining が実時間で進める）。
          const block = await ctx.publicClient.getBlock();
          const baseFee = block.baseFeePerGas ?? 0n;
          const dbgHash = await ctx.walletClient.sendTransaction({
            account: keeper,
            chain: ctx.chain,
            to: GMX.OrderHandler,
            data: encodeFunctionData({
              abi: orderHandlerAbi,
              functionName: "executeOrder",
              args: [key, oracleParams],
            }),
            gas: 15_000_000n,
            maxFeePerGas: baseFee + fee,
            maxPriorityFeePerGas: fee,
          });
          // 真因究明(ERIS_GMX_KEEPER_DEBUG=1): receipt を待ち OrderCancelled の reason を stderr へ。
          // env gate なので通常 run には影響しない（receipt 待ちのブロッキングもデバッグ時のみ）。
          if (process.env.ERIS_GMX_KEEPER_DEBUG === "1") {
            try {
              const rcpt = await ctx.publicClient.waitForTransactionReceipt({
                hash: dbgHash,
                timeout: 10_000,
              });
              const gmxEvents = rcpt.logs
                .filter(
                  (l) =>
                    l.address.toLowerCase() === GMX.EventEmitter.toLowerCase(),
                )
                .map((l) => {
                  const h = l.topics[1]?.toLowerCase() ?? "";
                  for (const [name, hash] of Object.entries(
                    GMX_DEBUG_EVENT_HASHES,
                  ))
                    if (h === hash.toLowerCase()) return name;
                  return null;
                })
                .filter((x): x is string => x !== null);
              const cancel = rcpt.logs.find(
                (l) =>
                  l.address.toLowerCase() === GMX.EventEmitter.toLowerCase() &&
                  (l.topics[1]?.toLowerCase() ?? "") ===
                    ORDER_CANCELLED_HASH.toLowerCase(),
              );
              process.stderr.write(
                `[gmx-keeper-debug] key=${key.slice(0, 12)} status=${rcpt.status} events=[${gmxEvents.join(",") || "none"}]${cancel ? " reason=" + asciiReason(cancel.data) : ""}\n`,
              );
            } catch (e) {
              process.stderr.write(
                `[gmx-keeper-debug] receipt: ${e instanceof Error ? e.message : String(e)}\n`,
              );
            }
          }
          continue;
        }
        await increaseTime(ctx.publicClient, 2);
        const block = await ctx.publicClient.getBlock();
        const baseFee = block.baseFeePerGas ?? 0n;
        const hash = await ctx.walletClient.sendTransaction({
          account: keeper,
          chain: ctx.chain,
          to: GMX.OrderHandler,
          data: encodeFunctionData({
            abi: orderHandlerAbi,
            functionName: "executeOrder",
            args: [key, oracleParams],
          }),
          gas: 15_000_000n,
          maxFeePerGas: baseFee + 1_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        });
        await mine(ctx.publicClient);
        await ctx.publicClient.waitForTransactionReceipt({ hash });
      } catch (error) {
        // 約定失敗（acceptablePrice 等）はスキップ。GMX が自動でキャンセル/返金する。
        // 全件失敗が常態化（oracle 設定不備等）した場合に気づけるよう stderr に記録する。
        console.error(
          `gmx keeper executeOrder failed: key=${key} ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!opts?.noMine) await mine(ctx.publicClient);
      }
    }
  },

  async valueUsdc(ctx, agent, _state, fairPrice): Promise<number> {
    const positions = await getAccountPositions(ctx.publicClient, agent);
    const wethPrice = baseFairPrice(ctx, "WETH", fairPrice);
    // 全 gmx market の position 価値を当該 base の fair price で合算する。
    // fork 既定（WETH 1 market）では従来式と byte 一致（markPrice=wethPrice=fairPrice）。
    let total = 0;
    for (const { base, market } of gmxMarketEntries(ctx)) {
      const pos = positionForMarket(positions, market);
      if (!pos) continue;
      const markPrice =
        base === "WETH" ? wethPrice : baseFairPrice(ctx, base, fairPrice);
      total += positionValueUsd(pos, markPrice, base, wethPrice);
    }
    return total;
  },

  async setupWallet(): Promise<BuiltTx[]> {
    // USDC 担保用に Router を approve（WETH 担保は sendWnt で native 送付のため不要）
    return [
      {
        to: TOKENS.USDC.address,
        data: encodeFunctionData({
          abi: [
            {
              type: "function",
              name: "approve",
              stateMutability: "nonpayable",
              inputs: [
                { name: "s", type: "address" },
                { name: "a", type: "uint256" },
              ],
              outputs: [{ type: "bool" }],
            },
          ] as const,
          functionName: "approve",
          args: [GMX.Router, maxUint256],
        }),
      },
    ];
  },

  async setupGlobal(ctx: SimContext): Promise<void> {
    const admin = accountAddress(ctx.adminPk);
    const keeper = accountAddress(ctx.keeperPk);
    const mock = await deployContract(ctx, "MockOracleProvider", []);

    // ROLE_ADMIN を取得してロール付与
    const admins = (await ctx.publicClient.readContract({
      address: GMX.RoleStore,
      abi: roleStoreAbi,
      functionName: "getRoleMembers",
      args: [ROLES.ROLE_ADMIN, 0n, 10n],
    })) as readonly Address[];
    if (admins.length === 0) throw new Error("GMX ROLE_ADMIN holder not found");
    const roleAdmin = admins[0];
    const grants: Array<[Address, Hex]> = [
      [admin, ROLES.CONTROLLER],
      [admin, ROLES.CONFIG_KEEPER],
      [keeper, ROLES.ORDER_KEEPER],
      [keeper, ROLES.LIQUIDATION_KEEPER],
      [keeper, ROLES.ADL_KEEPER],
    ];
    for (const [account, roleKey] of grants) {
      const has = (await ctx.publicClient.readContract({
        address: GMX.RoleStore,
        abi: roleStoreAbi,
        functionName: "hasRole",
        args: [account, roleKey],
      })) as boolean;
      if (has) continue;
      await sendAsImpersonated(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        roleAdmin,
        {
          to: GMX.RoleStore,
          data: encodeFunctionData({
            abi: roleStoreAbi,
            functionName: "grantRole",
            args: [account, roleKey],
          }),
        },
      );
    }

    // DataStore: mock provider 有効化 + トークン割当 + 乖離チェック無効化（admin = CONTROLLER）
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: GMX.DataStore,
        data: encodeFunctionData({
          abi: dataStoreAbi,
          functionName: "setBool",
          args: [isOracleProviderEnabledKey(mock), true],
        }),
      },
    );
    for (const token of [TOKENS.WETH.address, TOKENS.USDC.address]) {
      await sendAndMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        ctx.adminPk,
        {
          to: GMX.DataStore,
          data: encodeFunctionData({
            abi: dataStoreAbi,
            functionName: "setAddress",
            args: [oracleProviderForTokenKey(GMX.Oracle, token), mock],
          }),
        },
      );
    }
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: GMX.DataStore,
        data: encodeFunctionData({
          abi: dataStoreAbi,
          functionName: "setUint",
          args: [MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR, maxUint256],
        }),
      },
    );

    ctx.gmx.mockProvider = mock;
    ctx.oracle.gmxProvider = mock;
    ctx.updateGmxOracle = async (c, fairPrice, opts) => {
      const send = (tx: { to: Address; data: Hex }): Promise<unknown> =>
        opts?.noMine
          ? sendNoMine(
              c.publicClient,
              c.walletClient,
              c.chain,
              c.adminPk,
              // gas を明示して estimateGas（anvil の実行キュー待ち）を省く
              { ...tx, gas: 300_000n },
              opts.priorityFeeWei ?? 1_000_000_000n,
            )
          : sendAndMine(c.publicClient, c.walletClient, c.chain, c.adminPk, tx);
      await send({
        to: mock,
        data: encodeFunctionData({
          abi: mockOracleProviderAbi,
          functionName: "setPrice",
          args: [
            TOKENS.WETH.address,
            toGmxPrice(fairPrice, 18),
            toGmxPrice(fairPrice, 18),
          ],
        }),
      });
      await send({
        to: mock,
        data: encodeFunctionData({
          abi: mockOracleProviderAbi,
          functionName: "setPrice",
          args: [TOKENS.USDC.address, toGmxPrice(1, 6), toGmxPrice(1, 6)],
        }),
      });
      // ADR 0013: 追加 base（WBTC 等）の index token も更新する。fork 既定では
      // ctx.gmx.markets が未設定 or WETH のみ → このループは空で従来と byte 一致。
      // 価格は ctx.fairPrices[base]、無ければ fairPrice（WETH 価格）へフォールバック。
      for (const { base } of gmxMarketEntries(c)) {
        if (base === "WETH") continue; // 上で更新済み
        const info = tokenInfo(base);
        await send({
          to: mock,
          data: encodeFunctionData({
            abi: mockOracleProviderAbi,
            functionName: "setPrice",
            args: [
              info.address,
              toGmxPrice(baseFairPrice(c, base, fairPrice), info.decimals),
              toGmxPrice(baseFairPrice(c, base, fairPrice), info.decimals),
            ],
          }),
        });
      }
    };
  },
};
