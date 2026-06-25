# CLAUDE.md

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータ。

## 設定（YAML 単一ソース。ADR 0013）

run の設定値とエージェントロスターは **`eris.config.yaml` 一本**で管理する（env からの設定読取は廃止）。
解決順は `--config <path>` > `ERIS_CONFIG` > `eris.config.yaml` > `eris.config.example.yaml`（committed 雛形 = zero-config 既定）。
キー名は内部設定キーと同一で型付きで書ける。**env に残るのは秘密情報（`.env.local`: RPC/鍵/API キー）・
agent IPC（`ERIS_AGENT_*`）・設定ファイル選択（`ERIS_CONFIG`）のみ**。評価ツールのパラメータは YAML の
`evaluate:` / `discrimination:` / `gate:` セクション、または CLI フラグ（`--regimes` / `--mode=improve` 等）。
詳細は `src/runConfig.ts`。

## 実行コマンド

- `npm run anvil` — 別ターミナルで Anvil フォークを起動（sim の前提）
- `npm run sim:realtime` — 実時間 run を 1 回実行（設定は `eris.config.yaml`。`--config <path>` で別ファイル）
- `npm run sim` — **deprecated**（同期ラウンド方式。realtime 一本化 = ADR 0006 の前提整理。評価には使わない）
- `npm run leaderboard` — **deprecated**（同期 sim 依存。ランキングは `evaluate` / `discrimination` で）
- `npm run evaluate` — 同一 config を **regime×N 回の実時間 run で反復**し agent ごとの per-run サンプルと集計統計を JSON 出力（YAML `evaluate:` セクション or `--regimes`/`--replications`。run 長は YAML の `ERIS_RUN_BLOCKS`。unpaired 統計ゲートのサンプル収集。ADR 0005）
- `npm run gate` — before/after の evaluate JSON を **unpaired 統計**（bootstrap CI / Welch / Mann-Whitney）で比較し受理判定（`--mode=improve|noninferior` or YAML `gate:` セクション。strategy-evolve の受理ゲート本体。ADR 0005 §3）
- `npm run discrimination` — 多様な戦略＋ベースラインを **regime×N 反復**で回し**識別力**（C1 実力報酬（bootstrap CI 有意性つき） / C2 順位安定（regime 間） / C3 Sharpe 非潰れ）を判定（YAML `discrimination:` セクション or CLI フラグ。`runs/<id>/discrimination.md` + JSON。ADR 0001 P1 / ADR 0005）
- `npm run dashboard` — **リアルタイム可視化ダッシュボード**（読取専用の独立プロセス。`http://127.0.0.1:4317`）。"Agent Mesh" デザイン（ヘッダ統計 / 左=順位 standings / 中央=円環ノードの canvas mesh + CURRENT BLOCK + LATEST BLOCKS / 右=tx フィード + agent 詳細）で run 中の順位・活動・価格スプレッドをライブ観測（ADR 0008。フロントは 2026-06-20 に Agent Mesh へ刷新、データ層・SSE 契約は不変）。env: `DASH_PORT` / `DASH_POLL_EVERY`(ブロック) / `RUN_DIR`(明示) or 最新 run を追従 / `ANVIL_RPC_URL`(anvil 本体。接続不可なら tail のみの degrade)。単一 run 前提・tx は送らず採点に干渉しない
- `npm run stress-report` — 完了済み 1 run の **stress 評価軸**（ADR 0009 §5）を抽出（`runs/<id>/stress.md` + `stress.json`）。競技 agent の最大ドローダウン / イベント後 PnL / 生存、victim の HF<1・清算・検知遅延、liquidator の清算捕捉数（帰属は heuristic）。reconstruct のコアを無改修で再利用する読取専用ツール。`--run-dir <dir>`(明示) or 最新 run。**α 識別（discrimination C1/C2/C3）とは分離した別軸**（β 再注入が α 支配を壊すため混ぜない）
- `npm run typecheck` / `npm run test` — 型チェック / ユニットテスト

### 市場ストレスイベント（spike/crash + Aave 清算。ADR 0009。既定 off）

OU の base price はそのまま進め、その上に **SEED 由来でランダム化した決定論オーバーレイ**（`src/realtime/events.ts` `EventSchedule`）を重ねて effective price を導出する。effective が PriceFeed・Aave WETH オラクル・GMX・採点へ一貫伝播し、窓外では β≈0 を保つ（ADR 0007 を毀損しない）。清算を成立させる **seed 由来 victim 群**（採点対象外）を建てる。`eris.config.yaml` で指定（キー名は従来と同じ。値は YAML で型付き）:

- `ERIS_STRESS_EVENTS` — イベント配列（**値でなくレンジ**を与え過学習を抑制）。YAML では配列で書ける（例: `- { type: crash, magnitudeRange: [0.12, 0.16], windowFrac: [0.3, 0.7], rampBlocks: 3, holdBlocks: 6, decayBlocks: 8 }`）。`spike`/`crash` の台形（ramp→hold→decay）。要 `ERIS_RUN_BLOCKS>0`
- `ERIS_STRESS_VICTIM_COUNT`(既定 0=無効) / `ERIS_STRESS_VICTIM_HF0`(既定 1.10) / `ERIS_STRESS_VICTIM_WETH_WEI`(victim 1 体の supply)。**較正の連動**: 建てるには `HF0 ≳ LT/(0.97·LTV)`（実測 Arbitrum WETH の LT=0.84/LTV=0.80 で ≈1.08。これ未満は borrow が LTV 縁に張り付くため fail-fast）。割るには crash magnitude `m > (HF0−1)/HF0`（HF0=1.10 なら m>9.1% → 例の [0.12,0.16] で確実に割れる）。breach 不能な設定は `stress_calibration_warning` を emit。borrow がサイレント revert したら setup で fail-fast(debt 検証)
- **victim を建てるには full re-fork 必須**（`ARB_RPC_URL` 設定 + `ERIS_SKIP_RESET` 不可。未満は fail-fast。soft-reset だと前 run の victim ポジが残留して HF が壊れる）
- stress run（events かつ `ERIS_RUN_BLOCKS>0`）は**時間制限を自動無効化**しブロック数で終了する（`ERIS_RUN_SECONDS` が先に切れて crash 窓へ到達しない事故を回避。override は `stress_run_time_limit_disabled` で記録）
- coordinator は `stress_schedule` / `stress_victim_hf` / `stress_liquidation` を events.jsonl へ emit（dashboard 帯表示の元データ。SSE 契約は不変）。liquidator agent には victim アドレスを `ERIS_LIQUIDATION_VICTIMS` で配布する。`stress-report` の liquidator 帰属は agent ログの `liquidationCall`(rawTx) を一次情報にする（ログ無しは清算ブロックの success tx で近似 = `block-heuristic`）

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
- **`/strategy-evolve`** — **トレード戦略**を 1 agent / 1 変更ずつ改善。ロスター `agents.evolve.json`（`--agents` で渡す）の対象 agent の `env`（= 戦略パラメータ。agent プロセスへ渡す値で sim 設定とは別物）を主に編集し、**複数 SEED の評価ゲート**（median 改善 + paired per-seed 非劣化 + win-rate）で過学習を抑制してから採用。ログ: `runs/strategy-iterations/`

`agents.evolve.json` は strategy-evolve の進化対象ロスター。skill 経由でのみ編集する（手で触らない）。run の反復条件は CLI フラグ（`--regimes` / `--replications` / `--blocks`）で渡す。`runs/` は gitignore。

## spot EC2 で重い run を回す（ローカル逼迫の回避。`infra/spot/`）

ローカルの CPU/メモリが逼迫するときは、**golden AMI の spot EC2** に run を投げる。ローカルデプロイ前提（fork 不要）で
自己完結し、外部依存は LLM(ollama) egress のみ。全 protocol を deploy 済みの anvil state を AMI に焼いてあり、
launch 時は `anvil --load-state` で全 5 venue を ~10 秒復元 → install/deploy なしで run（起動 ~3 分・full venue + LLM が安定 green）。
SSH 一本で結果を手元に回収（S3/IAM ロール不要）。AWS は `eris` profile（account `075096050160`）固定。詳細は `infra/spot/README.md`、設計と学びは memory `spot-ec2-runner`。

- **`/spot-run`** — golden AMI で run を回し結果を回収（日常ドライバ）。`ERIS_SPOT_AMI=latest` で最新 AMI 自動解決。
- **`/spot-bake`** — 新しい golden AMI を焼く（poc 依存追加 / deployer・constants 変更時。agent config だけなら不要）。~35 分。
- **`/spot-ops`** — 初回セットアップ（鍵 + SG + IAM）/ 状態確認 / 掃除（残骸インスタンス・古い AMI・IP 再許可）。
