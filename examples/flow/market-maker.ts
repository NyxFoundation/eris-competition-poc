/**
 * market-maker: 既定の orderflow bot（独立プロセス）。
 *
 * coordinator から毎ラウンド FlowContext(JSON 1 行)を stdin で受け取り、
 * 自前の seeded RNG で uninformed ノイズ + informed(価格を fair に寄せる)注文を生成し、
 * FlowOrder[] を stdout に 1 行で返す。
 *
 * 環境変数:
 *   ERIS_FLOW_SEED  決定論 RNG のシード（coordinator が seed 由来で渡す）
 *
 * 設計:
 *   - RPC には触れない（agent と同じ分離原則）。必要な市場状態はすべて FlowContext で渡される。
 *   - Rng は起動時に 1 度だけ生成し、ラウンドが届くたびに決定論的に消費する。
 *     同一 seed → 同一 flow（strategy-evolve のマルチシード評価が依存する固定市場）。
 *   - 生成順序は coordinator が渡す protocols 配列の順（= enabledAdapters 順）に従う。
 */
import { createInterface } from "node:readline";
import { Rng } from "../../src/rng.js";
import { buildFlowOrders, type FlowContextWire } from "../../src/flow/logic.js";
import { safeStringify } from "../../src/logger.js";

const flowSeed = Number(process.env.ERIS_FLOW_SEED ?? "1");
if (!Number.isFinite(flowSeed)) {
  process.stderr.write(
    `invalid ERIS_FLOW_SEED: ${process.env.ERIS_FLOW_SEED}\n`,
  );
  process.exit(1);
}

const rng = new Rng(flowSeed);
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  try {
    const ctx = JSON.parse(line) as FlowContextWire;
    const orders = buildFlowOrders(rng, ctx);
    process.stdout.write(`${safeStringify(orders)}\n`);
  } catch (error) {
    process.stderr.write(
      `flow bot error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    // パース失敗時も RNG ストリームを崩さないよう、空注文だけ返して継続。
    process.stdout.write("[]\n");
  }
});
