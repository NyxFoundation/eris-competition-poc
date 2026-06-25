// トークンレジストリ + market config 駆動の中核（ADR 0013）。
//
// 旧来 WETH/USDC を名前で埋め込んでいた箇所を「base トークンを quote(USDC 相当)で売買する
// 1 market」へ一般化する純粋層。constants の TOKENS / MARKET_LEGS（生アドレス・venue leg）を
// 受けて、adapter が回せる MarketConfig を組み立てる。新トークンは TOKENS と MARKET_LEGS に
// 定数を 1 つ足すだけで market が増える（型・分岐の改造は不要）。
import { MARKET_LEGS, TOKENS } from "./constants.js";
import type {
  AaveLeg,
  BalancerLeg,
  CurveLeg,
  GmxLeg,
  ProtocolId,
  TokenKind,
  TokenSymbol,
  UniswapLeg,
} from "./types.js";
import type { Address } from "viem";

export type TokenInfo = {
  symbol: TokenSymbol;
  address: Address;
  decimals: number;
  kind: TokenKind;
};

// 会計上の決済通貨シンボル。venue 実 stable（native USDC / USDC.e / USDT）は leg.stable に持ち、
// 残高・PnL は「USDC 相当」で合算する（stable 統一会計。constants の USDC_VARIANTS と整合）。
const QUOTE_SYMBOL: TokenSymbol = "USDC";

// stable とみなすシンボル。これ以外は base（USD 価格を持つ取引対象）。
// 新しい stable を足すときだけここに加える。base は何もしなくても base 扱い。
const STABLE_SYMBOLS = new Set<TokenSymbol>(["USDC", "USDT", "DAI", "USDC.e"]);

export function kindOf(symbol: TokenSymbol): TokenKind {
  return STABLE_SYMBOLS.has(symbol) ? "stable" : "base";
}

export function tokenInfo(symbol: TokenSymbol): TokenInfo {
  const info = TOKENS[symbol];
  if (!info) throw new Error(`markets: unknown token symbol "${symbol}"`);
  return {
    symbol,
    address: info.address,
    decimals: info.decimals,
    kind: kindOf(symbol),
  };
}

export function tokenRegistry(): Record<TokenSymbol, TokenInfo> {
  const out: Record<TokenSymbol, TokenInfo> = {};
  for (const symbol of Object.keys(TOKENS)) out[symbol] = tokenInfo(symbol);
  return out;
}

export function baseTokens(): TokenInfo[] {
  return Object.values(tokenRegistry()).filter((t) => t.kind === "base");
}

export function stableTokens(): TokenInfo[] {
  return Object.values(tokenRegistry()).filter((t) => t.kind === "stable");
}

// venue ごとの取引ペア。base を quote(USDC 相当)で売買する 1 market。
export type MarketConfig = {
  key: string; // "WETH/USDC" 等。observation の pair / marketKey に使う
  protocol: ProtocolId;
  base: TokenSymbol;
  quote: TokenSymbol;
  uniswap?: UniswapLeg;
  balancer?: BalancerLeg;
  curve?: CurveLeg;
  gmx?: GmxLeg;
  aave?: AaveLeg;
};

function attachLeg(
  market: MarketConfig,
  protocol: ProtocolId,
  leg: UniswapLeg | BalancerLeg | CurveLeg | GmxLeg | AaveLeg,
): MarketConfig {
  switch (protocol) {
    case "uniswap":
      market.uniswap = leg as UniswapLeg;
      break;
    case "balancer":
      market.balancer = leg as BalancerLeg;
      break;
    case "curve":
      market.curve = leg as CurveLeg;
      break;
    case "gmx":
      market.gmx = leg as GmxLeg;
      break;
    case "aave":
      market.aave = leg as AaveLeg;
      break;
  }
  return market;
}

// protocol の有効 market を MARKET_LEGS から組み立てる。base の登録順を保つ
// （WETH 先頭 → RNG/採点の決定論順序の前提。ADR 0013 後方互換）。
export function marketsFor(protocol: ProtocolId): MarketConfig[] {
  const legs = MARKET_LEGS[protocol];
  const out: MarketConfig[] = [];
  for (const base of Object.keys(legs)) {
    const market: MarketConfig = {
      key: `${base}/${QUOTE_SYMBOL}`,
      protocol,
      base,
      quote: QUOTE_SYMBOL,
    };
    out.push(attachLeg(market, protocol, legs[base]));
  }
  return out;
}

export function marketFor(
  protocol: ProtocolId,
  base: TokenSymbol,
): MarketConfig | undefined {
  return marketsFor(protocol).find((m) => m.base === base);
}

// 後方互換の既定 base。WETH があれば WETH、無ければ先頭。
export function defaultBaseFor(protocol: ProtocolId): TokenSymbol {
  const markets = marketsFor(protocol);
  return (
    markets.find((m) => m.base === "WETH")?.base ?? markets[0]?.base ?? "WETH"
  );
}

// gmx の base -> market アドレス（SimContext.gmx.markets 設定用）。fork 既定は {WETH: ETH_USD}。
export function gmxMarketAddresses(): Record<TokenSymbol, Address> {
  const out: Record<TokenSymbol, Address> = {};
  for (const m of marketsFor("gmx")) if (m.gmx) out[m.base] = m.gmx.market;
  return out;
}

// 全 protocol を横断した有効 base の集合（chain.ts の ACTIVE_BASES 導出等に使う）。
export function activeBaseSymbols(protocols: ProtocolId[]): TokenSymbol[] {
  const seen = new Set<TokenSymbol>();
  for (const p of protocols) {
    for (const m of marketsFor(p)) seen.add(m.base);
  }
  // WETH を先頭に固定（決定論順序）。
  const ordered = [...seen];
  ordered.sort((a, b) => (a === "WETH" ? -1 : b === "WETH" ? 1 : 0));
  return ordered;
}
