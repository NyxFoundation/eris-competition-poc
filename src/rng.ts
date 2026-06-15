export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  int(minInclusive: number, maxExclusive: number): number {
    return (
      Math.floor(this.next() * (maxExclusive - minInclusive)) + minInclusive
    );
  }

  bool(): boolean {
    return this.next() >= 0.5;
  }
}

function floatEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// 価格モデル（ADR 0003 識別力。sim-loop 課題: 方向 β の除去）。
// 旧モデルはドリフト付き幾何ランダムウォーク → seed ごとにトレンドが付き、その累積方向
// エクスポージャ(β)が PnL を支配して「でたらめ売買 ≒ 賢い裁定」になり優劣が出なかった。
// 平均回帰(OU 型)にして anchor へ引き戻すと、run 終了時の価格が始点付近に戻る → 方向で
// 儲からなくなり、pool と fair の乖離(gap)を当てる裁定スキル(α)だけが残る。env で調整可。
const PRICE_VOLATILITY = floatEnv(process.env.ERIS_PRICE_VOLATILITY, 0.004);
const PRICE_REVERT_KAPPA = floatEnv(process.env.ERIS_PRICE_REVERT_KAPPA, 0.02);
const PRICE_DRIFT = floatEnv(process.env.ERIS_PRICE_DRIFT, 0);

// anchor は run の基準価格(通常は初期 pool 価格)。current が anchor から離れるほど強く戻す。
export function nextFairPrice(
  current: number,
  rng: Rng,
  anchor: number,
): number {
  const shock = (rng.next() - 0.5) * 2 * PRICE_VOLATILITY;
  const revert = (PRICE_REVERT_KAPPA * (anchor - current)) / current;
  return Math.max(100, current * (1 + PRICE_DRIFT + revert + shock));
}
