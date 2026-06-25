/**
 * マルチアセット agent 用の observation 正規化ヘルパ（ADR 0013）。
 *
 * WETH は従来どおりトップレベル（protocols.uniswap.pool / protocols.balancer /
 * protocols.curve）に、追加 base（WBTC 等）は protocols.*.markets["<base>/USDC"] に入る。
 * この差異を吸収し、全 active base を「base / fair / venue 価格群 / base 在庫」の同じ形へ
 * 正規化して返す。これにより agent ロジックは base を意識せず全 market を一様に走査できる
 * （個別資産対応ではなく複数資産対応の設計へ移行するための土台）。
 *
 * base の集合は observation.fairPricesUsd のキーから導出する（coordinator/directShim が
 * 全 active base の fair price を載せる）。venue 価格が 1 つも無い base は除外する。
 */
import type { AgentObservation } from "../../../src/types.js";

export type AgentProtocol = "uniswap" | "balancer" | "curve";

export type AgentVenue = {
  protocol: AgentProtocol;
  swapType: "swap" | "balancerSwap" | "curveSwap";
  price: number; // quote(USDC) per base
};

export type MarketView = {
  base: string; // "WETH" | "WBTC" | ...
  fair: number; // 当該 base の fair USD 価格
  venues: AgentVenue[];
  // base 在庫（base units, decimal string）。WETH は balances.wethWei、他は baseBalances[base]。
  baseBalanceWei: string;
};

const QUOTE = "USDC";

const SWAP_TYPE: Record<AgentProtocol, AgentVenue["swapType"]> = {
  uniswap: "swap",
  balancer: "balancerSwap",
  curve: "curveSwap",
};

function venuePrice(
  obs: AgentObservation,
  base: string,
  protocol: AgentProtocol,
): number | undefined {
  const p = obs.protocols ?? {};
  if (protocol === "uniswap") {
    if (base === "WETH") return p.uniswap?.pool?.priceUsdcPerWeth;
    return p.uniswap?.markets?.[`${base}/${QUOTE}`]?.priceUsdcPerWeth;
  }
  const amm = protocol === "balancer" ? p.balancer : p.curve;
  if (base === "WETH") return amm?.priceUsdcPerWeth;
  return amm?.markets?.[`${base}/${QUOTE}`]?.priceUsdcPerWeth;
}

// observation を base 非依存の market view 配列に正規化する。WETH を先頭に固定（決定論順序）。
export function marketViews(obs: AgentObservation): MarketView[] {
  const fairByBase = obs.fairPricesUsd ?? { WETH: obs.fairPriceUsdcPerWeth };
  const bases = Object.keys(fairByBase).sort((a, b) =>
    a === "WETH" ? -1 : b === "WETH" ? 1 : a < b ? -1 : 1,
  );
  const views: MarketView[] = [];
  for (const base of bases) {
    const fair = fairByBase[base];
    if (!(fair > 0)) continue;
    const venues: AgentVenue[] = [];
    for (const protocol of ["uniswap", "balancer", "curve"] as const) {
      const price = venuePrice(obs, base, protocol);
      if (typeof price === "number" && price > 0)
        venues.push({ protocol, swapType: SWAP_TYPE[protocol], price });
    }
    if (venues.length === 0) continue;
    const baseBalanceWei =
      base === "WETH"
        ? obs.balances.wethWei
        : (obs.baseBalances?.[base] ?? "0");
    views.push({ base, fair, venues, baseBalanceWei });
  }
  return views;
}
