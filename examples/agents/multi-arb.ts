/**
 * multi-arb: base 非依存の cross-venue 裁定 agent（ADR 0013）。
 *
 * 全 active base（WETH / WBTC / …）× 全 AMM venue（uniswap / balancer / curve）を横断し、
 * fair price から最も乖離した (base, venue) を 1 つ選び、価格を fair に寄せる向きに swap する。
 * 個別資産ごとに別 agent を書くのではなく、observation の market view を一様に走査して任意の
 * 資産集合へ自動対応する（複数資産対応の設計）。
 *
 * - gap>0（base が venue で割安） → USDC で base を買う（tokenIn=USDC、価格を押し上げる）
 * - gap<0（base が venue で割高） → base を売る（tokenIn=base、価格を押し下げる）
 * USDC-only 起動でも buy 側で base を建てられる。base!=="WETH" のときだけ action に base を付与
 * （WETH 経路は従来どおり base 無しで byte 互換）。
 */
import { createInterface } from "node:readline";
import {
  marketViews,
  type AgentVenue,
  type MarketView,
} from "./lib/markets.js";

const GAP_THRESHOLD = 0.001; // |gap| 10 bps 未満は見送り
const MIN_SIZE_BPS = 250;
const MAX_SIZE_BPS = 2500;
const SIZE_GAIN = 200_000; // gap → サイズの線形ゲイン（simple-rule と同じ感度）
const SLIPPAGE_BPS = 75;

type Candidate = {
  view: MarketView;
  venue: AgentVenue;
  gap: number;
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

  let best: Candidate | null = null;
  for (const view of views) {
    for (const venue of view.venues) {
      const gap = view.fair / venue.price - 1;
      const gapAbs = Math.abs(gap);
      if (gapAbs < GAP_THRESHOLD) continue;
      const buyBase = gap > 0;
      const tokenIn = buyBase ? "USDC" : view.base;
      // executable cap: 買いは USDC 残高（WETH の per-round 上限 maxUsdc を併用）、
      // 売りは base 在庫（WETH のみ per-round 上限 maxWeth を併用。他 base は balance bound = Phase 8）。
      let cap: bigint;
      if (buyBase) {
        cap = usdcBal < maxUsdc ? usdcBal : maxUsdc;
      } else {
        const baseBal = BigInt(view.baseBalanceWei || "0");
        cap = view.base === "WETH" && baseBal > maxWeth ? maxWeth : baseBal;
      }
      if (cap <= 0n) continue;
      const sizeBps = Math.min(
        MAX_SIZE_BPS,
        Math.max(MIN_SIZE_BPS, Math.floor(gapAbs * SIZE_GAIN)),
      );
      const amountIn = (cap * BigInt(sizeBps)) / 10000n;
      if (amountIn <= 0n) continue;
      if (!best || gapAbs > best.gapAbs)
        best = { view, venue, gap, gapAbs, tokenIn, amountIn };
    }
  }

  if (!best) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: "no funded venue gap" })}\n`,
    );
    return;
  }

  const action: Record<string, unknown> = {
    type: best.venue.swapType,
    tokenIn: best.tokenIn,
    amountIn: best.amountIn.toString(),
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
    slippageBps: SLIPPAGE_BPS,
  };
  // WETH market は base を付けない（旧出力と同形 = byte 互換）。WBTC 等のみ base を付与。
  if (best.view.base !== "WETH") action.base = best.view.base;
  process.stdout.write(`${JSON.stringify(action)}\n`);
});
