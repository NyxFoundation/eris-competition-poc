// gmx-reversion: history の fairPriceUsdcPerWeth の移動平均(MA)からの乖離を見て、
// 価格が MA より高ければ short(下落に賭ける)、低ければ long(上昇に賭ける) を open。
// 価格が MA 近傍に戻ったら、または含み損が STOP を超えたら gmxDecrease でクローズ。
//
// 注記(PnL ドライバ): GMX の損益は marketPriceUsd(=オラクル=fair) の動きで実現される。
// 本戦略は「fair 価格が MA に回帰する」ことに賭ける perp 戦略であり、AMM プール価格その
// ものの裁定ではない。
//
// env:
//   MA_LOOKBACK  移動平均に使う直近 history 件数 (default 12)
//   ENTRY_BPS    open する最小乖離 (bps, default 40)
//   EXIT_BPS     close する MA 近傍判定 (bps, default 10)
//   STOP_USD     強制クローズする含み損のしきい値 (USD, default 150)
import { createInterface } from "node:readline";

const MA_LOOKBACK = Math.max(2, Number(process.env.MA_LOOKBACK ?? "12"));
const ENTRY_BPS = Number(process.env.ENTRY_BPS ?? "40");
const EXIT_BPS = Number(process.env.EXIT_BPS ?? "10");
const STOP_USD = Number(process.env.STOP_USD ?? "150");
const SIZE_1E30 = 10n ** 30n;
const LEVERAGE = 2;

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const gmx = obs.protocols?.gmx;
  const fee = obs.limits.defaultPriorityFeePerGasWei;
  if (!gmx) {
    out({ type: "noop", reason: "gmx disabled" });
    return;
  }

  const hist = (obs.history ?? [])
    .map((h: { fairPriceUsdcPerWeth: number }) => h.fairPriceUsdcPerWeth)
    .filter((p: number) => Number.isFinite(p) && p > 0);
  if (hist.length < MA_LOOKBACK) {
    out({ type: "noop", reason: "warming up" });
    return;
  }
  const ma = avg(hist.slice(-MA_LOOKBACK));
  const price = obs.fairPriceUsdcPerWeth;
  if (!Number.isFinite(price) || price <= 0 || ma <= 0) {
    out({ type: "noop", reason: "invalid prices" });
    return;
  }
  const dev = price / ma - 1; // >0 割高 / <0 割安

  const pos = gmx.position;
  if (pos) {
    const pnl = Number(pos.pnlUsd ?? 0);
    const reverted = Math.abs(dev) < EXIT_BPS / 10_000;
    const stopped = pnl < -STOP_USD;
    if (reverted || stopped) {
      out({
        type: "gmxDecrease",
        isLong: pos.isLong,
        collateral: pos.collateral,
        collateralDeltaAmount: pos.collateralAmount,
        sizeDeltaUsd: pos.sizeUsd,
        maxPriorityFeePerGasWei: fee,
      });
      return;
    }
    out({ type: "noop", reason: "hold (awaiting reversion)" });
    return;
  }

  // ポジション無し: 乖離が閾値を超えたら逆張りで open(割高→short / 割安→long)
  if (Math.abs(dev) < ENTRY_BPS / 10_000) {
    out({ type: "noop", reason: "near MA" });
    return;
  }
  const isLong = dev < 0; // 割安なら long
  const marketPrice = gmx.marketPriceUsd;
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
    out({ type: "noop", reason: "invalid gmx price" });
    return;
  }
  const collateralWethWei = 1_000_000_000_000_000_000n; // 1 WETH
  const sizeUsd = clampSizeUsd(
    marketPrice * LEVERAGE,
    obs.limits.maxGmxSizeUsd,
  );
  out({
    type: "gmxIncrease",
    isLong,
    collateral: "WETH",
    collateralAmount: collateralWethWei.toString(),
    sizeDeltaUsd: sizeUsd.toString(),
    maxPriorityFeePerGasWei: fee,
  });
});

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function clampSizeUsd(usd: number, maxStr: string): bigint {
  const size = BigInt(Math.max(0, Math.round(usd))) * SIZE_1E30;
  const max = BigInt(maxStr);
  return size > max ? max : size;
}

function out(action: unknown): void {
  process.stdout.write(`${JSON.stringify(action)}\n`);
}
