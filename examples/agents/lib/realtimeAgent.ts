import { createInterface } from "node:readline";
import type { AgentObservation } from "../../../src/types.js";

// 実時間モードの free-run agent ヘルパ。
// coordinator は新ブロック毎に observation を push する。本ヘルパは最新 observation を保持し、
// 自前タイマー（intervalMs ごと、offsetMs だけ位相をずらせる）で decide() を呼び、返った action を
// stdout へ1行で出す。decide が null/undefined を返したら何も送らない（＝そのブロックは見送り）。
//
// 注: 同期モード（src/agentProcess.ts の request→response）とは異なり応答は待たれない。
// stream は request→response の上位互換なので、`rl.on("line") → 1行返す`型の既存 agent は
// そのままでも動く（毎ブロック1アクション）。本ヘルパはタイミング/レイテンシを戦略軸にしたい
// agent 向けに「ブロックと独立した送信タイミング」を与える。
export function runRealtimeAgent(opts: {
  intervalMs?: number;
  offsetMs?: number;
  decide: (obs: AgentObservation) => Record<string, unknown> | null | undefined;
}): void {
  const intervalMs = opts.intervalMs ?? 2200;
  const offsetMs = opts.offsetMs ?? 0;

  let latest: AgentObservation | null = null;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    try {
      latest = JSON.parse(trimmed) as AgentObservation;
    } catch {
      // パース失敗は無視
    }
  });

  const emit = (): void => {
    if (!latest) return; // 最初の observation を受け取るまで待つ
    const action = opts.decide(latest);
    if (action) process.stdout.write(`${JSON.stringify(action)}\n`);
  };

  setTimeout(() => {
    emit();
    setInterval(emit, intervalMs);
  }, offsetMs);
}
