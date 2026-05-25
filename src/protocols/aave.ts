import {
  encodeFunctionData,
  maxUint256,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { AAVE, TOKENS } from "../constants.js";
import { accountAddress, sendAndMine, sendAsImpersonated } from "../chain.js";
import type {
  AaveObservation,
  AgentObservation,
  BalanceSnapshot,
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

export const aaveDataProviderAbi = parseAbi([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
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

// Aave は native USDC を reserve に使う
const AAVE_STABLE = TOKENS.USDC.address;

function aaveAsset(symbol: TokenSymbol): Address {
  return symbol === "WETH" ? TOKENS.WETH.address : AAVE_STABLE;
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

function parse(obj: Record<string, unknown>): LeafAction | null {
  const type = obj.type;
  if (typeof type !== "string" || !AAVE_TYPES.includes(type as AaveActionType))
    return null;
  if (obj.asset !== "WETH" && obj.asset !== "USDC")
    throw new Error("asset must be WETH or USDC");
  const allowMax = type === "aaveWithdraw" || type === "aaveRepay";
  const amount = requireAmount(obj.amount, "amount", allowMax);
  const action = { type, asset: obj.asset, amount } as unknown as LeafAction;
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
  if (a.amount !== "max") {
    const amount = BigInt(a.amount);
    if (amount <= 0n) return { ok: false, reason: "amount must be positive" };
    if (a.type === "aaveSupply") {
      const bal = a.asset === "WETH" ? balances.wethWei : balances.usdcUnits;
      if (amount > bal)
        return { ok: false, reason: "supply amount exceeds balance" };
      if (
        a.asset === "WETH" &&
        amount > BigInt(obs.limits.maxAaveSupplyWethWei)
      )
        return { ok: false, reason: "supply exceeds configured WETH limit" };
    }
    if (a.type === "aaveRepay") {
      const bal = a.asset === "WETH" ? balances.wethWei : balances.usdcUnits;
      if (amount > bal)
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
    const [account, weth, usdc] = await Promise.all([
      ctx.publicClient.readContract({
        address: AAVE.Pool,
        abi: aavePoolAbi,
        functionName: "getUserAccountData",
        args: [agent],
      }) as Promise<readonly bigint[]>,
      userReserve(ctx.publicClient, TOKENS.WETH.address, agent),
      userReserve(ctx.publicClient, AAVE_STABLE, agent),
    ]);
    return {
      healthFactor: account[5].toString(),
      totalCollateralBase: account[0].toString(),
      totalDebtBase: account[1].toString(),
      availableBorrowsBase: account[2].toString(),
      supplied: {
        WETH: weth.supplied.toString(),
        USDC: usdc.supplied.toString(),
      },
      borrowed: {
        WETH: weth.borrowed.toString(),
        USDC: usdc.borrowed.toString(),
      },
    };
  },

  async buildTxs(_ctx, owner, action): Promise<BuiltTx[]> {
    return [buildTx(owner, action)];
  },

  // supply/borrow/repay の churn を生成し HF を動かす
  async buildFlow(ctx, _state, _fairPrice): Promise<FlowOrder[]> {
    const wallet = ctx.flowWallet("aave", "informed");
    const [weth] = await Promise.all([
      userReserve(ctx.publicClient, TOKENS.WETH.address, wallet.address),
    ]);
    const usdc = await userReserve(
      ctx.publicClient,
      AAVE_STABLE,
      wallet.address,
    );
    const fee =
      ctx.config.defaultPriorityFeeWei +
      BigInt(ctx.rng.int(1, 40)) * 1_000_000n;

    let action: LeafAction;
    if (weth.supplied === 0n) {
      const amount = ctx.config.aaveFlowMaxWethWei / 2n;
      action = {
        type: "aaveSupply",
        asset: "WETH",
        amount: amount.toString(),
      } as unknown as LeafAction;
    } else if (usdc.borrowed < 1_000_000_000n) {
      action = {
        type: "aaveBorrow",
        asset: "USDC",
        amount: "500000000",
      } as unknown as LeafAction; // 500 USDC
    } else if (ctx.rng.bool()) {
      action = {
        type: "aaveRepay",
        asset: "USDC",
        amount: "max",
      } as unknown as LeafAction;
    } else {
      action = {
        type: "aaveWithdraw",
        asset: "WETH",
        amount: "max",
      } as unknown as LeafAction;
    }
    return [{ kind: "informed", action, priorityFeeWei: fee }];
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
    return [
      approveTx(TOKENS.WETH.address, AAVE.Pool),
      approveTx(AAVE_STABLE, AAVE.Pool),
    ];
  },

  async setupGlobal(ctx: SimContext): Promise<void> {
    const admin = accountAddress(ctx.adminPk);
    // 現在の Aave オラクル価格を初期値にして mock を差し込む（連続性のため）
    const [wethUsd8, usdcUsd8] = (await Promise.all([
      ctx.publicClient.readContract({
        address: AAVE.AaveOracle,
        abi: aaveOracleAbi,
        functionName: "getAssetPrice",
        args: [TOKENS.WETH.address],
      }),
      ctx.publicClient.readContract({
        address: AAVE.AaveOracle,
        abi: aaveOracleAbi,
        functionName: "getAssetPrice",
        args: [AAVE_STABLE],
      }),
    ])) as [bigint, bigint];

    const wethAgg = await deployContract(ctx, "MockAggregator", [wethUsd8]);
    const usdcAgg = await deployContract(ctx, "MockAggregator", [usdcUsd8]);

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

    // setAssetSources で mock に差し替え
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
          args: [
            [TOKENS.WETH.address, AAVE_STABLE],
            [wethAgg, usdcAgg],
          ],
        }),
      },
    );

    ctx.oracle.aaveAggregators[TOKENS.WETH.address.toLowerCase()] = wethAgg;
    ctx.oracle.aaveAggregators[AAVE_STABLE.toLowerCase()] = usdcAgg;
  },
};
