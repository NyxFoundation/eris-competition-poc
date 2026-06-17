import { runSimulation } from "../coordinator.js";

// ADR 0006 実装順序の前提: realtime 一本化に伴い同期ラウンド方式は deprecated。
console.error(
  "[deprecated] `npm run sim`（同期ラウンド方式）は realtime 一本化（ADR 0006）に伴い非推奨です。" +
    "評価は `npm run evaluate`（実時間 run の regime×N 反復）を使ってください。",
);

runSimulation().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
