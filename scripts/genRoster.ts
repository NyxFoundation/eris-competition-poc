// 戦略カタログからパラメータ sweep で「多数 agent を同時に走らせる」ロスターを生成する。
//
// 全 agent は AUTO wallet(seed+id 由来の決定論鍵)を使うので **数に上限なし**。
// 少数の戦略タイプを、env パラメータの組合せ(直積)で多数インスタンスに展開する。
//
// 使い方:
//   npm run gen:roster                       # 既定カタログ → agents.swarm-big.json
//   OUT=agents.foo.json INCLUDE_LLM=1 npm run gen:roster
//
// 出力したロスターは通常どおり実行:
//   ENABLED_PROTOCOLS=uniswap,balancer,curve,gmx ROUNDS=128 \
//     AGENTS_CONFIG=agents.swarm-big.json npm run leaderboard
import { writeFileSync } from "node:fs";
import { BASE_STRATEGY_IDS } from "../src/llm/baseStrategies.js";
import type { AgentSpec } from "../src/types.js";

type Sweep = Record<string, Array<string | number>>;
type StratDef = {
  base: string;
  script: string;
  sweep?: Sweep; // 各パラメータの候補値。直積で展開。
};

// パラメータ可変な戦略(sweep で多数インスタンス化)。
const PARAMETRIC: StratDef[] = [
  {
    base: "arb",
    script: "examples/agents/arb-bot.ts",
    sweep: { BID_PROFIT_FRACTION: [0.1, 0.2, 0.3, 0.5, 0.8] },
  },
  {
    base: "cvbal",
    script: "examples/agents/cv-bal-arb.ts",
    sweep: { SPREAD_BPS: [10, 15, 20, 30, 50] },
  },
  {
    base: "dnlp",
    script: "examples/agents/dn-lp.ts",
    sweep: { HEDGE_FRACTION: [0.25, 0.5, 0.75, 1.0] },
  },
  {
    base: "gmxrev",
    script: "examples/agents/gmx-reversion.ts",
    sweep: {
      ENTRY_BPS: [30, 50],
      MA_LOOKBACK: [8, 16],
      EXIT_BPS: [10],
      STOP_USD: [150],
    },
  },
  {
    base: "gmxtrend",
    script: "examples/agents/gmx-trend.ts",
    sweep: { TREND_BPS: [30, 60], TREND_LOOKBACK: [8, 16] },
  },
  // main から取り込んだ新戦略(observation 正規化を入れて実動作させた)。
  {
    base: "statarb",
    script: "examples/agents/stat-arb.ts",
    // Z_AGGRESSIVE 既定 2.5 を超えない範囲で entry 閾値を sweep。
    sweep: { STAT_ARB_Z_ENTER: [1.0, 1.5, 2.0] },
  },
  {
    base: "fairmm",
    script: "examples/agents/fair-mm.ts",
    sweep: { FAIR_MM_RANGE_TICK_MULTIPLIER: [4, 8] },
  },
  {
    base: "jitlp",
    script: "examples/agents/jit-lp.ts",
    sweep: { JIT_VOL_QUANTILE: [0.8, 0.9] },
  },
  {
    base: "ladder",
    script: "examples/agents/ladder-mm.ts",
    sweep: { LADDER_STEPS: [3, 5] },
  },
];

// 固定挙動(env パラメータ無し)。1 インスタンスずつ。
const FIXED: StratDef[] = [
  { base: "gmxperp", script: "examples/agents/gmx-perp.ts" },
  { base: "lpmint", script: "examples/agents/lp-mint.ts" },
  { base: "lpprov", script: "examples/agents/lp-provider.ts" },
  { base: "aavearb", script: "examples/agents/aave-arb.ts" },
  { base: "aavelev", script: "examples/agents/aave-leverage.ts" },
  { base: "venue", script: "examples/agents/venue-arb.ts" },
  { base: "simple", script: "examples/agents/simple-rule.ts" },
  { base: "rawswap", script: "examples/agents/raw-swap.ts" },
  // GitHub [strategy] issues #6 / #4 / #11
  { base: "aaveloop", script: "examples/agents/aave-loop.ts" },
  { base: "crossvenue", script: "examples/agents/cross-venue-arb.ts" },
  { base: "lpyield", script: "examples/agents/lp-yield.ts" },
];

// env パラメータの直積。{A:[1,2],B:[9]} → [{A:1,B:9},{A:2,B:9}]
function product(sweep: Sweep): Array<Record<string, string>> {
  const keys = Object.keys(sweep);
  let combos: Array<Record<string, string>> = [{}];
  for (const key of keys) {
    const next: Array<Record<string, string>> = [];
    for (const combo of combos) {
      for (const value of sweep[key]) {
        next.push({ ...combo, [key]: String(value) });
      }
    }
    combos = next;
  }
  return combos;
}

// パラメータ値を id 用の短いラベルにする(例 BID_PROFIT_FRACTION=0.3 → bpf0.3)
function label(key: string, value: string): string {
  const abbr = key
    .toLowerCase()
    .split("_")
    .map((w) => w[0])
    .join("");
  return `${abbr}${value}`;
}

function agentScript(script: string): { command: string; args: string[] } {
  return { command: "node", args: ["--import", "tsx", script] };
}

function build(): AgentSpec[] {
  const agents: AgentSpec[] = [];

  for (const def of PARAMETRIC) {
    for (const env of product(def.sweep ?? {})) {
      const suffix = Object.entries(env)
        .map(([k, v]) => label(k, v))
        .join("-");
      agents.push({
        ...agentScript(def.script),
        id: `${def.base}-${suffix}`,
        wallet: "AUTO",
        env,
        description: `${def.base} (${Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")})`,
      });
    }
  }

  for (const def of FIXED) {
    agents.push({
      ...agentScript(def.script),
      id: def.base,
      wallet: "AUTO",
      description: `${def.base} (fixed)`,
    });
  }

  // 任意: 自己改善する LLM agent。INCLUDE_LLM=1 で**全ベース戦略**(src/llm/baseStrategies.ts)を
  // それぞれ LLM seed して混ぜる。ベース戦略を増やすほど自動で対象が増える。
  // 注意: 各 agent が背景で `claude -p`(1回 ~1-3分)を revise ごとに呼ぶため、数が増えると
  // run 時間とサブスク/API コストが大きくなる。小さく試すなら ERIS_LLM_REVIEW_EVERY を大きく。
  if (process.env.INCLUDE_LLM === "1") {
    for (const base of BASE_STRATEGY_IDS) {
      agents.push({
        ...agentScript("examples/agents/claude-llm.ts"),
        id: `llm-${base}`,
        wallet: "AUTO",
        env: { ERIS_BASE_STRATEGY: base, ERIS_LLM_AUTH: "cli" },
        description: `self-improving LLM seeded from ${base}`,
      });
    }
  }

  // ベースライン(識別力の物差し)。
  agents.push({
    ...agentScript("examples/agents/noop.ts"),
    id: "noop",
    wallet: "AUTO",
    baseline: true,
    description: "baseline: noop",
  });
  agents.push({
    ...agentScript("examples/agents/random.ts"),
    id: "random",
    wallet: "AUTO",
    baseline: true,
    description: "baseline: random (deterministic)",
  });

  return agents;
}

function main(): void {
  const out = process.env.OUT ?? "agents.swarm-big.json";
  const agents = build();
  writeFileSync(out, `${JSON.stringify({ agents }, null, 2)}\n`);
  const byBase = new Map<string, number>();
  for (const a of agents) {
    const base = a.id.split("-")[0];
    byBase.set(base, (byBase.get(base) ?? 0) + 1);
  }
  console.error(`[gen:roster] wrote ${out} with ${agents.length} agents`);
  console.error(
    `[gen:roster] by base: ${[...byBase.entries()].map(([b, n]) => `${b}:${n}`).join("  ")}`,
  );
}

main();
