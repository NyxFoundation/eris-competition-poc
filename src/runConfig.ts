// YAML を設定の単一ソースにする run config ローダ（ADR 0013）。
//
// 方針:
//   - ユーザー設定値（run ノブ / funding / limits / flow / stress / LLM）と agent ロスターを
//     1 つの YAML（既定 `eris.config.yaml`）で管理する。YAML のキーは既存の env 名と同一にし、
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
  validateAgentsFile,
  type SimConfig,
} from "./config.js";
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

export const DEFAULT_CONFIG_PATH = "eris.config.yaml";
// コミット済みの雛形。eris.config.yaml が無いときの zero-config 既定（env config 読取は廃止したため、
// env ではなくこの YAML へフォールバックする）。
export const EXAMPLE_CONFIG_PATH = "eris.config.example.yaml";

// 設定ファイルの解決順: --config > ERIS_CONFIG > eris.config.yaml > eris.config.example.yaml。
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

// YAML から source map を組む（秘密 env → YAML → overrides の順で重ねる）。
export function buildSource(
  doc: Record<string, unknown>,
  overrides: Record<string, string | number | boolean> = {},
  configPath?: string,
): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = {};
  for (const k of SECRET_ENV_KEYS)
    if (process.env[k] !== undefined) source[k] = process.env[k];
  for (const [k, v] of Object.entries(doc)) {
    if (k === "agents") continue; // ロスターは別扱い
    source[k] = toEnvString(v);
  }
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

// 解決される設定ファイルパス（存在すれば）。--config > ERIS_CONFIG > eris.config.yaml >
// eris.config.example.yaml の順。
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
// これらはもう読まれない。設定は YAML（eris.config.yaml / --config）へ、ツール params は CLI フラグへ。
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
      ` 設定は eris.config.yaml / --config、ツール params は CLI フラグ（--regimes 等）で指定してください。\n`,
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
// --config > ERIS_CONFIG > eris.config.yaml > eris.config.example.yaml。いずれも無ければ
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
