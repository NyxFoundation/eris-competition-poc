import test from "node:test";
import assert from "node:assert/strict";
import {
  isObservationEvent,
  perRoundValueUsdc,
  sharpeRatio,
} from "../src/perRoundValues.js";

test("perRoundValueUsdc: spot inventory のみ", () => {
  assert.equal(perRoundValueUsdc({ inventory: { valueUsdc: 1000 } }), 1000);
});

test("perRoundValueUsdc: uniswap LP ポジションを加算", () => {
  const v = perRoundValueUsdc({
    inventory: { valueUsdc: 1000 },
    protocols: {
      uniswap: { positions: [{ valueUsdc: 250 }, { valueUsdc: 100 }] },
    },
  });
  assert.equal(v, 1350);
});

test("perRoundValueUsdc: GMX(WETH 担保) = collateral×price + pnl", () => {
  const v = perRoundValueUsdc({
    inventory: { valueUsdc: 0 },
    protocols: {
      gmx: {
        marketPriceUsd: 3000,
        position: {
          collateral: "WETH",
          collateralAmount: String(10n ** 18n), // 1 WETH
          pnlUsd: 50,
        },
      },
    },
  });
  assert.equal(v, 3050); // 1*3000 + 50
});

test("perRoundValueUsdc: GMX(USDC 担保) = collateral/1e6 + pnl", () => {
  const v = perRoundValueUsdc({
    inventory: { valueUsdc: 0 },
    protocols: {
      gmx: {
        marketPriceUsd: 3000,
        position: {
          collateral: "USDC",
          collateralAmount: String(1000n * 10n ** 6n), // 1000 USDC
          pnlUsd: -20,
        },
      },
    },
  });
  assert.equal(v, 980); // 1000 - 20
});

test("perRoundValueUsdc: Aave net = (collateral-debt)/1e8", () => {
  const v = perRoundValueUsdc({
    inventory: { valueUsdc: 100 },
    protocols: {
      aave: {
        totalCollateralBase: String(5000n * 10n ** 8n),
        totalDebtBase: String(1000n * 10n ** 8n),
      },
    },
  });
  assert.equal(v, 4100); // 100 + (5000-1000)
});

test("perRoundValueUsdc: 後方互換のフラット positions 配列", () => {
  const v = perRoundValueUsdc({
    inventory: { valueUsdc: 10 },
    positions: [{ valueUsdc: 5 }, { valueUsdc: 7 }],
  });
  assert.equal(v, 22);
});

test("isObservationEvent: inventory.valueUsdc があれば true（positions 配列不要）", () => {
  assert.equal(
    isObservationEvent({
      type: "observation",
      agentId: "a",
      observation: { round: 1, inventory: { valueUsdc: 1 }, protocols: {} },
    }),
    true,
  );
  assert.equal(isObservationEvent({ type: "other" }), false);
});

test("sharpeRatio: 変動する系列で非 null", () => {
  const s = sharpeRatio([100, 101, 99, 102, 100]);
  assert.ok(s !== null && Number.isFinite(s));
});

test("sharpeRatio: 定数系列は null", () => {
  assert.equal(sharpeRatio([100, 100, 100, 100]), null);
});
