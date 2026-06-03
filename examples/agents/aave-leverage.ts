// aave-leverage: WETH を supply して USDC を borrow する単純なレバレッジ系エージェント。
// 観測 protocols.aave を見て段階的に supply -> borrow -> noop。
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const aave = obs.protocols?.aave;
  if (!aave) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: "aave disabled" })}\n`,
    );
    return;
  }
  const suppliedWeth = BigInt(aave.supplied?.WETH ?? "0");
  const borrowedUsdc = BigInt(aave.borrowed?.USDC ?? "0");
  const wethWei = BigInt(obs.balances.wethWei);
  const fee = obs.limits.defaultPriorityFeePerGasWei;

  // 1) まだ担保が無ければ WETH を supply
  if (suppliedWeth === 0n && wethWei > 0n) {
    const maxSupply = BigInt(obs.limits.maxAaveSupplyWethWei);
    const amount = min(wethWei / 2n, maxSupply);
    if (amount > 0n) {
      process.stdout.write(
        `${JSON.stringify({ type: "aaveSupply", asset: "WETH", amount: amount.toString(), maxPriorityFeePerGasWei: fee })}\n`,
      );
      return;
    }
  }

  // 2) 担保があり借入が無ければ USDC を borrow
  if (suppliedWeth > 0n && borrowedUsdc === 0n) {
    const maxBorrow = BigInt(obs.limits.maxAaveBorrowUsdcUnits);
    const amount = min(1_000_000_000n, maxBorrow); // 1000 USDC
    process.stdout.write(
      `${JSON.stringify({ type: "aaveBorrow", asset: "USDC", amount: amount.toString(), maxPriorityFeePerGasWei: fee })}\n`,
    );
    return;
  }

  process.stdout.write(
    `${JSON.stringify({ type: "noop", reason: "position established" })}\n`,
  );
});

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
