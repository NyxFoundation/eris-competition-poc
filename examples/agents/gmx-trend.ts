// gmx-trend: history の fairPriceUsdcPerWeth(=GMX market 価格の駆動源) の傾きで
// 上昇/下降トレンドを判定し、順張りで GMX perp を open する。トレンド反転で close。
// 既存 gmx-perp.ts はロングを開くだけだが、本戦略は long/short 両建てと gmxDecrease による
// クローズまで行う。
//
// env:
//   TREND_LOOKBACK  トレンド判定に使う直近 history 件数 (default 8)
//   TREND_BPS       open する最小トレンド乖離 (bps, default 30)
import { createInterface } from "node:readline";

const LOOKBACK = Math.max(4, Number(process.env.TREND_LOOKBACK ?? "8"));
const TREND_BPS = Number(process.env.TREND_BPS ?? "30");
const SIZE_1E30 = 10n ** 30n;
const LEVERAGE = 2; // collateral 1 WETH に対する目標レバレッジ

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const gmx = obs.protocols?.gmx;
  const fee = obs.limits.defaultPriorityFeePerGasWei;
  if (!gmx) {
    out({ type: "noop", reason: "gmx disabled" });
    return;
  }

  // --- トレンド算出: 直近 LOOKBACK 件を前半/後半に割り、平均価格の変化率を見る ---
  const hist = (obs.history ?? [])
    .map((h: { fairPriceUsdcPerWeth: number }) => h.fairPriceUsdcPerWeth)
    .filter((p: number) => Number.isFinite(p) && p > 0);
  if (hist.length < LOOKBACK) {
    out({ type: "noop", reason: "warming up" });
    return;
  }
  const win = hist.slice(-LOOKBACK);
  const half = Math.floor(LOOKBACK / 2);
  const olderAvg = avg(win.slice(0, half));
  const recentAvg = avg(win.slice(half));
  const trend = recentAvg / olderAvg - 1; // >0 上昇 / <0 下降
  const upTrend = trend > 0;

  const pos = gmx.position;
  if (pos) {
    // 保有方向とトレンドが逆転したらフルクローズ
    const reversed = pos.isLong !== upTrend;
    if (reversed && Math.abs(trend) > TREND_BPS / 10_000) {
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
    out({ type: "noop", reason: "hold (trend intact)" });
    return;
  }

  // ポジション無し: トレンドが閾値を超えたら順張りで open
  if (Math.abs(trend) < TREND_BPS / 10_000) {
    out({ type: "noop", reason: "no trend" });
    return;
  }
  const marketPrice = gmx.marketPriceUsd;
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
    out({ type: "noop", reason: "invalid gmx price" });
    return;
  }
  const collateralWethWei = 1_000_000_000_000_000_000n; // 1 WETH
  const collateralUsd = marketPrice; // 1 WETH の USD 価値
  let sizeUsd = clampSizeUsd(
    collateralUsd * LEVERAGE,
    obs.limits.maxGmxSizeUsd,
  );
  out({
    type: "gmxIncrease",
    isLong: upTrend,
    collateral: "WETH",
    collateralAmount: collateralWethWei.toString(),
    sizeDeltaUsd: sizeUsd.toString(),
    maxPriorityFeePerGasWei: fee,
  });
});

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// USD(float) を GMX 1e30 スケールに変換し、maxGmxSizeUsd(1e30) で上限クランプ
function clampSizeUsd(usd: number, maxStr: string): bigint {
  const size = BigInt(Math.max(0, Math.round(usd))) * SIZE_1E30;
  const max = BigInt(maxStr);
  return size > max ? max : size;
}

function out(action: unknown): void {
  process.stdout.write(`${JSON.stringify(action)}\n`);
}
