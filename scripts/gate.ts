// gate: strategy-evolve の unpaired 受理ゲート CLI（ADR 0005 §3。ADR 0002 §6 rule 2 を置換）。
//
// before/after の evaluate JSON（`npm run evaluate` の出力）から対象 agent の per-run netPnl
// サンプルを取り、unpaired 統計で比較する:
//   (a) bootstrap CI( mean(after) − mean(before) ) の下限 > 0      … 有意な改善（improve モード）
//   (b) holdout regime では CI 上限が劣化閾値を割らない             … 汎化（noninferior モード）
//   (c) win-rate（P(after run > before run)）を補助指標として併記
// 補助に Welch の t / Mann-Whitney を出す（最終選択は分布の形を見て決める = ADR「決めていないこと」）。
//
// 他 agent への転嫁チェック（旧ゲート rule 4 相当）: 他 agent の mean netPnl 低下合計が
// 対象の改善を超える場合は flag する（自動却下はしない）。
//
// 使い方:
//   npm run gate --silent -- /tmp/eval-before.json /tmp/eval-after.json <targetAgentId>
// env:
//   GATE_MODE=improve|noninferior（既定 improve。noninferior は holdout regime の再検証用）
//   GATE_MARGIN=<USDC>（noninferior の劣化許容幅。既定 0）
//   GATE_CI_LEVEL（既定 0.9） / GATE_BOOTSTRAP_ITERS（既定 4000） / GATE_SEED（bootstrap の決定論 seed）
//
// 出力: 判定 JSON を stdout、人間向けサマリを stderr。exit code: PASS=0 / FAIL=2 / エラー=1。
import { readFileSync } from "node:fs";
import type { AgentAggregate } from "../src/discrimination.js";
import { evaluateUnpairedGate, type GateMode } from "../src/stats.js";

type EvalJson = {
  regimes?: number[];
  replications?: number;
  runBlocks?: number;
  granularityBlocks?: number;
  agentsConfig?: string;
  forkBlock?: string | null;
  agents: AgentAggregate[];
};

function numEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`expected number env value, got ${value}`);
  return parsed;
}

function loadEval(path: string): EvalJson {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as EvalJson;
  if (!Array.isArray(parsed.agents))
    throw new Error(`${path}: evaluate JSON ではない（agents 配列が無い）`);
  return parsed;
}

function pnlSamples(evalJson: EvalJson, id: string, label: string): number[] {
  const agent = evalJson.agents.find((a) => a.id === id);
  if (!agent) throw new Error(`${label} に agent "${id}" が無い`);
  return agent.netPnl.perRun;
}

function main(): void {
  const [beforePath, afterPath, targetId] = process.argv.slice(2);
  if (!beforePath || !afterPath || !targetId) {
    console.error(
      "usage: npm run gate --silent -- <before.json> <after.json> <targetAgentId>",
    );
    process.exitCode = 1;
    return;
  }
  const mode = (process.env.GATE_MODE ?? "improve") as GateMode;
  if (mode !== "improve" && mode !== "noninferior")
    throw new Error(`invalid GATE_MODE: ${mode}`);

  const before = loadEval(beforePath);
  const after = loadEval(afterPath);

  // 価値系列の粒度不一致は warning ではなく拒否（ADR 0006 §4。Sharpe/IR のスケールが変わり
  // 統計比較が成立しないため）。粒度未記載の旧 JSON は per-block(1) とみなす。
  const granBefore = before.granularityBlocks ?? 1;
  const granAfter = after.granularityBlocks ?? 1;
  if (granBefore !== granAfter) {
    throw new Error(
      `価値系列の粒度が不一致です（before=${granBefore} / after=${granAfter} blocks）。同一粒度で evaluate し直してください。`,
    );
  }

  // 比較条件の整合チェック（市場条件が違う before/after は比較不能）
  const conditionKeys = [
    "regimes",
    "runBlocks",
    "agentsConfig",
    "forkBlock",
  ] as const;
  const mismatches = conditionKeys.filter(
    (k) =>
      JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
  if (mismatches.length) {
    console.error(
      `[gate] warning: before/after で実行条件が不一致: ${mismatches.join(", ")}（比較の妥当性に注意）`,
    );
  }

  const gate = evaluateUnpairedGate(
    pnlSamples(before, targetId, beforePath),
    pnlSamples(after, targetId, afterPath),
    {
      mode,
      margin: numEnv(process.env.GATE_MARGIN, 0),
      level: numEnv(process.env.GATE_CI_LEVEL, 0.9),
      iterations: numEnv(process.env.GATE_BOOTSTRAP_ITERS, 4000),
      seed: numEnv(process.env.GATE_SEED, 12345),
    },
  );

  // 他 agent への転嫁チェック: 他 agent の mean netPnl の低下合計 vs 対象の改善幅。
  const spillover = before.agents
    .filter((a) => a.id !== targetId)
    .map((b) => {
      const a = after.agents.find((x) => x.id === b.id);
      return {
        id: b.id,
        meanBefore: b.netPnl.mean,
        meanAfter: a ? a.netPnl.mean : null,
        meanDiff: a ? a.netPnl.mean - b.netPnl.mean : null,
      };
    });
  const totalDrop = spillover.reduce(
    (s, x) => s + Math.min(0, x.meanDiff ?? 0),
    0,
  );
  const spilloverFlag =
    gate.meanDiff > 0 && Math.abs(totalDrop) > gate.meanDiff;

  const out = {
    targetId,
    beforePath,
    afterPath,
    gate,
    spillover: {
      flag: spilloverFlag,
      totalNegativeMeanDiff: totalDrop,
      agents: spillover,
    },
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

  console.error(
    `[gate] ${gate.pass ? "PASS" : "FAIL"} (${mode}) target=${targetId}: ${gate.reason}`,
  );
  console.error(
    `[gate] mean ${gate.meanBefore.toFixed(2)} → ${gate.meanAfter.toFixed(2)} (Δ=${gate.meanDiff.toFixed(2)}, CI[${gate.ci ? `${gate.ci.low.toFixed(2)}, ${gate.ci.high.toFixed(2)}` : "N/A"}] @${((gate.ci?.level ?? 0) * 100).toFixed(0)}%) win-rate=${gate.winRate === null ? "N/A" : (gate.winRate * 100).toFixed(0)}% welch.p=${gate.welch ? gate.welch.p.toFixed(3) : "N/A"} mw.p=${gate.mannWhitney ? gate.mannWhitney.p.toFixed(3) : "N/A"}`,
  );
  if (spilloverFlag) {
    console.error(
      `[gate] flag: 他 agent の mean PnL 低下合計 ${totalDrop.toFixed(2)} が対象の改善 ${gate.meanDiff.toFixed(2)} を超過（ゼロサム転嫁の疑い。ログに残すこと）`,
    );
  }
  process.exitCode = gate.pass ? 0 : 2;
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
