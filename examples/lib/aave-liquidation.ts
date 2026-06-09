// Aave V3 liquidationCall の raw tx builder(GitHub #1)。
// Pool/トークンは src/constants.ts(Arbitrum)を参照。
import { encodeFunctionData } from "viem";
import { AAVE } from "../../src/constants.js";

export type RawTx = { to: string; data: string };

const liquidationAbi = [
  {
    type: "function",
    name: "liquidationCall",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralAsset", type: "address" },
      { name: "debtAsset", type: "address" },
      { name: "user", type: "address" },
      { name: "debtToCover", type: "uint256" },
      { name: "receiveAToken", type: "bool" },
    ],
    outputs: [],
  },
] as const;

/**
 * liquidationCall を 1 tx 分組み立てる。
 * debtToCover に uint256.max を渡すと Aave 側が close factor(最大 50% など)で上限クランプする。
 * receiveAToken=false で原資産(WETH)を受け取り、別途 swap で USDC 化できる。
 */
export function buildLiquidationCall(
  collateralAsset: string,
  debtAsset: string,
  user: string,
  debtToCover: bigint,
  receiveAToken = false,
): RawTx {
  return {
    to: AAVE.Pool,
    data: encodeFunctionData({
      abi: liquidationAbi,
      functionName: "liquidationCall",
      args: [
        collateralAsset as `0x${string}`,
        debtAsset as `0x${string}`,
        user as `0x${string}`,
        debtToCover,
        receiveAToken,
      ],
    }),
  };
}
