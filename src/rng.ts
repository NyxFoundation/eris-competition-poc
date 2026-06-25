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

// 1 asset ぶんの OU パラメータ（ADR 0013）。
export type OuParams = { volatility: number; kappa: number; drift: number };

// グローバル既定（後方互換: 旧 nextFairPrice と同一挙動）。
export function globalOuParams(): OuParams {
  return {
    volatility: PRICE_VOLATILITY,
    kappa: PRICE_REVERT_KAPPA,
    drift: PRICE_DRIFT,
  };
}

// per-asset の OU パラメータ。env suffix（例 ERIS_PRICE_VOLATILITY_WBTC）で個別指定し、
// 無指定はグローバル値にフォールバック。symbol 単位で vol/kappa/drift を分けられる。
export function ouParamsForSymbol(symbol: string): OuParams {
  const sfx = symbol.toUpperCase();
  return {
    volatility: floatEnv(
      process.env[`ERIS_PRICE_VOLATILITY_${sfx}`],
      PRICE_VOLATILITY,
    ),
    kappa: floatEnv(
      process.env[`ERIS_PRICE_REVERT_KAPPA_${sfx}`],
      PRICE_REVERT_KAPPA,
    ),
    drift: floatEnv(process.env[`ERIS_PRICE_DRIFT_${sfx}`], PRICE_DRIFT),
  };
}

// anchor は run の基準価格(通常は初期 pool 価格)。current が anchor から離れるほど強く戻す。
// params 省略時はグローバル既定（旧挙動と byte 一致）。
export function nextFairPrice(
  current: number,
  rng: Rng,
  anchor: number,
  params?: OuParams,
): number {
  const p = params ?? globalOuParams();
  const shock = (rng.next() - 0.5) * 2 * p.volatility;
  const revert = (p.kappa * (anchor - current)) / current;
  return Math.max(100, current * (1 + p.drift + revert + shock));
}

// asset ごとの価格 RNG を分離する salt（ADR 0013）。WETH は salt 0 = Rng(seed) そのもの
// （既存 run の WETH 価格パスと byte 一致）。他 base は symbol 由来の決定論 salt で独立パスを得る。
// 各 asset 独立 Rng = 資産間相関 0（v1）。相関を入れるなら共通 Rng へ寄せるが、それは WETH の
// 消費列を変える（後方互換を壊す）ため既定では行わない。
function assetPriceSalt(symbol: string): number {
  if (symbol === "WETH") return 0;
  let h = 0x9e_37_79_b9;
  for (let i = 0; i < symbol.length; i++) {
    h = (Math.imul(h ^ symbol.charCodeAt(i), 0x01_00_01_93) >>> 0) >>> 0;
  }
  return h >>> 0;
}

// base シンボルの価格専用 Rng。WETH は Rng(seed)（従来同一）。他 base は派生 seed で独立。
export function priceRngForAsset(seed: number, symbol: string): Rng {
  return new Rng((seed ^ assetPriceSalt(symbol)) >>> 0);
}

export type MultiAssetPriceState = Record<string, number>;

// 複数 base の OU を asset ごとの独立 Rng で進める（ADR 0013）。order は登録順（WETH 先頭）で
// 出力の決定性を保つだけ。各 asset は独立 Rng なので、base を増やしても WETH の価格パスは不変。
export function nextFairPrices(
  current: MultiAssetPriceState,
  rngBy: Record<string, Rng>,
  anchors: MultiAssetPriceState,
  order: string[],
  paramsBy?: Record<string, OuParams>,
): MultiAssetPriceState {
  const out: MultiAssetPriceState = {};
  for (const sym of order) {
    out[sym] = nextFairPrice(
      current[sym],
      rngBy[sym],
      anchors[sym],
      paramsBy?.[sym] ?? ouParamsForSymbol(sym),
    );
  }
  return out;
}
