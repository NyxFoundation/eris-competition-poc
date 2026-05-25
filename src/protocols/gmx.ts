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
import { GMX, GMX_MARKETS, TOKENS } from "../constants.js";
import {
  accountAddress,
  increaseTime,
  mine,
  sendAndMine,
  sendAsImpersonated,
} from "../chain.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  GmxObservation,
  LeafAction,
  TokenSymbol,
} from "../types.js";
import type {
  BuiltTx,
  FlowOrder,
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

function gmxCollateral(symbol: TokenSymbol): Address {
  return symbol === "WETH" ? TOKENS.WETH.address : TOKENS.USDC.address;
}

function looseAcceptablePrice(isLong: boolean, isIncrease: boolean): bigint {
  // long増加 / short減少: price <= acceptable を満たすため max
  // short増加 / long減少: price >= acceptable を満たすため 0
  const wantMax = (isLong && isIncrease) || (!isLong && !isIncrease);
  return wantMax ? maxUint256 : 0n;
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
  const action = {
    type: obj.type,
    isLong: obj.isLong,
    collateral: obj.collateral,
    sizeDeltaUsd: obj.sizeDeltaUsd,
  } as Record<string, unknown>;
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
    const bal = a.collateral === "WETH" ? balances.wethWei : balances.usdcUnits;
    // WETH 担保は ETH(native)を wrap して送るため ETH 残高も要するが、ここでは概算で WETH/USDC 残高を見る
    if (a.collateral === "USDC" && collateralAmount > bal)
      return { ok: false, reason: "collateralAmount exceeds balance" };
  }
  return { ok: true };
}

async function getEthUsdPosition(
  publicClient: PublicClient,
  account: Address,
): Promise<Position | undefined> {
  const positions = (await publicClient.readContract({
    address: GMX.Reader,
    abi: readerAbi,
    functionName: "getAccountPositions",
    args: [GMX.DataStore, account, 0n, 50n],
  })) as unknown as Position[];
  return positions.find(
    (p) =>
      p.addresses.market.toLowerCase() === GMX_MARKETS.ETH_USD.toLowerCase(),
  );
}

function positionPnlUsd(p: Position, markPrice: number): number {
  if (p.numbers.sizeInTokens === 0n) return 0;
  const sizeTokens = Number(p.numbers.sizeInTokens) / 1e18;
  const entryPrice =
    Number(p.numbers.sizeInUsd) / FLOAT_PRECISION_NUM / sizeTokens;
  const diff = markPrice - entryPrice;
  return (p.flags.isLong ? diff : -diff) * sizeTokens;
}
const FLOAT_PRECISION_NUM = 1e30;

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
    const pos = await getEthUsdPosition(ctx.publicClient, agent);
    if (!pos || pos.numbers.sizeInUsd === 0n)
      return { marketPriceUsd: fairPrice };
    const sizeTokens = Number(pos.numbers.sizeInTokens) / 1e18;
    const entryPrice =
      sizeTokens > 0
        ? Number(pos.numbers.sizeInUsd) / FLOAT_PRECISION_NUM / sizeTokens
        : 0;
    const collateral: TokenSymbol =
      pos.addresses.collateralToken.toLowerCase() ===
      TOKENS.WETH.address.toLowerCase()
        ? "WETH"
        : "USDC";
    return {
      marketPriceUsd: fairPrice,
      position: {
        isLong: pos.flags.isLong,
        sizeUsd: pos.numbers.sizeInUsd.toString(),
        sizeInTokens: pos.numbers.sizeInTokens.toString(),
        collateral,
        collateralAmount: pos.numbers.collateralAmount.toString(),
        entryPriceUsd: entryPrice,
        pnlUsd: positionPnlUsd(pos, fairPrice),
      },
    };
  },

  async buildTxs(ctx, owner, action): Promise<BuiltTx[]> {
    return [buildOrderTx(owner, ctx.gmx.market, action)];
  },

  // perp orderflow: 小口のロング/ショートを開いて約定ボリュームを作る（keeper が約定）
  async buildFlow(ctx): Promise<FlowOrder[]> {
    if (!ctx.rng.bool()) return []; // 約半数のラウンドは見送り（OI 過剰・実行負荷を抑制）
    const isLong = ctx.rng.bool();
    const collateralWei = 100_000_000_000_000_000n; // 0.1 WETH
    const sizeUsd = 400n * 10n ** 30n; // $400 (~2x)
    const fee =
      ctx.config.defaultPriorityFeeWei +
      BigInt(ctx.rng.int(1, 60)) * 1_000_000n;
    const action = {
      type: "gmxIncrease",
      isLong,
      collateral: "WETH",
      collateralAmount: collateralWei.toString(),
      sizeDeltaUsd: sizeUsd.toString(),
    } as unknown as LeafAction;
    return [{ kind: "uninformed", action, priorityFeeWei: fee }];
  },

  // 競争ブロックで作成された注文を keeper が約定する
  async afterMine(ctx: SimContext): Promise<void> {
    if (!ctx.gmx.mockProvider) return;
    const blockNumber = await ctx.publicClient.getBlockNumber();
    const logs = await ctx.publicClient.getLogs({
      address: GMX.EventEmitter,
      fromBlock: blockNumber,
      toBlock: blockNumber,
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
    for (const key of keys) {
      try {
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
      } catch {
        // 約定失敗（acceptablePrice 等）はスキップ。GMX が自動でキャンセル/返金する。
        await mine(ctx.publicClient);
      }
    }
  },

  async valueUsdc(ctx, agent, _state, fairPrice): Promise<number> {
    const pos = await getEthUsdPosition(ctx.publicClient, agent);
    if (!pos || pos.numbers.sizeInUsd === 0n) return 0;
    const collateralUsd =
      pos.addresses.collateralToken.toLowerCase() ===
      TOKENS.WETH.address.toLowerCase()
        ? (Number(pos.numbers.collateralAmount) / 1e18) * fairPrice
        : Number(pos.numbers.collateralAmount) / 1e6;
    return collateralUsd + positionPnlUsd(pos, fairPrice);
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
    ctx.updateGmxOracle = async (c, fairPrice) => {
      await sendAndMine(c.publicClient, c.walletClient, c.chain, c.adminPk, {
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
      await sendAndMine(c.publicClient, c.walletClient, c.chain, c.adminPk, {
        to: mock,
        data: encodeFunctionData({
          abi: mockOracleProviderAbi,
          functionName: "setPrice",
          args: [TOKENS.USDC.address, toGmxPrice(1, 6), toGmxPrice(1, 6)],
        }),
      });
    };
  },
};
