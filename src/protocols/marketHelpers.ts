// market 解決と base 価格参照の共通ヘルパ（ADR 0013, Phase 5）。
//
// 各 adapter は「action.base から market を解決し、その market の venue leg を使う」形に揃える。
// fork 既定では WETH market のみ存在するため、base 未指定（既定 WETH）の経路は従来と完全一致
// （後方互換）。WBTC 等は MARKET_LEGS に leg が増えた分だけ解決できるようになる。
import { marketFor, type MarketConfig } from "../markets.js";
import type { ProtocolId, TokenSymbol } from "../types.js";
import type { SimContext } from "./types.js";

// action の base（既定 WETH）から当該 protocol の market を解決する。
export function resolveMarket(
  protocol: ProtocolId,
  action: { base?: TokenSymbol },
): MarketConfig {
  const base = action.base ?? "WETH";
  const market = marketFor(protocol, base);
  if (!market) {
    throw new Error(`${protocol}: no market configured for base "${base}"`);
  }
  return market;
}

// adapter が当該 base の fair price(USD) を引く。ctx.fairPrices 優先、無ければ単一 fairPrice。
// WETH は fallback と一致するので後方互換（ctx.fairPrices 未設定でも従来通り動く）。
export function baseFairPrice(
  ctx: SimContext,
  base: TokenSymbol,
  fallback: number,
): number {
  const p = ctx.fairPrices?.[base];
  return p !== undefined && Number.isFinite(p) ? p : fallback;
}
