// evaluate: 複数 SEED で sim を回し、agent ごとに seed 横断の集計統計を出す。
// strategy-evolve の「過学習ゲート」本体。
//
// 各 SEED は市場(fair price + flow bot)を決定論的に固定する（flowSeed 既定 = SEED, config.ts）。
// → 同一 SEED の before-run / after-run は同一市場を見るので、戦略変更の差分だけが測れる。
// → SEED をまたぐと別の市場シナリオになるので、1 seed だけで勝つ過学習を検出できる。
// 単一 seed で勝っても他 seed で負ける変更を弾くため、median だけでなく
// min(最悪 seed) と win-rate(正 PnL の seed 数) を出す。Sharpe は leaderboard と
// 共有モジュール(src/perRoundValues.ts)で一貫させる。
//
// 実走 + 集計は src/multiSeedRun.ts / src/discrimination.ts と共有（識別力判定 CLI と一致させる）。
//
// 使い方:
//   SEEDS=1,2,3,4,5 ROUNDS=128 AGENTS_CONFIG=agents.evolve.json npm run evaluate
//
// 出力: 1 つの JSON オブジェクトを stdout に。git 追跡ファイルには書かない。
import { aggregateAgents } from "../src/discrimination.js";
import { collectMultiSeedStats, parseSeeds } from "../src/multiSeedRun.js";

process.env.ROUNDS ??= "128";
process.env.AGENTS_CONFIG ??= "agents.evolve.json";

async function main(): Promise<void> {
  const seeds = parseSeeds(process.env.SEEDS, "1,2,3,4,5");
  const { byAgent, perSeedRuns } = await collectMultiSeedStats(seeds);
  const agents = aggregateAgents(byAgent);

  const out = {
    seeds,
    rounds: Number(process.env.ROUNDS),
    agentsConfig: process.env.AGENTS_CONFIG,
    // 再現性メタデータ: fork block を固定しないと before/after の市場が動く。
    forkBlock: process.env.FORK_BLOCK_NUMBER ?? null,
    enabledProtocols: process.env.ENABLED_PROTOCOLS ?? null,
    perSeedRuns,
    agents,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
