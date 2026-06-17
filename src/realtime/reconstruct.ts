// run 後の per-agent 価値系列再構成（ADR 0006 §4）。
//
// 実時間ループから採点読取を消した代わりに、run 終了直後（resetFork で歴史が消える前）に
// anvil が保持する歴史ブロック state を blockNumber 指定の Multicall3 一括読取で遡り、
// 各ブロック断面の「全 agent の総価値（spot + protocol ポジション）」を再構成する。
//   - 全 agent が同一ブロック断面で読まれるため IR の点対応が濁らない
//   - スナップショット位相に同期する指標ハックが原理上不可能
// 出力は events.jsonl への observation 形イベント（inventory.valueUsdc = 総価値）。
// readPerRoundValues（evaluate / gate / discrimination）が無改修で読める。
import type { Address, PublicClient } from "viem";
import { parseAbi } from "viem";
import { erc20Abi, poolAbi } from "../abis.js";
import { AAVE, MULTICALL3, TOKENS, UNISWAP } from "../constants.js";
import type { RunLogger } from "../logger.js";
import { valueUsdc } from "../pnl.js";
import { aavePoolAbi } from "../protocols/aave.js";
import {
  gmxAccountPositionsCall,
  gmxEthUsdPositionValueUsd,
} from "../protocols/gmx.js";
import { lpPositionValueUsdc } from "../protocols/uniswap.js";
import type { ProtocolId } from "../types.js";
import { fromPriceFeedAnswer, priceFeedAbi } from "./priceFeed.js";

// anvil の歴史 state 保持深度の実測上限（~1,050。ADR 0006 Risks）。超えそうなら警告する。
const HISTORY_DEPTH_LIMIT = 1000;

const multicall3Abi = parseAbi([
  "function getEthBalance(address addr) view returns (uint256)",
]);
const npmAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);

export type ReconstructionAgent = { id: string; address: Address };

export type ReconstructionMeta = {
  source: "post-run-reconstruction";
  granularityBlocks: 1;
  fromBlock: number;
  toBlock: number;
  blocks: number;
  failedReads: number;
  elapsedMs: number;
};

type MulticallContract = {
  address: Address;
  // biome-ignore lint/suspicious/noExplicitAny: 異種 ABI を 1 つの multicall に混載する
  abi: any;
  functionName: string;
  args?: readonly unknown[];
};

export async function reconstructValueSeries(opts: {
  publicClient: PublicClient;
  logger: RunLogger;
  agents: ReconstructionAgent[];
  enabledIds: ProtocolId[];
  activeStables: Address[];
  priceFeed: Address;
  fromBlock: number;
  toBlock: number;
}): Promise<ReconstructionMeta> {
  const {
    publicClient,
    logger,
    agents,
    enabledIds,
    activeStables,
    priceFeed,
    fromBlock,
    toBlock,
  } = opts;
  const started = Date.now();
  const hasUniswap = enabledIds.includes("uniswap");
  const hasAave = enabledIds.includes("aave");
  const hasGmx = enabledIds.includes("gmx");
  let failedReads = 0;

  if (toBlock - fromBlock > HISTORY_DEPTH_LIMIT) {
    console.warn(
      `[reconstruct] run window ${toBlock - fromBlock} blocks exceeds anvil history depth ~${HISTORY_DEPTH_LIMIT}; ` +
        "古いブロックの読取が欠落する可能性があります（長 run はチャンク再構成へ切り替えること。ADR 0006 §4）",
    );
  }

  const call = async (
    contracts: MulticallContract[],
    blockNumber: bigint,
  ): Promise<unknown[]> => {
    const results = (await publicClient.multicall({
      contracts: contracts as never,
      blockNumber,
      multicallAddress: MULTICALL3,
      allowFailure: true,
    })) as Array<{ status: "success" | "failure"; result?: unknown }>;
    return results.map((r) => {
      if (r.status === "failure") {
        failedReads++;
        return undefined;
      }
      return r.result;
    });
  };

  // agent ごとの読取数（断面 multicall のインデックス計算用）
  const perAgent =
    1 + // ETH
    1 + // WETH
    activeStables.length +
    (hasAave ? 1 : 0) +
    (hasGmx ? 1 : 0) +
    (hasUniswap ? 1 : 0); // LP NFT balanceOf

  for (let b = fromBlock; b <= toBlock; b++) {
    const blockNumber = BigInt(b);
    const head: MulticallContract[] = [
      {
        address: priceFeed,
        abi: priceFeedAbi,
        functionName: "latestAnswer",
      },
    ];
    if (hasUniswap) {
      head.push({
        address: UNISWAP.poolWethUsdc500,
        abi: poolAbi,
        functionName: "slot0",
      });
    }
    const contracts: MulticallContract[] = [...head];
    for (const agent of agents) {
      contracts.push(
        {
          address: MULTICALL3,
          abi: multicall3Abi,
          functionName: "getEthBalance",
          args: [agent.address],
        },
        {
          address: TOKENS.WETH.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [agent.address],
        },
        ...activeStables.map((token) => ({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [agent.address],
        })),
      );
      if (hasAave) {
        contracts.push({
          address: AAVE.Pool,
          abi: aavePoolAbi,
          functionName: "getUserAccountData",
          args: [agent.address],
        });
      }
      if (hasGmx) contracts.push(gmxAccountPositionsCall(agent.address));
      if (hasUniswap) {
        contracts.push({
          address: UNISWAP.nonfungiblePositionManager,
          abi: npmAbi,
          functionName: "balanceOf",
          args: [agent.address],
        });
      }
    }

    const results = await call(contracts, blockNumber);
    const fairPrice = fromPriceFeedAnswer((results[0] as bigint) ?? 0n);
    const slot0 = hasUniswap
      ? (results[1] as readonly [bigint, number] | undefined)
      : undefined;
    const tick = slot0 ? Number(slot0[1]) : 0;

    // LP 列挙（第 2/3 段 multicall）: NFT を持つ agent の tokenId → positions を引く
    const lpValueByAgent = new Map<string, number>();
    if (hasUniswap) {
      const owners: Array<{ agent: ReconstructionAgent; index: bigint }> = [];
      agents.forEach((agent, i) => {
        const base = head.length + i * perAgent;
        const nftCount = (results[base + perAgent - 1] as bigint) ?? 0n;
        for (let k = 0n; k < nftCount; k++) owners.push({ agent, index: k });
      });
      if (owners.length > 0) {
        const tokenIds = await call(
          owners.map(({ agent, index }) => ({
            address: UNISWAP.nonfungiblePositionManager,
            abi: npmAbi,
            functionName: "tokenOfOwnerByIndex",
            args: [agent.address, index],
          })),
          blockNumber,
        );
        const positions = await call(
          tokenIds.map((tokenId) => ({
            address: UNISWAP.nonfungiblePositionManager,
            abi: npmAbi,
            functionName: "positions",
            args: [tokenId ?? 0n],
          })),
          blockNumber,
        );
        owners.forEach(({ agent }, j) => {
          const pos = positions[j];
          if (!pos || tokenIds[j] === undefined) return;
          const value = lpPositionValueUsdc(
            pos as Parameters<typeof lpPositionValueUsdc>[0],
            tick,
            fairPrice,
          );
          lpValueByAgent.set(
            agent.id,
            (lpValueByAgent.get(agent.id) ?? 0) + value,
          );
        });
      }
    }

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      let idx = head.length + i * perAgent;
      const ethWei = (results[idx++] as bigint) ?? 0n;
      const wethWei = (results[idx++] as bigint) ?? 0n;
      let usdcUnits = 0n;
      for (let s = 0; s < activeStables.length; s++) {
        usdcUnits += (results[idx++] as bigint) ?? 0n;
      }
      let total = valueUsdc({ ethWei, wethWei, usdcUnits }, fairPrice);
      if (hasAave) {
        const account = results[idx++] as readonly bigint[] | undefined;
        if (account) total += Number(account[0] - account[1]) / 1e8;
      }
      if (hasGmx) {
        const positions = results[idx++] as
          | Parameters<typeof gmxEthUsdPositionValueUsd>[0]
          | undefined;
        total += gmxEthUsdPositionValueUsd(positions, fairPrice);
      }
      total += lpValueByAgent.get(agent.id) ?? 0;

      // readPerRoundValues が読む observation 形（inventory.valueUsdc = 総価値）。
      // protocols は載せない（perRoundValueUsdc の二重加算を避ける）。
      logger.event({
        type: "observation",
        agentId: agent.id,
        observation: {
          reconstructed: true,
          round: b,
          blockNumber: String(b),
          fairPriceUsdcPerWeth: fairPrice,
          inventory: { valueUsdc: total },
        },
      });
    }
  }

  return {
    source: "post-run-reconstruction",
    granularityBlocks: 1,
    fromBlock,
    toBlock,
    blocks: toBlock - fromBlock + 1,
    failedReads,
    elapsedMs: Date.now() - started,
  };
}
