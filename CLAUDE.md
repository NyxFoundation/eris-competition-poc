# CLAUDE.md

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータ。

## 実行コマンド

- `npm run anvil` — 別ターミナルで Anvil フォークを起動（sim の前提）
- `npm run sim` — 1 回シミュレーション（`AGENTS_CONFIG` / `ROUNDS` / `SEED` / `ENABLED_PROTOCOLS` を env で指定）
- `npm run leaderboard` — sim を回して Sharpe→PnL でランキング（`runs/<id>/leaderboard.md`）
- `npm run evaluate` — 同一 config を **regime×N 回の実時間 run で反復**（`REGIMES` / `REPLICATIONS` / `ERIS_RUN_BLOCKS`）し、agent ごとの per-run サンプルと集計統計を JSON 出力（unpaired 統計ゲートのサンプル収集。ADR 0005）
- `npm run gate` — before/after の evaluate JSON を **unpaired 統計**（bootstrap CI / Welch / Mann-Whitney）で比較し受理判定（`GATE_MODE=improve|noninferior`。strategy-evolve の受理ゲート本体。ADR 0005 §3）
- `npm run discrimination` — 多様な戦略＋ベースラインを **regime×N 反復**で回し**識別力**（C1 実力報酬（bootstrap CI 有意性つき） / C2 順位安定（regime 間） / C3 Sharpe 非潰れ）を判定（`runs/<id>/discrimination.md` + JSON。ADR 0001 P1 / ADR 0005）
- `npm run typecheck` / `npm run test` — 型チェック / ユニットテスト

実時間化（ADR 0005）後の評価の前提: **SEED(=regime) は市場条件のラベル**で価格パスは再現可能だが、tx タイミング/着順は非決定 → 同一 regime でも結果はぶれる。だから評価は「同一 SEED の paired 比較」ではなく **N 回反復 + unpaired 統計**（`src/stats.ts` / `src/multiSeedRun.ts`）で行う。run 長は `ERIS_RUN_BLOCKS` 固定で揃える。

## アーキテクチャ（プロセス分離）

```
Anvil ノード（別プロセス）
   ⇅ RPC（coordinator のみ保持）
coordinator / オーケストレータ（src/coordinator.ts）
  ・RPC・fair price・state 読取・ordering・tx 提出・mine・flow ウォレットを所有
   ⇅ stdin/stdout 行 JSON
  ├── N 個の agent プロセス（examples/agents/*.ts、戦略ロジック）
  └── 1 個の flow-bot プロセス（examples/flow/market-maker.ts、市場メーカー）
```

- **agent / flow-bot は RPC に触れない**。observation/context を stdin で受け、action/order を stdout で返すだけ（`src/agentProcess.ts` / `src/flowProcess.ts`）。
- **orderflow は独立プロセス**。生成ロジックは `src/flow/logic.ts`（純粋関数）。bot は自前 `Rng(ERIS_FLOW_SEED)` で決定論的に動く → **同一 SEED = 同一市場**。coordinator は flow ウォレットと提出のみ担う。
- protocol アダプタ（`src/protocols/*.ts`）は `readState`/`observe`/`buildTxs`/`valueUsdc` 等を実装。**`buildFlow` は持たない**（flow bot に分離済み）。
- aave flow だけ flow ウォレットの reserve に依存するため、coordinator が `readAaveFlowReserves` で読んで FlowContext に渡す。

## エージェント行動ログ

各 agent は `examples/agents/lib/agentLog.ts` の `createAgentLog()` で
`runs/<runId>/agents/<agentId>.jsonl` に毎ラウンドの判断（`reason` / `signals` / `state`）を残す。
出力先は coordinator が渡す env `ERIS_RUN_DIR` / `ERIS_AGENT_ID` で決まる。strategy-evolve の診断はこれを一次情報にする。

## 2 つの自己改善スキル（対象が異なる）

- **`/sim-loop`** — シミュレータの**仕組み**（公平性・ordering・ガスモデル）を 1 課題ずつ改善。ログ: `runs/iterations/`
- **`/strategy-evolve`** — **トレード戦略**を 1 agent / 1 変更ずつ改善。`agents.evolve.json` の env を主に編集し、**複数 SEED の評価ゲート**（median 改善 + paired per-seed 非劣化 + win-rate）で過学習を抑制してから採用。ログ: `runs/strategy-iterations/`

`agents.evolve.json` は strategy-evolve の進化対象ロスター。skill 経由でのみ編集する（手で触らない）。`runs/` は gitignore。
