/**
 * agentLog: エージェントが「自分の行動ログ」を残すための共有ヘルパー。
 *
 * coordinator が渡す環境変数から出力先を決め、各ラウンドの判断を
 * runs/<runId>/agents/<agentId>.jsonl に 1 行ずつ追記する。
 * strategy-evolve skill はこのログを一次情報として読み、「なぜその行動を取ったか」
 * （判断理由・シグナル・内部状態）から戦略改善の根本原因を特定する。
 *
 * 使い方（推奨: createEmitter）:
 *   import { createEmitter } from "./lib/agentLog.js";
 *   const emit = createEmitter();
 *   emit(action, { round, signals: { gap, fair, pool }, state });
 *   // emit は行動ログを残しつつ action JSON を stdout に書く（coordinator への応答）。
 *
 * 低レベル API（ログのみ・stdout に書かない）:
 *   const log = createAgentLog();
 *   log({ round, action, reason, signals, state });
 *
 * 環境変数:
 *   ERIS_RUN_DIR   出力先 run ディレクトリ（coordinator が AgentProcess に渡す）
 *   ERIS_AGENT_ID  エージェント識別子
 *
 * 注: coordinator 配下でない（ERIS_RUN_DIR 未設定の）場合はログは no-op（stdout 応答は出す）。
 *     ログ書込の失敗は戦略実行を止めない（握りつぶす）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { safeStringify } from "../../../src/logger.js";

export type AgentLogEntry = {
  round?: number;
  action?: unknown;
  reason?: string;
  signals?: Record<string, number | undefined>;
  sizing?: unknown;
  expectedPnlUsdc?: number;
  state?: Record<string, unknown>;
};

export type AgentLog = (entry: AgentLogEntry) => void;

// 1 ラウンド分のログメタ（action 以外）。emit に渡す。
export type EmitMeta = Omit<AgentLogEntry, "action" | "reason">;

export type Emit = (action: unknown, meta?: EmitMeta) => void;

export function createAgentLog(): AgentLog {
  const runDir = process.env.ERIS_RUN_DIR;
  const agentId = process.env.ERIS_AGENT_ID ?? "unknown";
  if (!runDir) return () => {}; // coordinator 配下でなければ何もしない

  const dir = join(runDir, "agents");
  const path = join(dir, `${agentId}.jsonl`);
  let ready = false;

  return (entry: AgentLogEntry): void => {
    try {
      if (!ready) {
        mkdirSync(dir, { recursive: true });
        ready = true;
      }
      const line = safeStringify({
        ts: new Date().toISOString(),
        agentId,
        ...entry,
      });
      appendFileSync(path, `${line}\n`);
    } catch {
      // ログ失敗は戦略実行に影響させない
    }
  };
}

function reasonOf(action: unknown): string | undefined {
  return action && typeof action === "object" && "reason" in action
    ? String((action as { reason?: unknown }).reason ?? "")
    : undefined;
}

// 行動ログを残しつつ action を stdout に書く統合ヘルパー。
// 各エージェントが個別に out/emit を手書きする代わりにこれを使う。
export function createEmitter(): Emit {
  const log = createAgentLog();
  return (action, meta) => {
    log({ action, reason: reasonOf(action), ...meta });
    process.stdout.write(`${safeStringify(action)}\n`);
  };
}
