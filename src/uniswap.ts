// 互換 shim: Uniswap ロジックは src/protocols/uniswap.ts へ移設済み。
// 既存の import パス（../src/uniswap.js）を壊さないため再エクスポートする。
export {
  liquidityToTokenAmounts,
  getPoolState,
  getPoolPriceUsdcPerWeth,
  getLpPositions,
  uniswapAdapter,
} from "./protocols/uniswap.js";
