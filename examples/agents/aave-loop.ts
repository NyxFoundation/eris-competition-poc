// aave-loop (GitHub #6): Aave V3 の supply/borrow を多段ループする leveraged WETH carry。
// WETH supply → USDC borrow → USDC を WETH に swap → 再 supply を繰り返し targetLtv まで建てる。
// 各ラウンド obs.protocols.aave の collateral/debt/availableBorrows から状態を再構成する素朴版
// (aave-leverage.ts の発展)。RPC 不要・semantic action のみ。
//
// env:
//   AAVE_LOOP_TARGET_LTV       目標 LTV(default 0.7)
//   AAVE_LOOP_BORROW_FRACTION  availableBorrows の borrow 比率(default 0.8)
//   AAVE_LOOP_SLIPPAGE_BPS     swap slippage(default 75)
import { createInterface } from "node:readline";

const TARGET_LTV = floatEnv("AAVE_LOOP_TARGET_LTV", 0.7);
const BORROW_FRACTION = floatEnv("AAVE_LOOP_BORROW_FRACTION", 0.8);
const SLIPPAGE_BPS = intEnv("AAVE_LOOP_SLIPPAGE_BPS", 75);

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  try {
    const obs = JSON.parse(line);
    const aave = obs.protocols?.aave;
    const fee = obs.limits.defaultPriorityFeePerGasWei;
    if (!aave) {
      out({ type: "noop", reason: "aave disabled" });
      return;
    }
    const wethWei = BigInt(obs.balances.wethWei);
    const usdcUnits = BigInt(obs.balances.usdcUnits);
    const maxIn = BigInt(obs.limits.maxUsdcInUnits);
    const coll = Number(aave.totalCollateralBase) / 1e8;
    const debt = Number(aave.totalDebtBase) / 1e8;
    const avail = Number(aave.availableBorrowsBase) / 1e8;
    const underTarget = coll === 0 || debt / coll < TARGET_LTV;

    // 1) 手元 WETH を supply して担保を積む(初期 WETH + swap で得た WETH。carry の土台)
    if (wethWei > 0n && underTarget) {
      const maxSupply = BigInt(obs.limits.maxAaveSupplyWethWei);
      const amt = wethWei < maxSupply ? wethWei : maxSupply;
      if (amt > 0n) {
        out({
          type: "aaveSupply",
          asset: "WETH",
          amount: amt.toString(),
          maxPriorityFeePerGasWei: fee,
        });
        return;
      }
    }
    // 2) 目標 LTV 未満で借入余力があれば USDC borrow
    if (underTarget && coll > 0) {
      const borrowUsd = Math.floor(avail * BORROW_FRACTION);
      if (borrowUsd >= 10) {
        const maxBorrow = BigInt(obs.limits.maxAaveBorrowUsdcUnits);
        const want = BigInt(borrowUsd) * 1_000_000n;
        const amt = want < maxBorrow ? want : maxBorrow;
        if (amt > 0n) {
          out({
            type: "aaveBorrow",
            asset: "USDC",
            amount: amt.toString(),
            maxPriorityFeePerGasWei: fee,
          });
          return;
        }
      }
    }
    // 3) 借りた native USDC を WETH へ swap(maxUsdcInUnits で上限。native 残高超過 reject を回避)
    if (underTarget && coll > 0 && usdcUnits > 1_000_000n) {
      const amountIn = usdcUnits < maxIn ? usdcUnits : maxIn;
      out({
        type: "swap",
        tokenIn: "USDC",
        amountIn: amountIn.toString(),
        slippageBps: SLIPPAGE_BPS,
        maxPriorityFeePerGasWei: fee,
      });
      return;
    }
    out({ type: "noop", reason: "target leverage reached" });
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
