import { formatUnits } from "viem";
import type { BalanceSnapshot, LpPositionObservation } from "./types.js";

export function valueUsdc(snapshot: BalanceSnapshot, fairPriceUsdcPerWeth: number): number {
  const eth = Number(formatUnits(snapshot.ethWei, 18));
  const weth = Number(formatUnits(snapshot.wethWei, 18));
  const usdc = Number(formatUnits(snapshot.usdcUnits, 6));
  return usdc + (eth + weth) * fairPriceUsdcPerWeth;
}

export function balanceToInventory(snapshot: BalanceSnapshot, fairPriceUsdcPerWeth: number) {
  const eth = Number(formatUnits(snapshot.ethWei, 18));
  const weth = Number(formatUnits(snapshot.wethWei, 18));
  const usdc = Number(formatUnits(snapshot.usdcUnits, 6));
  return {
    valueUsdc: usdc + (eth + weth) * fairPriceUsdcPerWeth,
    weth,
    usdc,
    eth
  };
}

export function positionsValueUsdc(positions: LpPositionObservation[]): number {
  return positions.reduce((sum, position) => sum + position.valueUsdc, 0);
}

export function valueUsdcWithPositions(snapshot: BalanceSnapshot, positions: LpPositionObservation[], fairPriceUsdcPerWeth: number): number {
  return valueUsdc(snapshot, fairPriceUsdcPerWeth) + positionsValueUsdc(positions);
}
