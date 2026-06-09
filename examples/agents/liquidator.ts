// liquidator (GitHub #1): Aave V3 の liquidationCall で清算する bot。
// 観測には victim は含まれない原則なので、env(ERIS_LIQUIDATION_VICTIMS, カンマ区切り)で
// 監視対象アドレスを受け取り、RPC で getUserAccountData を直読みする。HF<1 の victim を見つけたら
// liquidationCall を rawTx で送る(USDC で債務を返済し WETH 担保+ボーナスを受領)。
// 受領した WETH は次ラウンドに semantic swap で USDC へ戻して PnL を確定する。
//
// 注: sandbox executor ではなく標準の標準入出力 agent。RPC を使うため LLM 自己改善対象外。
import { createInterface } from "node:readline";
import { createPublicClient, http, maxUint256, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { AAVE, TOKENS } from "../../src/constants.js";
import { VICTIM_ADDRESS } from "../../src/liquidationDemo.js";
import { buildLiquidationCall } from "../lib/aave-liquidation.js";

const rpcUrl = process.env.ERIS_RPC_URL ?? "";
if (!rpcUrl) {
  process.stderr.write("ERIS_RPC_URL is required\n");
  process.exit(1);
}
const victims = (process.env.ERIS_LIQUIDATION_VICTIMS ?? VICTIM_ADDRESS)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const pc = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
const poolAbi = parseAbi([
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
]);

const HF_ONE = 10n ** 18n;
// 清算で受領した WETH を判別するための下限(初期残高に紛れない程度)。初期 10 WETH より十分大きく
// した上で「増えた分」を売るのは難しいため、ここでは閾値超の WETH を一定サイズで USDC 化する。
const WETH_REALIZE_THRESHOLD_WEI = 10_500_000_000_000_000_000n; // 10.5 WETH

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  try {
    const obs = JSON.parse(line);
    const fee = obs.limits.defaultPriorityFeePerGasWei;

    // 1) HF<1 の victim があれば清算(USDC で返済 → WETH 担保受領)
    for (const victim of victims) {
      const acc = (await pc.readContract({
        address: AAVE.Pool,
        abi: poolAbi,
        functionName: "getUserAccountData",
        args: [victim as `0x${string}`],
      })) as readonly bigint[];
      const totalDebt = acc[1];
      const hf = acc[5];
      if (totalDebt > 0n && hf < HF_ONE) {
        const tx = buildLiquidationCall(
          TOKENS.WETH.address,
          TOKENS.USDC.address,
          victim,
          maxUint256, // close factor で上限クランプ
          false,
        );
        process.stdout.write(
          `${JSON.stringify({ type: "rawTx", tx, maxPriorityFeePerGasWei: fee })}\n`,
        );
        return;
      }
    }

    // 2) 清算で増えた WETH を USDC に戻して確定(初期 WETH を超えた分の目安で売る)
    const wethWei = BigInt(obs.balances.wethWei);
    if (wethWei > WETH_REALIZE_THRESHOLD_WEI) {
      const maxIn = BigInt(obs.limits.maxWethInWei);
      const excess = wethWei - 10_000_000_000_000_000_000n; // 初期 10 WETH 超過分
      const amountIn = excess < maxIn ? excess : maxIn;
      if (amountIn > 0n) {
        process.stdout.write(
          `${JSON.stringify({ type: "swap", tokenIn: "WETH", amountIn: amountIn.toString(), slippageBps: 100, maxPriorityFeePerGasWei: fee })}\n`,
        );
        return;
      }
    }

    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: "no liquidatable victim" })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: `error: ${error}` })}\n`,
    );
  }
});
