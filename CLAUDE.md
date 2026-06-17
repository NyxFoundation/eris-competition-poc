# CLAUDE.md

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータ。

## 実行コマンド

- `npm run anvil` — 別ターミナルで Anvil フォークを起動（sim の前提）
- `npm run sim:realtime` — 実時間 run を 1 回実行（`AGENTS_CONFIG` / `SEED` / `ERIS_RUN_BLOCKS` / `ENABLED_PROTOCOLS` を env で指定）
- `npm run sim` — **deprecated**（同期ラウンド方式。realtime 一本化 = ADR 0006 の前提整理。評価には使わない）
- `npm run leaderboard` — **deprecated**（同期 sim 依存。ランキングは `evaluate` / `discrimination` で）
- `npm run evaluate` — 同一 config を **regime×N 回の実時間 run で反復**（`REGIMES` / `REPLICATIONS` / `ERIS_RUN_BLOCKS`）し、agent ごとの per-run サンプルと集計統計を JSON 出力（unpaired 統計ゲートのサンプル収集。ADR 0005）
- `npm run gate` — before/after の evaluate JSON を **unpaired 統計**（bootstrap CI / Welch / Mann-Whitney）で比較し受理判定（`GATE_MODE=improve|noninferior`。strategy-evolve の受理ゲート本体。ADR 0005 §3）
- `npm run discrimination` — 多様な戦略＋ベースラインを **regime×N 反復**で回し**識別力**（C1 実力報酬（bootstrap CI 有意性つき） / C2 順位安定（regime 間） / C3 Sharpe 非潰れ）を判定（`runs/<id>/discrimination.md` + JSON。ADR 0001 P1 / ADR 0005）
- `npm run typecheck` / `npm run test` — 型チェック / ユニットテスト

実時間化（ADR 0005）後の評価の前提: **SEED(=regime) は市場条件のラベル**で価格パスは再現可能だが、tx タイミング/着順は非決定 → 同一 regime でも結果はぶれる。だから評価は「同一 SEED の paired 比較」ではなく **N 回反復 + unpaired 統計**（`src/stats.ts` / `src/multiSeedRun.ts`）で行う。run 長は `ERIS_RUN_BLOCKS` 固定で揃える。

## アーキテクチャ（環境とエージェント実行の分離。ADR 0006）

```
環境プロセス（src/realtime/coordinator.ts = 環境デーモン + 採点者）   agent プロセス × N（完全独立）
  ・anvil ライフサイクル（fork/setup/interval mining）                ・env で受領: RPC URL / 自分の秘密鍵 /
  ・fair price 生成(Rng(seed)) → PriceFeed/oracle 更新 tx を毎ブロック書込   PriceFeed アドレス / runId・ログ出力先
  ・flow bot 注文の relay 送信（市場を動かす）                        ・自分のペースでブロック購読・state 読取
  ・GMX keeper（注文執行）                                           ・自分で署名し直接送信（nonce 自己管理）
  ・採点: run 後に歴史ブロック読取で価値系列を一括再構成               ・runs/<id>/agents/<id>.jsonl へ自己申告ログ
         └──────────── 同じ mempool。ブロック内順序は anvil --order fees ────────────┘
```

- **direct モードが既定**（`ERIS_AGENT_DIRECT_TX=0` で旧 relay 方式へロールバック。run 単位で全 agent 一律）。
  既存戦略は `examples/agents/lib/directShim.ts`（互換シム。spawn 時に `--import` 注入）が stdin/stdout を
  「チェーン読み書き」へ差し替えるため**無改修で動く**。
- **fair price はオンチェーン配布**（`contracts/PriceFeed.sol` + `src/realtime/priceFeed.ts`）。stdin push は廃止。
  書込 tx は次ブロック着弾なので情報は 1 ブロック遅れる（全員等しく作用。仕様）。
- **採点は run 後再構成**（`src/realtime/reconstruct.ts`）: blockNumber 指定の Multicall3 で全 agent 同一断面の
  価値系列を events.jsonl に observation 形で書く → `evaluate`/`gate`/`discrimination` は無改修。
  resetFork で歴史が消えるため**次 run の前に必ず再構成を終える**（anvil の保持深度 ~1,050 ブロックに注意）。
- **ルール執行は事後検出**（`src/postRunCheck.ts`）: blocks.csv（fee はチェーン上の tx フィールド由来）から
  fee 上限超過を検査。違反 run は evaluate が無効化して自動再実行。入口側は `npm run check:strategy`
  （cheatcode 静的検査）を strategy-evolve のゲートで通す。
- **orderflow は独立プロセス**（relay のまま = 環境側の市場機構）。生成ロジックは `src/flow/logic.ts`（純粋関数）。
  bot は自前 `Rng(ERIS_FLOW_SEED)` で決定論的に動く。aave flow の reserve は環境が `readAaveFlowReserves` で読んで渡す。
- protocol アダプタ（`src/protocols/*.ts`）は `readState`/`observe`/`buildTxs`/`valueUsdc` 等を実装。
  互換シムも同じアダプタを agent 側プロセスで再利用する。

## エージェント行動ログ

各 agent は `examples/agents/lib/agentLog.ts` の `createAgentLog()` で
`runs/<runId>/agents/<agentId>.jsonl` に毎ラウンドの判断（`reason` / `signals` / `state`）を残す。
direct モードでは互換シムが同じファイルに mempool 活動（`kind:"mempool"`: submitted / submit_failed /
rejected）を自己申告で追記する（coordinator が submitted を数えられなくなる穴を塞ぐ。ADR 0006 §5）。
出力先は coordinator が渡す env `ERIS_RUN_DIR` / `ERIS_AGENT_ID` で決まる。strategy-evolve の診断はこれを一次情報にする。

## 2 つの自己改善スキル（対象が異なる）

- **`/sim-loop`** — シミュレータの**仕組み**（公平性・ordering・ガスモデル）を 1 課題ずつ改善。ログ: `runs/iterations/`
- **`/strategy-evolve`** — **トレード戦略**を 1 agent / 1 変更ずつ改善。`agents.evolve.json` の env を主に編集し、**複数 SEED の評価ゲート**（median 改善 + paired per-seed 非劣化 + win-rate）で過学習を抑制してから採用。ログ: `runs/strategy-iterations/`

`agents.evolve.json` は strategy-evolve の進化対象ロスター。skill 経由でのみ編集する（手で触らない）。`runs/` は gitignore。
