import {
  encodeFunctionData,
  maxUint256,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { AAVE, TOKENS, stableBalanceOf } from "../constants.js";
import { marketsFor, tokenInfo } from "../markets.js";
import {
  accountAddress,
  fundWallet,
  increaseTime,
  mine,
  sendAndMine,
  sendAsImpersonated,
} from "../chain.js";
import { erc20Abi } from "../abis.js";
import type {
  AaveObservation,
  AgentObservation,
  BalanceSnapshot,
  LeafAction,
  TokenSymbol,
} from "../types.js";
import type {
  BuiltTx,
  ProtocolAdapter,
  SimContext,
  ValidationResult,
} from "./types.js";
import { approveTx } from "./uniswap.js";
import { deployContract } from "./deploy.js";

const DECIMAL_INTEGER = /^[0-9]+$/;
const VARIABLE_RATE = 2n;
const AAVE_PRICE_UNIT = 10n ** 8n; // $1 = 1e8

export function toAavePrice(usd: number): bigint {
  const P = 1_000_000n;
  return (BigInt(Math.round(usd * Number(P))) * AAVE_PRICE_UNIT) / P;
}

export const aavePoolAbi = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

export const aaveAddressesProviderAbi = parseAbi([
  "function getPoolConfigurator() view returns (address)",
]);

export const aavePoolConfiguratorAbi = parseAbi([
  "function setReserveFlashLoaning(address asset, bool enabled)",
]);

export const aaveDataProviderAbi = parseAbi([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
]);

// Pool.getReserveData は「生の」格納値（index/rate/lastUpdate）を返す。利息計算を
// 行わないため、後述の lastUpdateTimestamp が block.timestamp より未来でも revert しない。
// （getUserAccountData / PoolDataProvider.getReserveData は利息を計算するため revert する。）
export const aaveReserveDataAbi = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

export const aaveOracleAbi = parseAbi([
  "function getAssetPrice(address asset) view returns (uint256)",
  "function setAssetSources(address[] assets, address[] sources)",
  "function getSourceOfAsset(address asset) view returns (address)",
]);

export const aclManagerAbi = parseAbi([
  "function addPoolAdmin(address admin)",
  "function isPoolAdmin(address admin) view returns (bool)",
]);

export const mockAggregatorAbi = parseAbi([
  "function setAnswer(int256 answer)",
  "function latestAnswer() view returns (int256)",
]);

// Aave は native USDC を reserve（決済 stable）に使う。
const AAVE_STABLE = TOKENS.USDC.address;
const AAVE_STABLE_SYMBOL: TokenSymbol = "USDC";

// aave で有効な base シンボル群（MARKET_LEGS.aave 由来。fork 既定では WETH のみ）。
function aaveBaseSymbols(): TokenSymbol[] {
  return marketsFor("aave").map((m) => m.base);
}

// 我々が読み書きする reserve のシンボル群（有効 base + 決済 stable）。
// fork 既定では [WETH, USDC]（従来と一致）。
function aaveReserveSymbols(): TokenSymbol[] {
  return [...aaveBaseSymbols(), AAVE_STABLE_SYMBOL];
}

// シンボル -> reserve アドレス。stable は native USDC、それ以外は registry のアドレス。
function aaveAsset(symbol: TokenSymbol): Address {
  return symbol === AAVE_STABLE_SYMBOL
    ? AAVE_STABLE
    : tokenInfo(symbol).address;
}

type AaveActionType =
  | "aaveSupply"
  | "aaveWithdraw"
  | "aaveBorrow"
  | "aaveRepay";
const AAVE_TYPES: AaveActionType[] = [
  "aaveSupply",
  "aaveWithdraw",
  "aaveBorrow",
  "aaveRepay",
];

function requireAmount(
  value: unknown,
  name: string,
  allowMax: boolean,
): string {
  if (allowMax && value === "max") return "max";
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    throw new Error(
      `${name} must be a decimal integer string${allowMax ? ' or "max"' : ""}`,
    );
  return value;
}

// asset を有効 base / 決済 stable のシンボルとして受理する。fork 既定では WETH/USDC のみ。
function parseAsset(value: unknown): TokenSymbol {
  if (typeof value !== "string")
    throw new Error("asset must be a token symbol string");
  const allowed = new Set(aaveReserveSymbols());
  if (!allowed.has(value))
    throw new Error(`asset must be one of ${[...allowed].join(", ")}`);
  return value;
}

function parse(obj: Record<string, unknown>): LeafAction | null {
  const type = obj.type;
  if (typeof type !== "string" || !AAVE_TYPES.includes(type as AaveActionType))
    return null;
  const asset = parseAsset(obj.asset);
  const allowMax = type === "aaveWithdraw" || type === "aaveRepay";
  const amount = requireAmount(obj.amount, "amount", allowMax);
  const action = { type, asset, amount } as unknown as LeafAction;
  if (obj.maxPriorityFeePerGasWei !== undefined) {
    if (
      typeof obj.maxPriorityFeePerGasWei !== "string" ||
      !DECIMAL_INTEGER.test(obj.maxPriorityFeePerGasWei)
    ) {
      throw new Error(
        "maxPriorityFeePerGasWei must be a decimal integer string",
      );
    }
    (action as { maxPriorityFeePerGasWei?: string }).maxPriorityFeePerGasWei =
      obj.maxPriorityFeePerGasWei;
  }
  return action;
}

function validate(
  action: LeafAction,
  obs: AgentObservation,
  balances: BalanceSnapshot,
): ValidationResult {
  if (!AAVE_TYPES.includes(action.type as AaveActionType))
    return { ok: false, reason: "not an aave action" };
  const a = action as {
    type: AaveActionType;
    asset: TokenSymbol;
    amount: string;
  };
  // stable は USDC 相当の合算残高、base は bases マップ（WETH は wethWei と同値で互換）。
  const assetBalance = (): bigint =>
    a.asset === AAVE_STABLE_SYMBOL
      ? stableBalanceOf(balances, AAVE_STABLE)
      : (balances.bases?.[a.asset] ?? balances.wethWei);
  if (a.amount !== "max") {
    const amount = BigInt(a.amount);
    if (amount <= 0n) return { ok: false, reason: "amount must be positive" };
    if (a.type === "aaveSupply") {
      if (amount > assetBalance())
        return { ok: false, reason: "supply amount exceeds balance" };
      // WETH supply は従来の per-round limit を維持。新 base は balance チェックのみ（limits は Phase 8）。
      if (
        a.asset === "WETH" &&
        amount > BigInt(obs.limits.maxAaveSupplyWethWei)
      )
        return { ok: false, reason: "supply exceeds configured WETH limit" };
    }
    if (a.type === "aaveRepay") {
      if (amount > assetBalance())
        return { ok: false, reason: "repay amount exceeds balance" };
    }
    if (
      a.type === "aaveBorrow" &&
      a.asset === "USDC" &&
      amount > BigInt(obs.limits.maxAaveBorrowUsdcUnits)
    ) {
      return { ok: false, reason: "borrow exceeds configured USDC limit" };
    }
  }
  return { ok: true };
}

function buildTx(owner: Address, action: LeafAction): BuiltTx {
  const a = action as {
    type: AaveActionType;
    asset: TokenSymbol;
    amount: string;
  };
  const asset = aaveAsset(a.asset);
  const amount = a.amount === "max" ? maxUint256 : BigInt(a.amount);
  if (a.type === "aaveSupply") {
    return {
      to: AAVE.Pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: "supply",
        args: [asset, amount, owner, 0],
      }),
    };
  }
  if (a.type === "aaveWithdraw") {
    return {
      to: AAVE.Pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: "withdraw",
        args: [asset, amount, owner],
      }),
    };
  }
  if (a.type === "aaveBorrow") {
    return {
      to: AAVE.Pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: "borrow",
        args: [asset, amount, VARIABLE_RATE, 0, owner],
      }),
    };
  }
  return {
    to: AAVE.Pool,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "repay",
      args: [asset, amount, VARIABLE_RATE, owner],
    }),
  };
}

async function userReserve(
  publicClient: PublicClient,
  asset: Address,
  user: Address,
): Promise<{ supplied: bigint; borrowed: bigint }> {
  const r = (await publicClient.readContract({
    address: AAVE.PoolDataProvider,
    abi: aaveDataProviderAbi,
    functionName: "getUserReserveData",
    args: [asset, user],
  })) as readonly bigint[];
  return { supplied: r[0], borrowed: r[2] };
}

// orderflow bot の Aave 状態機械が必要とする reserve を読む。
// flow 生成自体は bot プロセス側だが、RPC 読取は coordinator が担い結果を FlowContext で渡す。
export async function readAaveFlowReserves(
  publicClient: PublicClient,
  wallet: Address,
): Promise<{ wethSupplied: bigint; usdcBorrowed: bigint }> {
  // 独立した 2 リードなので並列化して RPC レイテンシを抑える。
  const [weth, usdc] = await Promise.all([
    userReserve(publicClient, TOKENS.WETH.address, wallet),
    userReserve(publicClient, AAVE_STABLE, wallet),
  ]);
  return { wethSupplied: weth.supplied, usdcBorrowed: usdc.borrowed };
}

// reserve の最終更新時刻（生の格納値。利息計算しないので未来でも revert しない）。
async function reserveLastUpdate(
  publicClient: PublicClient,
  asset: Address,
): Promise<bigint> {
  const r = (await publicClient.readContract({
    address: AAVE.Pool,
    abi: aaveReserveDataAbi,
    functionName: "getReserveData",
    args: [asset],
  })) as { lastUpdateTimestamp: number | bigint };
  return BigInt(r.lastUpdateTimestamp);
}

// Aave フォークの時刻整合を取る。Arbitrum を anvil でフォークすると、ブロックの
// block.timestamp が reserve の lastUpdateTimestamp より過去になることがある
// （フォークブロックの timestamp と state スナップショットのズレ。間欠的に発生）。
// その状態では Aave の利息計算 `dt = block.timestamp - lastUpdateTimestamp` が
// uint アンダーフロー(panic 0x11)を起こし、getUserAccountData / getReserveData が
// revert → 最初の observe で sim 全体がクラッシュする。
// 対策: 我々が使う WETH/USDC reserve の lastUpdateTimestamp を読み、block.timestamp が
// それ以下(dt<=0)なら超えるまで EVM 時間を進める。これでラウンドループ中の Aave 読取が
// 常に dt>0 となり、（間欠クラッシュせず）長走行でも aave 戦略を評価できる。
// resetFork が forking 付き再フォークを行えば block.timestamp は通常 lastUpdate より後に
// なるためここは発火しないが、フォークブロック次第で稀に逆転するため防御として残す。
const AAVE_WARP_BUFFER_SECONDS = 3600n; // 1h。発火時に dt>0 を安定させる余裕。
const LOCAL_FLASH_LIQUIDITY_USDC_UNITS = 100_000n * 10n ** 6n;
async function warpPastReserveLastUpdate(ctx: SimContext): Promise<void> {
  // 有効 reserve（fork 既定では [WETH, USDC]）の lastUpdate を読み、その最大を超える。
  const updates = await Promise.all(
    aaveReserveSymbols().map((sym) =>
      reserveLastUpdate(ctx.publicClient, aaveAsset(sym)),
    ),
  );
  const maxUpdate = updates.reduce((m, u) => (u > m ? u : m), 0n);
  const now = (await ctx.publicClient.getBlock()).timestamp;
  if (now > maxUpdate) return; // dt>0 済み（健全なフォークブロック）→ 何もしない
  await increaseTime(
    ctx.publicClient,
    Number(maxUpdate - now + AAVE_WARP_BUFFER_SECONDS),
  );
  await mine(ctx.publicClient);
}

async function enableLocalFlashLoaning(ctx: SimContext): Promise<void> {
  if (!ctx.config.localDeploy) return;
  const configurator = (await ctx.publicClient.readContract({
    address: AAVE.PoolAddressesProvider,
    abi: aaveAddressesProviderAbi,
    functionName: "getPoolConfigurator",
  })) as Address;
  // 有効 reserve（fork 既定では [WETH, USDC]）の flashloan flag を有効化。
  for (const sym of aaveReserveSymbols()) {
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: configurator,
        data: encodeFunctionData({
          abi: aavePoolConfiguratorAbi,
          functionName: "setReserveFlashLoaning",
          args: [aaveAsset(sym), true],
        }),
      },
    );
  }
}

async function seedLocalFlashLoanLiquidity(ctx: SimContext): Promise<void> {
  if (!ctx.config.localDeploy) return;
  const current = (await ctx.publicClient.readContract({
    address: AAVE_STABLE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [AAVE.Pool],
  })) as bigint;
  if (current >= LOCAL_FLASH_LIQUIDITY_USDC_UNITS) return;
  const missing = LOCAL_FLASH_LIQUIDITY_USDC_UNITS - current;

  await fundWallet(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    0n,
    0n,
    missing,
  );
  await sendAndMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: AAVE_STABLE,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [AAVE.Pool, missing],
      }),
    },
  );
  await sendAndMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: AAVE.Pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: "supply",
        args: [AAVE_STABLE, missing, accountAddress(ctx.adminPk), 0],
      }),
    },
  );
}

export const aaveAdapter: ProtocolAdapter = {
  id: "aave",
  stableToken: AAVE_STABLE,
  parse,
  bundleable: () => true,
  validate,

  async readState() {
    return {};
  },

  async observe(ctx, _state, agent): Promise<AaveObservation> {
    // 有効 reserve（fork 既定では [WETH, USDC]）ごとに supplied/borrowed を読む。
    const reserveSymbols = aaveReserveSymbols();
    const [account, reserves, poolUsdc] = await Promise.all([
      ctx.publicClient.readContract({
        address: AAVE.Pool,
        abi: aavePoolAbi,
        functionName: "getUserAccountData",
        args: [agent],
      }) as Promise<readonly bigint[]>,
      Promise.all(
        reserveSymbols.map((sym) =>
          userReserve(ctx.publicClient, aaveAsset(sym), agent),
        ),
      ),
      ctx.publicClient.readContract({
        address: AAVE_STABLE,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [AAVE.Pool],
      }) as Promise<bigint>,
    ]);
    const supplied: Partial<Record<TokenSymbol, string>> = {};
    const borrowed: Partial<Record<TokenSymbol, string>> = {};
    reserveSymbols.forEach((sym, i) => {
      supplied[sym] = reserves[i].supplied.toString();
      borrowed[sym] = reserves[i].borrowed.toString();
    });
    return {
      healthFactor: account[5].toString(),
      totalCollateralBase: account[0].toString(),
      totalDebtBase: account[1].toString(),
      availableBorrowsBase: account[2].toString(),
      supplied,
      borrowed,
      poolLiquidity: {
        USDC: poolUsdc.toString(),
      },
    };
  },

  async buildTxs(_ctx, owner, action): Promise<BuiltTx[]> {
    return [buildTx(owner, action)];
  },

  async valueUsdc(ctx, agent): Promise<number> {
    const account = (await ctx.publicClient.readContract({
      address: AAVE.Pool,
      abi: aavePoolAbi,
      functionName: "getUserAccountData",
      args: [agent],
    })) as readonly bigint[];
    // base currency は USD 8 桁。net = collateral - debt をドル換算（USDC 相当）。
    // 担保(aToken)は wallet 外、借入(USDC)は wallet 内に計上済みのため net で二重計上を相殺。
    const net = account[0] - account[1];
    return Number(net) / 1e8;
  },

  async setupWallet(): Promise<BuiltTx[]> {
    // 有効 reserve（fork 既定では [WETH, USDC]）を Pool に approve。重複は排除。
    const seen = new Set<string>();
    const txs: BuiltTx[] = [];
    for (const sym of aaveReserveSymbols()) {
      const token = aaveAsset(sym);
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      txs.push(approveTx(token, AAVE.Pool));
    }
    return txs;
  },

  async setupGlobal(ctx: SimContext): Promise<void> {
    const admin = accountAddress(ctx.adminPk);
    // フォークの時刻ズレを補正（負の dt による利息計算アンダーフローを防ぐ）。
    // 以降の setup / ラウンドループでの Aave 読取が常に有効になる。
    await warpPastReserveLastUpdate(ctx);
    // 有効 reserve（fork 既定では [WETH, USDC]）ごとに、現在の Aave オラクル価格を初期値にして
    // mock aggregator を差し込む（連続性のため）。順序は aaveReserveSymbols() に従う。
    const reserveSymbols = aaveReserveSymbols();
    const reserveAssets = reserveSymbols.map(aaveAsset);
    const currentPrices = (await Promise.all(
      reserveAssets.map((asset) =>
        ctx.publicClient.readContract({
          address: AAVE.AaveOracle,
          abi: aaveOracleAbi,
          functionName: "getAssetPrice",
          args: [asset],
        }),
      ),
    )) as bigint[];
    const aggregators = await Promise.all(
      currentPrices.map((price) =>
        deployContract(ctx, "MockAggregator", [price]),
      ),
    );

    // POOL_ADMIN 付与（必要時）
    const isAdmin = (await ctx.publicClient.readContract({
      address: AAVE.AclManager,
      abi: aclManagerAbi,
      functionName: "isPoolAdmin",
      args: [admin],
    })) as boolean;
    if (!isAdmin) {
      await sendAsImpersonated(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        AAVE.AclAdmin,
        {
          to: AAVE.AclManager,
          data: encodeFunctionData({
            abi: aclManagerAbi,
            functionName: "addPoolAdmin",
            args: [admin],
          }),
        },
      );
    }

    // setAssetSources で mock に差し替え（有効 reserve をまとめて差し替え）
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: AAVE.AaveOracle,
        data: encodeFunctionData({
          abi: aaveOracleAbi,
          functionName: "setAssetSources",
          args: [reserveAssets, aggregators],
        }),
      },
    );

    reserveAssets.forEach((asset, i) => {
      ctx.oracle.aaveAggregators[asset.toLowerCase()] = aggregators[i];
    });

    // eris-app-deployer の shared WETH/USDC reserve は supply/borrow を有効化しているが、
    // flashloan flag は既定 false のため FlashArb が Aave error 91 で止まる。
    await enableLocalFlashLoaning(ctx);
    // local realtime setup は run ごとに snapshot へ戻るため、flashloan 用の pool liquidity
    // も setupGlobal で再投入する。これが無いと profitable signal 時に Pool の ERC20 残高不足で
    // `MockERC20: insufficient balance` になる。
    await seedLocalFlashLoanLiquidity(ctx);
  },
};
