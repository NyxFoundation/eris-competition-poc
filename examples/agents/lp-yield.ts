// lp-yield (GitHub #11): fair 含意 tick 中心に LP を mint し、残った遊休 USDC を Aave V3 に supply
// して「手数料 + 利回り」の二段収益を狙う無レバレッジ複合(fair-MM × Aave park)。
// LP コンポーネントは fair-mm を簡約移植、park は aave-arb 流。RPC 不要・semantic action のみ。
//
// env:
//   LP_YIELD_RANGE_SPACINGS  レンジ半幅(tickSpacing 単位, default 4)
//   LP_YIELD_DEPOSIT_FRAC    LP 預入率(default 0.5)
//   LP_YIELD_MIN_IDLE_USDC   Aave に回さず手元に残す USDC 下限(default 10)
import { createInterface } from "node:readline";

const RANGE_SPACINGS = intEnv("LP_YIELD_RANGE_SPACINGS", 4);
const DEPOSIT_FRAC = floatEnv("LP_YIELD_DEPOSIT_FRAC", 0.5);
const MIN_IDLE_USDC = intEnv("LP_YIELD_MIN_IDLE_USDC", 10);
const SLIPPAGE_BPS = 75;

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  try {
    const obs = JSON.parse(line);
    const uni = obs.protocols?.uniswap;
    const aave = obs.protocols?.aave;
    const fee = obs.limits.defaultPriorityFeePerGasWei;
    if (!uni?.pool) {
      out({ type: "noop", reason: "uniswap disabled" });
      return;
    }
    const positions = uni.positions ?? [];
    const live = positions.filter(
      (p: { liquidity: string }) => BigInt(p.liquidity) > 0n,
    ).length;

    // 1) LP 未保有 → fair 含意 tick 中心に mint
    if (live === 0) {
      const pool = uni.pool.priceUsdcPerWeth;
      const fair = obs.fairPriceUsdcPerWeth;
      if (pool > 0 && fair > 0) {
        const spacing = uni.pool.tickSpacing;
        const offset = Math.round(Math.log(fair / pool) / Math.log(1.0001));
        const center = Math.round((uni.pool.tick + offset) / spacing) * spacing;
        const w = Math.max(1, RANGE_SPACINGS) * spacing;
        const frac = BigInt(Math.floor(DEPOSIT_FRAC * 10_000));
        const wethWei = BigInt(obs.balances.wethWei);
        const usdcUnits = BigInt(obs.balances.usdcUnits);
        const maxW = BigInt(obs.limits.maxLpWethWei);
        const maxU = BigInt(obs.limits.maxLpUsdcUnits);
        const wd = ((wethWei < maxW ? wethWei : maxW) * frac) / 10_000n;
        const ud = ((usdcUnits < maxU ? usdcUnits : maxU) * frac) / 10_000n;
        if (wd > 0n || ud > 0n) {
          out({
            type: "mintLiquidity",
            tickLower: center - w,
            tickUpper: center + w,
            amountWethDesired: wd.toString(),
            amountUsdcDesired: ud.toString(),
            maxPriorityFeePerGasWei: fee,
            slippageBps: SLIPPAGE_BPS,
          });
          return;
        }
      }
    }

    // 2) LP 配分後の遊休 USDC を Aave に park(余剰だけ)。1 回の supply は maxUsdcInUnits で
    //    上限を切り、集約残高(USDC.e/USDT 込み)で native USDC 残高を超えて reject されるのを避ける。
    if (aave) {
      const usdcUnits = BigInt(obs.balances.usdcUnits);
      const maxIn = BigInt(obs.limits.maxUsdcInUnits);
      const minIdle = BigInt(MIN_IDLE_USDC) * 1_000_000n;
      if (usdcUnits > minIdle) {
        const excess = usdcUnits - minIdle;
        const amt = excess < maxIn ? excess : maxIn;
        out({
          type: "aaveSupply",
          asset: "USDC",
          amount: amt.toString(),
          maxPriorityFeePerGasWei: fee,
        });
        return;
      }
    }
    out({ type: "noop", reason: "LP + idle parked" });
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
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}
