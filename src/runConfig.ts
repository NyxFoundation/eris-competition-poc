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

// CLI/coordinator 用の入口。`--config <path>` を argv から拾い、YAML があれば YAML 駆動、
// 無ければ env フォールバック（移行期の後方互換）。
export function resolveRunInputs(
  argv: string[] = process.argv,
  overrides: Record<string, string | number | boolean> = {},
): {
  config: SimConfig;
  agents: AgentSpec[];
  configPath?: string;
} {
  const flagIdx = argv.indexOf("--config");
  const explicit =
    flagIdx >= 0 && argv[flagIdx + 1] ? argv[flagIdx + 1] : undefined;
  const envPath = process.env.ERIS_CONFIG;
  const path = explicit ?? envPath ?? DEFAULT_CONFIG_PATH;
  if (existsSync(path)) {
    const r = loadRunConfig(path, overrides);
    return { config: r.config, agents: r.agents, configPath: r.configPath };
  }
  if (explicit || envPath) throw new Error(`config file not found: ${path}`);
  // YAML 不在: 旧来の env 駆動にフォールバック（移行期）。overrides は env の上に重ねる。
  const source: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) source[k] = toEnvString(v);
  const config = loadConfig(source);
  return { config, agents: loadAgents(config.agentsConfigPath) };
}
