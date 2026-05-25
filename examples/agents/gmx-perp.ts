// gmx-perp: WETH 担保で ETH ロングを開く単純な perp エージェント。
// 観測 protocols.gmx を見てポジションが無ければ open、あれば noop。
import { createInterface } from "node:readline";

const COLLATERAL_WETH_WEI = 1_000_000_000_000_000_000n; // 1 WETH
const SIZE_USD_1E30 = 4000n * 10n ** 30n; // $4000 (≈2x)

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const gmx = obs.protocols?.gmx;
  const fee = obs.limits.defaultPriorityFeePerGasWei;
  if (!gmx) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: "gmx disabled" })}\n`,
    );
    return;
  }
  if (!gmx.position) {
    process.stdout.write(
      `${JSON.stringify({
        type: "gmxIncrease",
        isLong: true,
        collateral: "WETH",
        collateralAmount: COLLATERAL_WETH_WEI.toString(),
        sizeDeltaUsd: SIZE_USD_1E30.toString(),
        maxPriorityFeePerGasWei: fee,
      })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ type: "noop", reason: "position open" })}\n`,
  );
});
