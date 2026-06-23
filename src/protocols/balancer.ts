import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { balancerQueriesAbi, balancerVaultAbi, wethAbi } from "../abis.js";
import { BALANCER, TOKENS, stableBalanceOf } from "../constants.js";
import { dealErc20, sendAndMine } from "../chain.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  BalancerSwapAction,
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
import { accountAddress } from "../chain.js";

const DECIMAL_INTEGER = /^[0-9]+$/;
const KIND_GIVEN_IN = 0;
const PROBE_WETH = 100_000_000_000_000_000n; // 0.1 WETH
const NO_USERDATA = "0x" as Hex;

type BalancerState = { priceUsdcPerWeth: number };

function balancerStable(): Address {
  return BALANCER.usdcToken;
}
function assetFor(symbol: TokenSymbol): Address {
  return symbol === "WETH" ? TOKENS.WETH.address : balancerStable();
}

async function querySwapOut(
  publicClient: PublicClient,
  assetIn: Address,
  assetOut: Address,
  amount: bigint,
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: balancerQueriesAbi,
    functionName: "querySwap",
    args: [
      {
        poolId: BALANCER.poolId,
        kind: KIND_GIVEN_IN,
        assetIn,
        assetOut,
        amount,
        userData: NO_USERDATA,
      },
      {
        sender: zeroAddress,
        fromInternalBalance: false,
        recipient: zeroAddress,
        toInternalBalance: false,
      },
    ],
  });
  const result = await publicClient.call({ to: BALANCER.queries, data });
  return decodeFunctionResult({
    abi: balancerQueriesAbi,
    functionName: "querySwap",
    data: result.data ?? "0x",
  }) as bigint;
}

export async function getBalancerPrice(
  publicClient: PublicClient,
): Promise<number> {
  const out = await querySwapOut(
    publicClient,
    TOKENS.WETH.address,
    balancerStable(),
    PROBE_WETH,
  );
  return (Number(out) * 10) / 1e6;
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}
// Date.now() ベースだと evm_increaseTime で EVM time が wall clock を追い越した時に
// "Transaction too old" になる。実害のない MEV 保護用フィールドなので遠未来定数を使う。
function deadline(): bigint {
  return BigInt(2 ** 32 - 1); // ~ year 2106
}
function requireDecimalString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    throw new Error(`${name} must be a decimal integer string`);
}

function parse(obj: Record<string, unknown>): LeafAction | null {
  if (obj.type !== "balancerSwap") return null;
  if (obj.tokenIn !== "WETH" && obj.tokenIn !== "USDC")
    throw new Error("tokenIn must be WETH or USDC");
  requireDecimalString(obj.amountIn, "amountIn");
  const action: BalancerSwapAction = {
    type: "balancerSwap",
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
  if (action.type !== "balancerSwap")
    return { ok: false, reason: "not a balancer action" };
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
      : stableBalanceOf(balances, BALANCER.usdcToken);
  if (amountIn > balance)
    return { ok: false, reason: "amountIn exceeds balance" };
  return { ok: true };
}

async function buildSwapTx(
  publicClient: PublicClient,
  owner: Address,
  action: BalancerSwapAction,
): Promise<BuiltTx> {
  const amountIn = BigInt(action.amountIn);
  const slippageBps = action.slippageBps ?? 50;
  const assetIn = assetFor(action.tokenIn);
  const assetOut = assetFor(action.tokenIn === "WETH" ? "USDC" : "WETH");
  const quoted = await querySwapOut(publicClient, assetIn, assetOut, amountIn);
  const limit = applySlippage(quoted, slippageBps);
  return {
    to: BALANCER.vault,
    data: encodeFunctionData({
      abi: balancerVaultAbi,
      functionName: "swap",
      args: [
        {
          poolId: BALANCER.poolId,
          kind: KIND_GIVEN_IN,
          assetIn,
          assetOut,
          amount: amountIn,
          userData: NO_USERDATA,
        },
        {
          sender: owner,
          fromInternalBalance: false,
          recipient: owner,
          toInternalBalance: false,
        },
        limit,
        deadline(),
      ],
    }),
  };
}

// WeightedPool JoinKind.EXACT_TOKENS_IN_FOR_BPT_OUT = 1
function encodeExactTokensInJoin(amountsIn: bigint[], minBpt: bigint): Hex {
  return encodeAbiParameters(
    parseAbiParameters("uint256, uint256[], uint256"),
    [1n, amountsIn, minBpt],
  );
}

export const balancerAdapter: ProtocolAdapter = {
  id: "balancer",
  stableToken: BALANCER.usdcToken,
  parse,
  bundleable: () => true,
  validate,

  async readState(ctx): Promise<BalancerState> {
    return { priceUsdcPerWeth: await getBalancerPrice(ctx.publicClient) };
  },

  async observe(_ctx, state) {
    const s = state as BalancerState;
    return { priceUsdcPerWeth: s.priceUsdcPerWeth };
  },

  async buildTxs(ctx, owner, action): Promise<BuiltTx[]> {
    if (action.type !== "balancerSwap")
      throw new Error("balancer buildTxs: unexpected action");
    return [await buildSwapTx(ctx.publicClient, owner, action)];
  },

  async valueUsdc(): Promise<number> {
    return 0;
  },

  async setupWallet(): Promise<BuiltTx[]> {
    return [
      approveTx(TOKENS.WETH.address, BALANCER.vault),
      approveTx(balancerStable(), BALANCER.vault),
    ];
  },

  // フォーク時点で枯渇しているため admin が join して seed する
  async setupGlobal(ctx: SimContext): Promise<void> {
    // ローカルデプロイでは eris-app-deployer が既に WETH/USDC プールを seed 済み
    // (2 トークン 80/20)。poc 側の 3 トークン INIT join は不要かつ構成不一致で壊れるためスキップ。
    if (ctx.config.localDeploy) {
      return;
    }
    const admin = accountAddress(ctx.adminPk);
    // admin に seed トークンを用意（WETH は wrap、stable は deal）
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: TOKENS.WETH.address,
        data: encodeFunctionData({
          abi: wethAbi,
          functionName: "deposit",
          args: [],
        }),
        value: BALANCER.seedWethWei,
      },
    );
    await dealErc20(
      ctx.publicClient,
      BALANCER.tokens[1],
      admin,
      BALANCER.seedUsdcUnits,
    );
    await dealErc20(
      ctx.publicClient,
      BALANCER.tokens[2],
      admin,
      BALANCER.seedUsdtUnits,
    );

    for (const token of BALANCER.tokens) {
      const approve = approveTx(token, BALANCER.vault);
      await sendAndMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        ctx.adminPk,
        { to: approve.to, data: approve.data },
      );
    }

    const amountsIn = [
      BALANCER.seedWethWei,
      BALANCER.seedUsdcUnits,
      BALANCER.seedUsdtUnits,
    ];
    const userData = encodeExactTokensInJoin(amountsIn, 0n);
    const joinData = encodeFunctionData({
      abi: balancerVaultAbi,
      functionName: "joinPool",
      args: [
        BALANCER.poolId,
        admin,
        admin,
        {
          assets: BALANCER.tokens,
          maxAmountsIn: amountsIn,
          userData,
          fromInternalBalance: false,
        },
      ],
    });
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      { to: BALANCER.vault, data: joinData },
    );
  },
};

export type { BalancerState };
