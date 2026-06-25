/**
 * multi-arb: base 非依存の cross-venue 裁定 agent（ADR 0013）。
 *
 * 全 active base（WETH / WBTC / …）× 全 AMM venue（uniswap / balancer / curve）を横断し、毎ラウンド:
 *   1) 2-leg delta-neutral 裁定を優先 — ある base で venue 間スプレッド（最安 venue と最高 venue の
 *      価格差）が閾値超なら、最安 venue で USDC→base 買い + 最高 venue で base→USDC 売りを 1 bundle で
 *      出す。買い leg の出力 base を売り leg が使う（action.ts が bundle 内で base をクレジットする）。
 *      方向 β を持たず venue 間スプレッド（α）だけを抜く。
 *   2) 2-leg 機会が無ければ single-leg にフォールバック — fair から最も乖離した (base, venue) で価格を
 *      fair に寄せる向きに 1 swap（USDC-only 起動でも buy 側で base を建てられる）。
 *
 * 個別資産ごとに別 agent を書くのではなく、observation の market view を一様に走査して任意の資産集合へ
 * 自動対応する（複数資産対応の設計）。base!=="WETH" のときだけ action に base を付与（WETH は base 無し
 * = 従来出力と byte 互換）。
 */
import { createInterface } from "node:readline";
import { marketViews, type MarketView } from "./lib/markets.js";

const SPREAD_THRESHOLD = 0.002; // venue 間スプレッド 20bps 未満は 2-leg を見送り
const GAP_THRESHOLD = 0.001; // single-leg: fair gap 10bps 未満は見送り
const MIN_SIZE_BPS = 250;
const MAX_SIZE_BPS = 2500;
const SPREAD_GAIN = 200_000; // spread → サイズの線形ゲイン
const GAP_GAIN = 200_000;
const LEG_SLIPPAGE_BPS = 120; // 2-leg は cross-venue 移動を見込みやや緩め
const SINGLE_SLIPPAGE_BPS = 75;

function minBI(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

// base 量(base units) を decimals で割って数値化（USD 換算用。概算で十分）。
function baseToFloat(amountBaseWei: bigint, decimals: number): number {
  return Number(amountBaseWei) / 10 ** decimals;
}
function floatToBase(amount: number, decimals: number): bigint {
  return BigInt(Math.max(0, Math.floor(amount * 10 ** decimals)));
}

type TwoLeg = {
  base: string;
  spread: number;
  cheap: MarketView["venues"][number];
  rich: MarketView["venues"][number];
  usdcIn: bigint;
  baseSell: bigint;
};

type SingleLeg = {
  base: string;
  venue: MarketView["venues"][number];
  gapAbs: number;
  tokenIn: string;
  amountIn: bigint;
};

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const views = marketViews(obs);
  const usdcBal = BigInt(obs.balances.usdcUnits || "0");
  const maxUsdc = BigInt(obs.limits.maxUsdcInUnits);
  const maxWeth = BigInt(obs.limits.maxWethInWei);
  const fee = obs.limits.defaultPriorityFeePerGasWei;

  // ---- 1) 2-leg cross-venue 裁定（venue 間スプレッド最大の base を選ぶ）----
  let bestTwo: TwoLeg | null = null;
  for (const view of views) {
    if (view.venues.length < 2) continue;
    let cheap = view.venues[0];
    let rich = view.venues[0];
    for (const v of view.venues) {
      if (v.price < cheap.price) cheap = v;
      if (v.price > rich.price) rich = v;
    }
    if (cheap.price <= 0 || rich.price <= 0) continue;
    const spread = rich.price / cheap.price - 1;
    if (spread < SPREAD_THRESHOLD) continue;
    // 買い leg の USDC サイズ（spread に比例、USDC 残高/上限で頭打ち）。
    const usdcCap = minBI(usdcBal, maxUsdc);
    if (usdcCap <= 0n) continue;
    const sizeBps = Math.min(
      MAX_SIZE_BPS,
      Math.max(MIN_SIZE_BPS, Math.floor(spread * SPREAD_GAIN)),
    );
    const usdcIn = (usdcCap * BigInt(sizeBps)) / 10000n;
    if (usdcIn <= 0n) continue;
    // 買い出力 base 概算 = (USDCin / cheapPrice)。売り leg はその 98%（floor/slippage マージン）。
    const boughtBase = baseToFloat(usdcIn, 6) / cheap.price;
    let baseSell = floatToBase(boughtBase * 0.98, view.baseDecimals);
    // per-base 上限（"0"=上限なし）で頭打ち。
    const maxBaseIn = BigInt(view.maxSwapInBaseWei || "0");
    if (maxBaseIn > 0n) baseSell = minBI(baseSell, maxBaseIn);
    if (baseSell <= 0n) continue;
    if (!bestTwo || spread > bestTwo.spread)
      bestTwo = { base: view.base, spread, cheap, rich, usdcIn, baseSell };
  }

  if (bestTwo) {
    const withBase = (a: Record<string, unknown>): Record<string, unknown> =>
      bestTwo!.base === "WETH" ? a : { ...a, base: bestTwo!.base };
    const bundle = {
      type: "bundle",
      actions: [
        withBase({
          type: bestTwo.cheap.swapType,
          tokenIn: "USDC",
          amountIn: bestTwo.usdcIn.toString(),
          slippageBps: LEG_SLIPPAGE_BPS,
        }),
        withBase({
          type: bestTwo.rich.swapType,
          tokenIn: bestTwo.base,
          amountIn: bestTwo.baseSell.toString(),
          slippageBps: LEG_SLIPPAGE_BPS,
        }),
      ],
      maxPriorityFeePerGasWei: fee,
    };
    process.stdout.write(`${JSON.stringify(bundle)}\n`);
    return;
  }

  // ---- 2) single-leg フォールバック（fair から最も乖離した (base, venue) を fair へ寄せる）----
  let bestOne: SingleLeg | null = null;
  for (const view of views) {
    for (const venue of view.venues) {
      const gap = view.fair / venue.price - 1;
      const gapAbs = Math.abs(gap);
      if (gapAbs < GAP_THRESHOLD) continue;
      const buyBase = gap > 0;
      const tokenIn = buyBase ? "USDC" : view.base;
      let cap: bigint;
      if (buyBase) {
        cap = minBI(usdcBal, maxUsdc);
      } else {
        const baseBal = BigInt(view.baseBalanceWei || "0");
        const maxBaseIn = BigInt(view.maxSwapInBaseWei || "0");
        cap = view.base === "WETH" ? minBI(baseBal, maxWeth) : baseBal;
        if (maxBaseIn > 0n) cap = minBI(cap, maxBaseIn);
      }
      if (cap <= 0n) continue;
      const sizeBps = Math.min(
        MAX_SIZE_BPS,
        Math.max(MIN_SIZE_BPS, Math.floor(gapAbs * GAP_GAIN)),
      );
      const amountIn = (cap * BigInt(sizeBps)) / 10000n;
      if (amountIn <= 0n) continue;
      if (!bestOne || gapAbs > bestOne.gapAbs)
        bestOne = { base: view.base, venue, gapAbs, tokenIn, amountIn };
    }
  }

  if (!bestOne) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: "no funded venue gap" })}\n`,
    );
    return;
  }
  const action: Record<string, unknown> = {
    type: bestOne.venue.swapType,
    tokenIn: bestOne.tokenIn,
    amountIn: bestOne.amountIn.toString(),
    maxPriorityFeePerGasWei: fee,
    slippageBps: SINGLE_SLIPPAGE_BPS,
  };
  if (bestOne.base !== "WETH") action.base = bestOne.base;
  process.stdout.write(`${JSON.stringify(action)}\n`);
});
