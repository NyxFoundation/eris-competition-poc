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
// 使い方（設定は eris.config.yaml の `evaluate:` セクション。一回限りは CLI で上書き）:
//   npm run evaluate -- --regimes 1,11 --replications 8 --config eris.config.yaml
// run の長さ・ロスター・protocol 等は YAML（ERIS_RUN_BLOCKS / agents / ENABLED_PROTOCOLS）から。
//
// 出力: 1 つの JSON オブジェクトを stdout に。git 追跡ファイルには書かない。
import { aggregateAgents } from "../src/discrimination.js";
import { collectReplicationStats, parseRegimes } from "../src/multiSeedRun.js";
import {
  loadConfigDoc,
  parseCliFlags,
  resolveRunInputs,
} from "../src/runConfig.js";

function posInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null || String(value).trim() === "")
    return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`expected positive integer, got ${value}`);
  return parsed;
}

async function main(): Promise<void> {
  const { config } = resolveRunInputs();
  const flags = parseCliFlags();
  const section = (loadConfigDoc().evaluate ?? {}) as Record<string, unknown>;
  // 探索段の既定は単一 regime × 8 反復。恒久化・holdout 検証で regimes を切り替える。
  // 優先: CLI --regimes > YAML evaluate.regimes > 既定 "1"。
  const regimesRaw =
    flags.regimes ??
    (Array.isArray(section.regimes)
      ? section.regimes.join(",")
      : (section.regimes as string | undefined));
  const regimes = parseRegimes(regimesRaw, "1");
  const replications = posInt(flags.replications ?? section.replications, 8);
  const { byAgent, runs, granularityBlocks } = await collectReplicationStats(
    regimes,
    replications,
  );
  const agents = aggregateAgents(byAgent);

  const out = {
    regimes,
    replications,
    // 再現性メタデータは解決済み config から取る（env を読まない）。
    runBlocks: config.runBlocks,
    blockTimeSec: config.blockTimeSec,
    // 価値系列の粒度（gate は粒度不一致の比較を拒否する）。
    granularityBlocks,
    agentsConfig: config.agentsConfigPath,
    forkBlock: config.forkBlockNumber ?? null,
    enabledProtocols: config.enabledProtocols.join(","),
    runs,
    agents,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
