import { formatUnits } from "viem";
import { tokenInfo } from "./markets.js";
import type { BalanceSnapshot } from "./types.js";

// 価格引数。後方互換で単一 number（WETH/USD）も受け、{WETH:n} に正規化する（ADR 0013）。
export type PriceArg = number | Record<string, number>;

function normalizePrices(arg: PriceArg): Record<string, number> {
  return typeof arg === "number" ? { WETH: arg } : arg;
}

// ベース wallet 値：loose な ETH + 全 base トークン + stable(USDC 相当)。
// プロトコル固有のポジション価値（LP, perp, aave net）は各 adapter.valueUsdc が加算する。
// ADR 0013: snapshot.bases があれば全 base を各 USD 価格で評価、無ければ wethWei を WETH として
// 評価する（= 旧挙動と完全一致）。
export function valueUsdc(snapshot: BalanceSnapshot, prices: PriceArg): number {
  const p = normalizePrices(prices);
  const wethPrice = p.WETH ?? 0;
  const eth = Number(formatUnits(snapshot.ethWei, 18)) * wethPrice;
  let total = Number(formatUnits(snapshot.usdcUnits, 6)) + eth;
  const bases = snapshot.bases ?? { WETH: snapshot.wethWei };
  for (const [sym, wei] of Object.entries(bases)) {
    total += Number(formatUnits(wei, tokenInfo(sym).decimals)) * (p[sym] ?? 0);
  }
  return total;
}

export function balanceToInventory(
  snapshot: BalanceSnapshot,
  prices: PriceArg,
) {
  const eth = Number(formatUnits(snapshot.ethWei, 18));
  const weth = Number(formatUnits(snapshot.wethWei, 18));
  const usdc = Number(formatUnits(snapshot.usdcUnits, 6));
  return {
    valueUsdc: valueUsdc(snapshot, prices),
    weth,
    usdc,
    eth,
  };
}
