// flash-arb (GitHub #3): フラッシュローンで自己資金上限を超えるサイズの cross-venue 裁定を行う。
// uniswap(動的)と balancer(凍結参照価格)の乖離を見て、割安 venue で WETH 買い・割高 venue で
// 売る 2-leg を FlashArb コントラクト内で 1 tx 実行する。agent は方向とサイズを決め、Aave
// flashLoanSimple を rawTx で起動するだけ(FlashArb のアドレスは決定論的に計算)。
//
// 注: フラッシュローン受取コントラクト + rawTx 依存のため sandbox executor 化(LLM 自己改善)不可。
// 利益が出ない場合は返済段で revert(アトミックなので資金損失はなく、gas のみ)。
import { createInterface } from "node:readline";
import { encodeAbiParameters } from "viem";
import { TOKENS } from "../../src/constants.js";
import { FLASH_ARB_ADDRESS } from "../../src/flashArbDemo.js";
import { buildFlashLoanSimple } from "../lib/flash.js";

const agentAddress = process.env.ERIS_AGENT_ADDRESS ?? "";
const SPREAD_THRESHOLD = floatEnv("FLASH_ARB_SPREAD", 0.003); // 30 bps
const FLASH_USDC = intEnv("FLASH_ARB_USDC", 15000); // フラッシュ借入 USDC(自己資金上限超)

const paramsType = [
  {
    type: "tuple",
    components: [
      { name: "mode", type: "uint8" },
      { name: "wethMinOut", type: "uint256" },
      { name: "usdcMinOut", type: "uint256" },
      { name: "profitTo", type: "address" },
    ],
  },
] as const;

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  try {
    const obs = JSON.parse(line);
    const fee = obs.limits.defaultPriorityFeePerGasWei;
    const uni = obs.protocols?.uniswap?.pool?.priceUsdcPerWeth;
    const bal = obs.protocols?.balancer?.priceUsdcPerWeth;
    if (!(uni > 0) || !(bal > 0)) {
      out({ type: "noop", reason: "need uniswap+balancer prices" });
      return;
    }
    const spread = Math.abs(uni / bal - 1);
    if (spread < SPREAD_THRESHOLD) {
      out({ type: "noop", reason: "spread too small" });
      return;
    }
    // WETH が割安な venue で買う。uni < bal → uniswap 買い(mode 0)。else balancer 買い(mode 1)。
    const mode = uni < bal ? 0 : 1;
    const amount = BigInt(FLASH_USDC) * 1_000_000n;
    // min-out は 0(返済段で利益不足なら atomic revert。sim 内に同 tx の敵対者はいない)。
    const params = encodeAbiParameters(paramsType, [
      {
        mode,
        wethMinOut: 0n,
        usdcMinOut: 0n,
        profitTo: agentAddress as `0x${string}`,
      },
    ]);
    const tx = buildFlashLoanSimple(
      FLASH_ARB_ADDRESS,
      TOKENS.USDC.address,
      amount,
      params,
    );
    out({ type: "rawTx", tx, maxPriorityFeePerGasWei: fee });
  } catch (error) {
    out({ type: "noop", reason: `error: ${error}` });
  }
});

function out(action: unknown): void {
  process.stdout.write(`${JSON.stringify(action)}\n`);
}
function floatEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}
