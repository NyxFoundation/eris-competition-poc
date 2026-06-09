// フラッシュローン helper(GitHub #2)。Aave V3 Pool.flashLoanSimple の raw tx builder。
// receiver(FlashArb)が executeOperation で arb を実行し amount+premium を返済する。
import { encodeFunctionData } from "viem";
import { AAVE } from "../../src/constants.js";

export type RawTx = { to: string; data: string };

const flashAbi = [
  {
    type: "function",
    name: "flashLoanSimple",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiverAddress", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "params", type: "bytes" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
] as const;

export function buildFlashLoanSimple(
  receiver: string,
  asset: string,
  amount: bigint,
  params: `0x${string}` = "0x",
  referralCode = 0,
): RawTx {
  return {
    to: AAVE.Pool,
    data: encodeFunctionData({
      abi: flashAbi,
      functionName: "flashLoanSimple",
      args: [
        receiver as `0x${string}`,
        asset as `0x${string}`,
        amount,
        params,
        referralCode,
      ],
    }),
  };
}
