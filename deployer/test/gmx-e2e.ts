import {
  encodeAbiParameters,
  encodeFunctionData,
  decodeAbiParameters,
  keccak256,
  parseAbiParameters,
  maxUint256,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  accounts,
  deployerWallet,
  keeperWallet,
  traderWallet,
  publicClient,
  advance,
} from "../src/clients.js";
import { anvilChain } from "../src/config.js";
import { waitTx, loadForgeArtifact } from "../src/util.js";
import { gmxDeployment } from "./support.js";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

export const ORDER_TYPE_MARKET_INCREASE = 2;
export const EXECUTION_FEE = 30_000_000_000_000_000n; // 0.03 ETH (base-fee 0 なので余裕)

// hashString(s) = keccak256(abi.encode(string)) — GMX Keys.sol と同じ
function hashString(s: string): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("string"), [s]));
}

const IS_ORACLE_PROVIDER_ENABLED = hashString("IS_ORACLE_PROVIDER_ENABLED");
const ORACLE_PROVIDER_FOR_TOKEN = hashString("ORACLE_PROVIDER_FOR_TOKEN");
const MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR = hashString(
  "MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR",
);
const ORDER_KEEPER = hashString("ORDER_KEEPER");
const ROLE_ADMIN = hashString("ROLE_ADMIN");

export const KEYS = {
  isOracleProviderEnabled: (provider: Address): Hex =>
    keccak256(
      encodeAbiParameters(parseAbiParameters("bytes32, address"), [
        IS_ORACLE_PROVIDER_ENABLED,
        provider,
      ]),
    ),
  oracleProviderForToken: (oracle: Address, token: Address): Hex =>
    keccak256(
      encodeAbiParameters(parseAbiParameters("bytes32, address, address"), [
        ORACLE_PROVIDER_FOR_TOKEN,
        oracle,
        token,
      ]),
    ),
  MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR,
};

/** USD 価格を GMX スケール (price * 10^(30 - tokenDecimals)) に変換 */
export function toGmxPrice(usd: number, tokenDecimals: number): bigint {
  const PRECISION = 1_000_000n;
  const usdScaled = BigInt(Math.round(usd * Number(PRECISION)));
  return (usdScaled * 10n ** BigInt(30 - tokenDecimals)) / PRECISION;
}

// ---------------------------------------------------------------------------
// ABI
// ---------------------------------------------------------------------------

export const roleStoreAbi = [
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
    name: "grantRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "roleKey", type: "bytes32" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

export const dataStoreAbi = [
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
] as const satisfies Abi;

const orderAddresses = {
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
} as const;

const orderNumbers = {
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
} as const;

const depositAddresses = {
  name: "addresses",
  type: "tuple",
  components: [
    { name: "receiver", type: "address" },
    { name: "callbackContract", type: "address" },
    { name: "uiFeeReceiver", type: "address" },
    { name: "market", type: "address" },
    { name: "initialLongToken", type: "address" },
    { name: "initialShortToken", type: "address" },
    { name: "longTokenSwapPath", type: "address[]" },
    { name: "shortTokenSwapPath", type: "address[]" },
  ],
} as const;

export const exchangeRouterAbi = [
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
    name: "createDeposit",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          depositAddresses,
          { name: "minMarketTokens", type: "uint256" },
          { name: "shouldUnwrapNativeToken", type: "bool" },
          { name: "executionFee", type: "uint256" },
          { name: "callbackGasLimit", type: "uint256" },
          { name: "dataList", type: "bytes32[]" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "createOrder",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          orderAddresses,
          orderNumbers,
          { name: "orderType", type: "uint8" },
          { name: "decreasePositionSwapType", type: "uint8" },
          { name: "isLong", type: "bool" },
          { name: "shouldUnwrapNativeToken", type: "bool" },
          { name: "autoCancel", type: "bool" },
          { name: "referralCode", type: "bytes32" },
          { name: "dataList", type: "bytes32[]" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const satisfies Abi;

const setPricesParams = {
  name: "oracleParams",
  type: "tuple",
  components: [
    { name: "tokens", type: "address[]" },
    { name: "providers", type: "address[]" },
    { name: "data", type: "bytes[]" },
  ],
} as const;

export const depositHandlerAbi = [
  {
    type: "function",
    name: "executeDeposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "key", type: "bytes32" }, setPricesParams],
    outputs: [],
  },
] as const satisfies Abi;

export const orderHandlerAbi = [
  {
    type: "function",
    name: "executeOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "key", type: "bytes32" }, setPricesParams],
    outputs: [],
  },
] as const satisfies Abi;

const positionProps = {
  type: "tuple[]",
  components: [
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
  ],
} as const;

export const readerPositionsAbi = [
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
    outputs: [positionProps],
  },
] as const satisfies Abi;

export const mintableTokenAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const satisfies Abi;

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export type GmxRegistry = {
  DataStore: Address;
  RoleStore: Address;
  Oracle: Address;
  Router: Address;
  ExchangeRouter: Address;
  Reader: Address;
  OrderHandler: Address;
  DepositHandler: Address;
  OrderVault: Address;
  DepositVault: Address;
  tokens: Record<string, Address>;
  markets: {
    marketToken: Address;
    indexToken: Address;
    longToken: Address;
    shortToken: Address;
  }[];
};

export type Position = {
  addresses: { account: Address; market: Address; collateralToken: Address };
  numbers: { sizeInUsd: bigint; collateralAmount: bigint };
  flags: { isLong: boolean };
};

// ---------------------------------------------------------------------------
// セットアップ
// ---------------------------------------------------------------------------

const dep = accounts.deployer;

/** MockOracleProvider を deploy */
export async function deployMockOracleProvider(): Promise<Address> {
  const art = loadForgeArtifact("MockOracleProvider", "MockOracleProvider");
  const hash = await deployerWallet.deployContract({
    abi: art.abi,
    bytecode: art.bytecode,
    account: dep,
    chain: anvilChain,
  });
  const rc = await waitTx(hash);
  return rc.contractAddress as Address;
}

/**
 * keeper を execute 実行者として確定する。
 * deployer が ROLE_ADMIN を持てば keeper に ORDER_KEEPER を付与して keeper を返す。
 * 持たなければ deployer 自身が ORDER_KEEPER のため deployer にフォールバックする。
 */
export async function resolveKeeper(g: GmxRegistry): Promise<{
  account: typeof accounts.keeper;
  wallet: typeof keeperWallet;
}> {
  const keeperHas = await publicClient.readContract({
    address: g.RoleStore,
    abi: roleStoreAbi,
    functionName: "hasRole",
    args: [accounts.keeper.address, ORDER_KEEPER],
  });
  if (keeperHas) return { account: accounts.keeper, wallet: keeperWallet };

  const deployerIsAdmin = await publicClient.readContract({
    address: g.RoleStore,
    abi: roleStoreAbi,
    functionName: "hasRole",
    args: [dep.address, ROLE_ADMIN],
  });
  if (deployerIsAdmin) {
    const h = await deployerWallet.writeContract({
      address: g.RoleStore,
      abi: roleStoreAbi,
      functionName: "grantRole",
      args: [accounts.keeper.address, ORDER_KEEPER],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    return { account: accounts.keeper, wallet: keeperWallet };
  }
  // フォールバック: deployer は localhost ロールで ORDER_KEEPER を持つ
  return { account: dep, wallet: deployerWallet };
}

/** DataStore に mock provider を登録し、価格を設定する (deployer = CONTROLLER) */
export async function setupOracle(
  g: GmxRegistry,
  mock: Address,
  priceUsd: Record<Address, { usd: number; decimals: number }>,
): Promise<void> {
  const set = async (
    fn: "setBool" | "setAddress" | "setUint",
    args: readonly unknown[],
  ) => {
    const h = await deployerWallet.writeContract({
      address: g.DataStore,
      abi: dataStoreAbi,
      functionName: fn,
      // deno-lint-ignore no-explicit-any
      args: args as never,
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  };

  await set("setBool", [KEYS.isOracleProviderEnabled(mock), true]);
  await set("setUint", [
    KEYS.MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR,
    maxUint256,
  ]);
  for (const token of Object.keys(priceUsd) as Address[]) {
    await set("setAddress", [
      KEYS.oracleProviderForToken(g.Oracle, token),
      mock,
    ]);
    const { usd, decimals } = priceUsd[token];
    const price = toGmxPrice(usd, decimals);
    const h = await deployerWallet.writeContract({
      address: mock,
      abi: [
        {
          type: "function",
          name: "setPrice",
          stateMutability: "nonpayable",
          inputs: [
            { name: "token", type: "address" },
            { name: "price", type: "uint256" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "setPrice",
      args: [token, price],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  }
}

/** GMX テストトークンを mint し Router に approve (deployer が mint、receiver が approve) */
// 共有 WETH9 (wrappedNative) は mint を持たないため、receiver が ETH を wrap する。
const wethDepositAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const satisfies Abi;

export async function mintAndApprove(
  token: Address,
  receiver: { address: Address },
  receiverWallet: typeof traderWallet,
  router: Address,
  amount: bigint,
  opts?: { wrap?: boolean },
): Promise<void> {
  if (opts?.wrap) {
    // 共有 WETH9: receiver 自身が ETH を deposit して WETH を得る (mint 不可)。
    const depHash = await receiverWallet.writeContract({
      address: token,
      abi: wethDepositAbi,
      functionName: "deposit",
      value: amount,
      account: receiver as never,
      chain: anvilChain,
    });
    await waitTx(depHash);
  } else {
    const mintHash = await deployerWallet.writeContract({
      address: token,
      abi: mintableTokenAbi,
      functionName: "mint",
      args: [receiver.address, amount],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(mintHash);
  }
  const apHash = await receiverWallet.writeContract({
    address: token,
    abi: mintableTokenAbi,
    functionName: "approve",
    args: [router, maxUint256],
    account: receiver as never,
    chain: anvilChain,
  });
  await waitTx(apHash);
}

// ---------------------------------------------------------------------------
// multicall (create) — simulate で key を取得しつつ送信
// ---------------------------------------------------------------------------

function encExchange(
  functionName: "sendWnt" | "sendTokens" | "createDeposit" | "createOrder",
  args: readonly unknown[],
): Hex {
  return encodeFunctionData({
    abi: exchangeRouterAbi,
    functionName,
    // deno-lint-ignore no-explicit-any
    args: args as never,
  });
}

/** trader が ExchangeRouter.multicall を実行し、最後の戻り値 (bytes32 key) を返す */
async function submitMulticall(
  exchangeRouter: Address,
  calls: Hex[],
  value: bigint,
): Promise<Hex> {
  const { result, request } = await publicClient.simulateContract({
    address: exchangeRouter,
    abi: exchangeRouterAbi,
    functionName: "multicall",
    args: [calls],
    value,
    account: accounts.trader,
  });
  const results = result as readonly Hex[];
  const key = decodeAbiParameters(
    [{ type: "bytes32" }],
    results[results.length - 1],
  )[0] as Hex;
  // deno-lint-ignore no-explicit-any
  const hash = await traderWallet.writeContract(request as never);
  await waitTx(hash);
  return key;
}

/** GM 流動性 deposit を作成し deposit key を返す */
export async function createDeposit(
  g: GmxRegistry,
  market: GmxRegistry["markets"][number],
  longAmount: bigint,
  shortAmount: bigint,
): Promise<Hex> {
  const params = {
    addresses: {
      receiver: accounts.trader.address,
      callbackContract: zeroAddress,
      uiFeeReceiver: zeroAddress,
      market: market.marketToken,
      initialLongToken: market.longToken,
      initialShortToken: market.shortToken,
      longTokenSwapPath: [] as Address[],
      shortTokenSwapPath: [] as Address[],
    },
    minMarketTokens: 0n,
    shouldUnwrapNativeToken: false,
    executionFee: EXECUTION_FEE,
    callbackGasLimit: 0n,
    dataList: [] as Hex[],
  };
  const calls = [
    encExchange("sendWnt", [g.DepositVault, EXECUTION_FEE]),
    encExchange("sendTokens", [market.longToken, g.DepositVault, longAmount]),
    encExchange("sendTokens", [market.shortToken, g.DepositVault, shortAmount]),
    encExchange("createDeposit", [params]),
  ];
  return submitMulticall(g.ExchangeRouter, calls, EXECUTION_FEE);
}

/** openPosition (MarketIncrease long) を作成し order key を返す */
export async function createIncreaseOrder(
  g: GmxRegistry,
  market: GmxRegistry["markets"][number],
  collateralToken: Address,
  collateralAmount: bigint,
  sizeDeltaUsd: bigint,
  isLong: boolean,
): Promise<Hex> {
  const params = {
    addresses: {
      receiver: accounts.trader.address,
      cancellationReceiver: zeroAddress,
      callbackContract: zeroAddress,
      uiFeeReceiver: zeroAddress,
      market: market.marketToken,
      initialCollateralToken: collateralToken,
      swapPath: [] as Address[],
    },
    numbers: {
      sizeDeltaUsd,
      initialCollateralDeltaAmount: collateralAmount,
      triggerPrice: 0n,
      acceptablePrice: isLong ? maxUint256 : 0n, // long increase は上限なし
      executionFee: EXECUTION_FEE,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    orderType: ORDER_TYPE_MARKET_INCREASE,
    decreasePositionSwapType: 0,
    isLong,
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: zeroHash,
    dataList: [] as Hex[],
  };
  const calls = [
    encExchange("sendWnt", [g.OrderVault, EXECUTION_FEE]),
    encExchange("sendTokens", [
      collateralToken,
      g.OrderVault,
      collateralAmount,
    ]),
    encExchange("createOrder", [params]),
  ];
  return submitMulticall(g.ExchangeRouter, calls, EXECUTION_FEE);
}

// ---------------------------------------------------------------------------
// keeper execute
// ---------------------------------------------------------------------------

function oracleParams(mock: Address, tokens: Address[]) {
  return {
    tokens,
    providers: tokens.map(() => mock),
    data: tokens.map(() => "0x" as Hex),
  };
}

/** keeper が executeDeposit / executeOrder を実行する */
export async function keeperExecute(
  kind: "deposit" | "order",
  exec: { account: typeof accounts.keeper; wallet: typeof keeperWallet },
  handler: Address,
  key: Hex,
  mock: Address,
  tokens: Address[],
): Promise<void> {
  await advance(2); // 注文 timestamp より後の oracle timestamp を保証
  const abi = kind === "deposit" ? depositHandlerAbi : orderHandlerAbi;
  const fn = kind === "deposit" ? "executeDeposit" : "executeOrder";
  const hash = await exec.wallet.writeContract({
    address: handler,
    abi,
    functionName: fn,
    args: [key, oracleParams(mock, tokens)],
    account: exec.account as never,
    chain: anvilChain,
    gas: 20_000_000n,
  });
  const rc = await waitTx(hash);
  if (rc.status !== "success")
    throw new Error(`keeper ${fn} の tx が revert しました: ${hash}`);
}

/** trader の対象 market の long ポジションを取得 */
export async function getLongPosition(
  g: GmxRegistry,
  marketToken: Address,
): Promise<Position | undefined> {
  const positions = (await publicClient.readContract({
    address: g.Reader,
    abi: readerPositionsAbi,
    functionName: "getAccountPositions",
    args: [g.DataStore, accounts.trader.address, 0n, 50n],
  })) as readonly Position[];
  return positions.find(
    (p) =>
      p.addresses.market.toLowerCase() === marketToken.toLowerCase() &&
      p.flags.isLong,
  );
}

/** Reader ABI は registry から取得済みのものを使う (getMarkets 用に再利用) */
export function readerAbi(): Abi {
  return gmxDeployment("Reader").abi;
}
