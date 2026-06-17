// evaluate: config を regime × N 回、実時間 sim で反復実行し、agent ごとの集計統計を出す。
// strategy-evolve の「unpaired 統計ゲート」のサンプル収集部（ADR 0005）。
//
// 実時間化で決定論を捨てたため、「同一 SEED の before/after = 同一市場」の paired 比較は
// 成立しない。SEED(=regime)は市場条件のラベルに格下げし、同一 regime でも tx タイミングの
// 非決定で結果がぶれることを前提に N サンプルを貯める。before/after の比較は
// `npm run gate`（bootstrap CI / Welch / Mann-Whitney）で行う。
//
// 各 run は ERIS_RUN_BLOCKS 固定で長さを揃える（価格パス長を一定化し公平に）。
// 同一 anvil への並行 sim は不可（resetFork が干渉）なので直列実行する。
//
// 使い方:
//   REGIMES=1 REPLICATIONS=8 ERIS_RUN_BLOCKS=60 AGENTS_CONFIG=agents.evolve.json npm run evaluate
//
// 出力: 1 つの JSON オブジェクトを stdout に。git 追跡ファイルには書かない。
import { aggregateAgents } from "../src/discrimination.js";
import { collectReplicationStats, parseRegimes } from "../src/multiSeedRun.js";

process.env.AGENTS_CONFIG ??= "agents.evolve.json";
// 実時間 run の長さはブロック数で固定（標準値は ADR 0005「決めていないこと」: 実測で再較正）。
process.env.ERIS_RUN_BLOCKS ??= "60";
// runSeconds の途中打ち切りで run 長が wall-clock 依存にぶれないよう、ブロック数のみで終了する。
process.env.ERIS_RUN_SECONDS ??= "0";

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`expected positive integer env value, got ${value}`);
  return parsed;
}

async function main(): Promise<void> {
  // 探索段の既定は単一 regime × 8 反復（ADR 0005 §4: 既定 N は小さく始める）。
  // 恒久化・holdout 検証では REGIMES を切り替える（例 REGIMES=11）。SEEDS は旧名の別名。
  const regimes = parseRegimes(process.env.REGIMES ?? process.env.SEEDS, "1");
  const replications = intEnv(process.env.REPLICATIONS, 8);
  const { byAgent, runs, granularityBlocks } = await collectReplicationStats(
    regimes,
    replications,
  );
  const agents = aggregateAgents(byAgent);

  const out = {
    regimes,
    replications,
    runBlocks: Number(process.env.ERIS_RUN_BLOCKS),
    blockTimeSec: Number(process.env.ERIS_BLOCK_TIME_SEC ?? 2),
    // 価値系列の粒度（ADR 0006 §4）。gate は粒度不一致の比較を拒否する。
    granularityBlocks,
    agentsConfig: process.env.AGENTS_CONFIG,
    // 再現性メタデータ: fork block を固定しないと before/after の市場が動く。
    forkBlock: process.env.FORK_BLOCK_NUMBER ?? null,
    enabledProtocols: process.env.ENABLED_PROTOCOLS ?? null,
    runs,
    agents,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
