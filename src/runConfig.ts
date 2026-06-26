// YAML を設定の単一ソースにする run config ローダ（ADR 0013）。
//
// 方針:
//   - ユーザー設定値（run ノブ / funding / limits / flow / stress / LLM）と agent ロスターを
//     1 つの YAML（既定 `config/local.yaml`）で管理する。YAML のキーは既存の env 名と同一にし、
//     型変換（bool→"1"/"0"、文字列/数値配列→CSV、object→JSON）して loadConfig が読む source map に
//     流し込む。これで loadConfig の全パーサ（bigintEnv/intEnv 等）を無改修で再利用できる。
//   - **秘密情報のみ env(.env) のまま**（コミットされる YAML に秘密を入れない。外部 SDK が env を
//     直読みするため）。SECRET_ENV_KEYS だけ process.env から source へ持ち込む。
//   - agent サブプロセスへの IPC（ERIS_AGENT_* 等）は coordinator が別途 env で渡す（YAML 対象外）。
//     子は設定ファイルパス ERIS_CONFIG を受け取り、同じ YAML から config を再構築する。
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  loadAgents,
  loadConfig,
  unitSuffixFor,
  validateAgentsFile,
  type SimConfig,
} from "./config.js";
import { tokenInfo } from "./markets.js";
import type { AgentSpec } from "./types.js";

// .env に残す秘密 / RPC（YAML には入れない）。これらは process.env から source へ持ち込む。
export const SECRET_ENV_KEYS = [
  "ARB_RPC_URL",
  "FORK_BLOCK_NUMBER",
  "ANVIL_RPC_URL",
  "ANTHROPIC_API_KEY",
  "OLLAMA_API_KEY",
  "ERIS_OLLAMA_API_KEY",
  "ADMIN_PRIVATE_KEY",
  "KEEPER_PRIVATE_KEY",
  "SETUP_PRIVATE_KEY",
  "FLOW_UNINFORMED_PRIVATE_KEY",
  "FLOW_INFORMED_PRIVATE_KEY",
  "AGENT0_PRIVATE_KEY",
  "AGENT1_PRIVATE_KEY",
  "AGENT2_PRIVATE_KEY",
  "AGENT3_PRIVATE_KEY",
  "AGENT4_PRIVATE_KEY",
  "AGENT5_PRIVATE_KEY",
  "AGENT6_PRIVATE_KEY",
] as const;

// 設定は config/ ディレクトリで管理する。ローカルの実ファイルは config/local.yaml（gitignore）、
// コミット済みの雛形・シナリオは config/example.yaml / config/all18-mixed.yaml / config/claude-llm.yaml。
export const DEFAULT_CONFIG_PATH = "config/local.yaml";
// config/local.yaml が無いときの zero-config 既定（env config 読取は廃止したため env ではなくこれへ）。
export const EXAMPLE_CONFIG_PATH = "config/example.yaml";

// 設定ファイルの解決順: --config > ERIS_CONFIG > config/local.yaml > config/example.yaml。
// 最初に存在するものを返す（無ければ undefined）。
function resolveConfigPathOrUndefined(argv: string[]): string | undefined {
  const i = argv.indexOf("--config");
  const explicit = i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  const candidates = [
    explicit,
    process.env.ERIS_CONFIG,
    DEFAULT_CONFIG_PATH,
    EXAMPLE_CONFIG_PATH,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return candidates.find((p) => existsSync(p));
}

// YAML 値 → env 文字列。loadConfig の各パーサが受け取る形へ正規化する。
//   boolean        → "1" / "0"（loadConfig は `=== "1"` で真偽判定）
//   string/num 配列 → CSV（ENABLED_PROTOCOLS / FLOW_BOT_ARGS 等）
//   object / object配列 → JSON（ERIS_STRESS_EVENTS 等）
//   その他         → String(v)
export function toEnvString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string" || typeof v === "number"))
      return value.map((v) => String(v)).join(",");
    return JSON.stringify(value);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export type RunConfigResult = {
  config: SimConfig;
  agents: AgentSpec[];
  configPath: string;
  source: NodeJS.ProcessEnv;
};

// ネスト lowercase スキーマ（人が書く形）→ 内部 env 名（loadConfig が読む形）の対応表。
// 例: `run.protocols` → ENABLED_PROTOCOLS。全大文字 env 名を表に出さないための薄い変換層。
const SCHEMA: Record<string, string> = {
  // run
  "run.seed": "SEED",
  "run.blocks": "ERIS_RUN_BLOCKS",
  "run.seconds": "ERIS_RUN_SECONDS",
  "run.blockTimeSec": "ERIS_BLOCK_TIME_SEC",
  "run.protocols": "ENABLED_PROTOCOLS",
  "run.economicGas": "ERIS_ECONOMIC_GAS",
  "run.localDeploy": "ERIS_LOCAL_DEPLOY",
  "run.skipReset": "ERIS_SKIP_RESET",
  "run.prewarmBlocks": "ERIS_PREWARM_BLOCKS",
  "run.reportDir": "REPORT_DIR",
  "run.agentDirectTx": "ERIS_AGENT_DIRECT_TX",
  "run.flashArb": "ERIS_FLASH_ARB",
  "run.localSnapshotFile": "ERIS_LOCAL_SNAPSHOT_FILE",
  "run.agentTimeoutMs": "AGENT_TIMEOUT_MS",
  "run.agentsConfig": "AGENTS_CONFIG", // inline agents が無いときのロスターファイルパス
  // funding
  "funding.ethWei": "INITIAL_ETH_WEI",
  "funding.wethWei": "INITIAL_WETH_WEI",
  "funding.usdcUnits": "INITIAL_USDC_UNITS",
  "funding.flowEthWei": "ERIS_FLOW_ETH_WEI",
  // limits
  "limits.agentWethWei": "MAX_AGENT_WETH_IN_WEI",
  "limits.agentUsdcUnits": "MAX_AGENT_USDC_IN_UNITS",
  "limits.lpWethWei": "MAX_LP_WETH_WEI",
  "limits.lpUsdcUnits": "MAX_LP_USDC_UNITS",
  "limits.bundleActions": "MAX_BUNDLE_ACTIONS",
  "limits.openPositions": "MAX_OPEN_POSITIONS",
  "limits.gmxSizeUsd": "MAX_GMX_SIZE_USD",
  "limits.aaveSupplyWethWei": "MAX_AAVE_SUPPLY_WETH_WEI",
  "limits.aaveBorrowUsdcUnits": "MAX_AAVE_BORROW_USDC_UNITS",
  "limits.priorityFeeWei": "DEFAULT_PRIORITY_FEE_WEI",
  "limits.maxPriorityFeeWei": "MAX_PRIORITY_FEE_WEI",
  // flow
  "flow.uninformedMaxWethWei": "UNINFORMED_FLOW_MAX_WETH_WEI",
  "flow.informedMaxWethWei": "INFORMED_FLOW_MAX_WETH_WEI",
  "flow.balancerMaxWethWei": "BALANCER_FLOW_MAX_WETH_WEI",
  "flow.curveMaxWethWei": "CURVE_FLOW_MAX_WETH_WEI",
  "flow.gmxMaxSizeUsd": "GMX_FLOW_MAX_SIZE_USD",
  "flow.aaveMaxWethWei": "AAVE_FLOW_MAX_WETH_WEI",
  "flow.crossVenueSpreadMaxWethWei": "CROSS_VENUE_SPREAD_FLOW_MAX_WETH_WEI",
  "flow.seed": "FLOW_SEED",
  "flow.botCommand": "FLOW_BOT_COMMAND",
  "flow.botArgs": "FLOW_BOT_ARGS",
  // stress
  "stress.events": "ERIS_STRESS_EVENTS",
  "stress.victimCount": "ERIS_STRESS_VICTIM_COUNT",
  "stress.victimHf0": "ERIS_STRESS_VICTIM_HF0",
  "stress.victimWethWei": "ERIS_STRESS_VICTIM_WETH_WEI",
};
// per-base マップ（`{WBTC: 値}` → `<prefix>_<SYM>[_<infix>]_<unit>`。unit は decimals 由来）。
const BASE_SECTIONS: Record<string, { prefix: string; infix?: string }> = {
  "funding.base": { prefix: "INITIAL" },
  "limits.agentBase": { prefix: "MAX_AGENT", infix: "IN" },
  "limits.lpBase": { prefix: "MAX_LP" },
  "limits.aaveSupplyBase": { prefix: "MAX_AAVE_SUPPLY" },
  "flow.baseMax": { prefix: "FLOW_MAX" },
};
const SECTIONS = ["run", "funding", "limits", "flow", "stress"];

function baseEnvName(prefix: string, sym: string, infix?: string): string {
  const unit = unitSuffixFor(tokenInfo(sym).decimals);
  return [prefix, sym, infix, unit].filter(Boolean).join("_");
}

// ネスト doc を内部 env 名 source へ展開する。未知キーは警告（typo 検出）。
function applyDoc(
  doc: Record<string, unknown>,
  source: NodeJS.ProcessEnv,
): void {
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(doc)) {
    if (k === "agents") continue; // ロスターは別扱い
    if (
      SECTIONS.includes(k) &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        const path = `${k}.${sk}`;
        const baseDef = BASE_SECTIONS[path];
        if (baseDef) {
          if (sv && typeof sv === "object" && !Array.isArray(sv))
            for (const [sym, amt] of Object.entries(
              sv as Record<string, unknown>,
            ))
              source[baseEnvName(baseDef.prefix, sym, baseDef.infix)] =
                toEnvString(amt);
        } else if (SCHEMA[path]) {
          const env = SCHEMA[path];
          // FLOW_BOT_ARGS だけは空白区切り（config.ts が /\s+/ で split）。
          source[env] =
            env === "FLOW_BOT_ARGS" && Array.isArray(sv)
              ? sv.map((x) => String(x)).join(" ")
              : toEnvString(sv);
        } else {
          unknown.push(path);
        }
      }
    } else if (/^[A-Z]/.test(k)) {
      source[k] = toEnvString(v); // 後方互換: 大文字キーは env 名としてそのまま通す
    } else {
      unknown.push(k);
    }
  }
  if (unknown.length > 0)
    process.stderr.write(
      `[config] 警告: 未知の設定キー（無視）: ${unknown.join(", ")}。スキーマは src/runConfig.ts の SCHEMA を参照。\n`,
    );
}

// YAML から source map を組む（秘密 env → YAML → overrides の順で重ねる）。
export function buildSource(
  doc: Record<string, unknown>,
  overrides: Record<string, string | number | boolean> = {},
  configPath?: string,
): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = {};
  for (const k of SECRET_ENV_KEYS)
    if (process.env[k] !== undefined) source[k] = process.env[k];
  applyDoc(doc, source);
  // overrides は内部 env 名キー（CLI エイリアスが既に env 名へマップ済み）で最優先。
  for (const [k, v] of Object.entries(overrides)) source[k] = toEnvString(v);
  if (configPath) source.ERIS_CONFIG = configPath;
  return source;
}

// YAML 設定ファイルを読み、SimConfig + ロスターへ解決する。
export function loadRunConfig(
  path = DEFAULT_CONFIG_PATH,
  overrides: Record<string, string | number | boolean> = {},
): RunConfigResult {
  if (!existsSync(path)) throw new Error(`config file not found: ${path}`);
  const doc = parseYaml(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  > | null;
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error(`${path} must be a YAML mapping`);

  const source = buildSource(doc, overrides, path);
  const config = loadConfig(source);
  // ロスター: inline `agents:` があればそれを、無ければ AGENTS_CONFIG のファイルを読む。
  const agents = Array.isArray(doc.agents)
    ? validateAgentsFile({ agents: doc.agents }, path)
    : loadAgents(config.agentsConfigPath);
  return { config, agents, configPath: path, source };
}

// 解決される設定ファイルパス（存在すれば）。--config > ERIS_CONFIG > config/local.yaml >
// config/example.yaml の順。
export function currentConfigPath(
  argv: string[] = process.argv,
): string | undefined {
  return resolveConfigPathOrUndefined(argv);
}

// 評価ツールが自分のセクション（evaluate / discrimination / gate 等）を読むための raw YAML doc。
// YAML が無ければ空オブジェクト。
export function loadConfigDoc(
  argv: string[] = process.argv,
): Record<string, unknown> {
  const path = currentConfigPath(argv);
  if (!path) return {};
  const doc = parseYaml(readFileSync(path, "utf8"));
  return doc && typeof doc === "object" && !Array.isArray(doc)
    ? (doc as Record<string, unknown>)
    : {};
}

// `--key value` / `--key=value` / `--flag` を拾う軽量パーサ（env の代わりに一回限りの上書きに使う）。
export function parseCliFlags(
  argv: string[] = process.argv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) out[body.slice(0, eq)] = body.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--"))
      out[body] = argv[++i];
    else out[body] = "1";
  }
  return out;
}

// 退役した代表的な「設定 env」が残っていたら警告する（silent に既定動作へ落ちる事故を防ぐ）。
// これらはもう読まれない。設定は YAML（config/local.yaml / --config）へ、ツール params は CLI フラグへ。
const RETIRED_CONFIG_ENV = [
  "ENABLED_PROTOCOLS",
  "AGENTS_CONFIG",
  "SEED",
  "ERIS_RUN_BLOCKS",
  "ERIS_RUN_SECONDS",
  "ERIS_ECONOMIC_GAS",
  "REGIMES",
  "REPLICATIONS",
  "ROUNDS",
  "GATE_MODE",
  "INITIAL_WETH_WEI",
] as const;
let warnedRetired = false;
function warnRetiredConfigEnv(): void {
  if (warnedRetired) return;
  const found = RETIRED_CONFIG_ENV.filter((k) => process.env[k] !== undefined);
  if (found.length === 0) return;
  warnedRetired = true;
  process.stderr.write(
    `[config] 警告: 設定 env は退役しました（無視されます）: ${found.join(", ")}。` +
      ` 設定は config/local.yaml / --config、ツール params は CLI フラグ（--regimes 等）で指定してください。\n`,
  );
}

// 一回限りの上書き用 CLI エイリアス（env の代替）。`--seed 1 --protocols uniswap,balancer` のように使う。
// 値は YAML と同じ設定キーへマップして overrides に積む（YAML を編集せず run ごとに変えられる）。
const CLI_ALIAS: Record<string, string> = {
  seed: "SEED",
  blocks: "ERIS_RUN_BLOCKS",
  seconds: "ERIS_RUN_SECONDS",
  protocols: "ENABLED_PROTOCOLS",
  agents: "AGENTS_CONFIG",
  "economic-gas": "ERIS_ECONOMIC_GAS",
  "local-deploy": "ERIS_LOCAL_DEPLOY",
};
function cliOverrides(argv: string[]): Record<string, string> {
  const flags = parseCliFlags(argv);
  const out: Record<string, string> = {};
  for (const [alias, key] of Object.entries(CLI_ALIAS))
    if (flags[alias] !== undefined) out[key] = flags[alias];
  return out;
}

// CLI/coordinator 用の入口。設定は YAML 一本化（env config 読取は廃止）。解決順は
// --config > ERIS_CONFIG > config/local.yaml > config/example.yaml。いずれも無ければ
// 明示エラー（env へはフォールバックしない）。CLI エイリアス（--seed 等）と programmatic
// overrides を YAML の上に重ねる（overrides が最優先）。
export function resolveRunInputs(
  argv: string[] = process.argv,
  overrides: Record<string, string | number | boolean> = {},
): {
  config: SimConfig;
  agents: AgentSpec[];
  configPath?: string;
} {
  warnRetiredConfigEnv();
  const path = resolveConfigPathOrUndefined(argv);
  if (!path)
    throw new Error(
      `no config file found. cp ${EXAMPLE_CONFIG_PATH} ${DEFAULT_CONFIG_PATH} ` +
        `(または --config <path> を指定)。設定は YAML 一本化済み（env からの設定読取は廃止）。`,
    );
  const merged = { ...cliOverrides(argv), ...overrides };
  const r = loadRunConfig(path, merged);
  return { config: r.config, agents: r.agents, configPath: r.configPath };
}
