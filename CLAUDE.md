# CLAUDE.md

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータ。

## 設定（YAML 単一ソース。ADR 0013）

run の設定値とエージェントロスターは **`config/local.yaml` 一本**で管理する（env からの設定読取は廃止）。
解決順は `--config <path>` > `ERIS_CONFIG` > `config/local.yaml` > `config/example.yaml`（committed 雛形 = zero-config 既定）。
キーは**ネスト lowercase**（`run` / `funding` / `limits` / `flow` / `stress` + `agents`。例 `run.protocols` /
`funding.wethWei`）で `src/runConfig.ts` の `SCHEMA` が内部キーへ写す（全大文字 env 名を表に出さない）。
**env に残るのは秘密情報（`.env.local`: RPC/鍵/API キー）・agent IPC（`ERIS_AGENT_*`）・設定ファイル選択
（`ERIS_CONFIG`）のみ**。run ノブは CLI フラグ（`--seed` / `--blocks` / `--protocols` / `--agents` 等）で
一回限り上書きできる。各 agent の `env`（`ERIS_LLM_*` 等）は agent プロセスへ渡す戦略パラメータで `agents[].env` に書く。

## 実行コマンド

- `npm run anvil` — 別ターミナルで Anvil フォークを起動（sim:realtime の前提。ローカルデプロイモードでは不要）
- `npm run sim:realtime` — 実時間 run を 1 回実行（設定は `config/local.yaml`。`--config <path>` で別ファイル、`--seed`/`--blocks`/`--protocols`/`--agents` 等で一回上書き）
- `npm run build:contracts` — モックオラクル + PriceFeed を forge build（sim:realtime の前提。`out/` 未生成なら最低 1 回）
- `npm run gen:local-constants` — deployments.json → `src/constants.local.ts` 生成（同梱 `deployer/` のローカルデプロイ出力を読む）
- `npm run typecheck` / `npm run test` — 型チェック / ユニットテスト

> **deployer は本 repo 同梱**（`deployer/`。旧 `../eris-app-deployer` を統合）。全 protocol を空の anvil へ deploy する自己完結のサブパッケージ（独自の `package.json` / `foundry.toml`）。初回のみ `cd deployer && npm install && forge build && cp .env.example .env && ./scripts/setup-vendors.sh`。以降は `cd deployer && npm run deploy -- --keep-fresh` で anvil 起動＋全 venue deploy。`vendor/` の重いクローン（gmx-src/curve-src/twocrypto-src）は git 管理外で `setup-vendors.sh` が再現する。

> 評価・採点・可視化系コマンド（`sim` 同期ラウンド / `evaluate` / `gate` / `discrimination` / `leaderboard` / `dashboard` / `stress-report`）は撤去済み。run は `sim:realtime` 一本。run 後の解析は `runs/<id>/` の `summary.json` / `events.jsonl` / `blocks.csv` を直接読む。

### 市場ストレスイベント（spike/crash + Aave 清算。ADR 0009。既定 off）

OU の base price はそのまま進め、その上に **SEED 由来でランダム化した決定論オーバーレイ**（`src/realtime/events.ts` `EventSchedule`）を重ねて effective price を導出する。effective が PriceFeed・Aave WETH オラクル・GMX・採点へ一貫伝播し、窓外では β≈0 を保つ（ADR 0007 を毀損しない）。清算を成立させる **seed 由来 victim 群**（採点対象外）を建てる。`config/local.yaml` の `stress:` セクションで指定:

- `stress.events` — イベント配列（**値でなくレンジ**を与え過学習を抑制）。YAML 配列で書ける（例: `- { type: crash, magnitudeRange: [0.12, 0.16], windowFrac: [0.3, 0.7], rampBlocks: 3, holdBlocks: 6, decayBlocks: 8 }`）。`spike`/`crash` の台形（ramp→hold→decay）。要 `run.blocks>0`
- `stress.victimCount`(既定 0=無効) / `stress.victimHf0`(既定 1.10) / `stress.victimWethWei`(victim 1 体の supply)。**較正の連動**: 建てるには `HF0 ≳ LT/(0.97·LTV)`（実測 Arbitrum WETH の LT=0.84/LTV=0.80 で ≈1.08。これ未満は borrow が LTV 縁に張り付くため fail-fast）。割るには crash magnitude `m > (HF0−1)/HF0`（HF0=1.10 なら m>9.1% → 例の [0.12,0.16] で確実に割れる）。breach 不能な設定は `stress_calibration_warning` を emit。borrow がサイレント revert したら setup で fail-fast(debt 検証)
- **victim を建てるには full re-fork 必須**（`ARB_RPC_URL` 設定 + `ERIS_SKIP_RESET` 不可。未満は fail-fast。soft-reset だと前 run の victim ポジが残留して HF が壊れる）
- stress run（events かつ `ERIS_RUN_BLOCKS>0`）は**時間制限を自動無効化**しブロック数で終了する（`ERIS_RUN_SECONDS` が先に切れて crash 窓へ到達しない事故を回避。override は `stress_run_time_limit_disabled` で記録）
- coordinator は `stress_schedule` / `stress_victim_hf` / `stress_liquidation` を events.jsonl へ emit する。liquidator agent には victim アドレスを `ERIS_LIQUIDATION_VICTIMS` で配布する。清算の帰属は agent ログの `liquidationCall`(rawTx) を一次情報にする（events.jsonl を直接読んで解析する。旧 stress-report ツールは撤去済み）

実時間化（ADR 0005）の前提: **SEED(=regime) は市場条件のラベル**で価格パスは再現可能だが、tx タイミング/着順は非決定 → 同一 regime でも結果はぶれる。run 長は `ERIS_RUN_BLOCKS` 固定で揃える。run の比較が要るときは同一 config を複数回回してサンプルを貯め、`runs/<id>/summary.json` を集計する（旧 evaluate/gate は撤去済み）。

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
  価値系列を events.jsonl に observation 形で書く（`runs/<id>/summary.json` に集計）。
  resetFork で歴史が消えるため**次 run の前に必ず再構成を終える**（anvil の保持深度 ~1,050 ブロックに注意）。
- **ルール執行は事後検出**（`src/postRunCheck.ts`）: blocks.csv（fee はチェーン上の tx フィールド由来）から
  fee 上限超過を検査し違反 run を `violations` に記録。入口側は `npm run check:strategy`
  （cheatcode 静的検査）で戦略コードを通す。
- **orderflow は独立プロセス**（relay のまま = 環境側の市場機構）。生成ロジックは `src/flow/logic.ts`（純粋関数）。
  bot は自前 `Rng(ERIS_FLOW_SEED)` で決定論的に動く。aave flow の reserve は環境が `readAaveFlowReserves` で読んで渡す。
- protocol アダプタ（`src/protocols/*.ts`）は `readState`/`observe`/`buildTxs`/`valueUsdc` 等を実装。
  互換シムも同じアダプタを agent 側プロセスで再利用する。

## エージェント行動ログ

各 agent は `examples/agents/lib/agentLog.ts` の `createAgentLog()` で
`runs/<runId>/agents/<agentId>.jsonl` に毎ラウンドの判断（`reason` / `signals` / `state`）を残す。
direct モードでは互換シムが同じファイルに mempool 活動（`kind:"mempool"`: submitted / submit_failed /
rejected）を自己申告で追記する（coordinator が submitted を数えられなくなる穴を塞ぐ。ADR 0006 §5）。
出力先は coordinator が渡す env `ERIS_RUN_DIR` / `ERIS_AGENT_ID` で決まる。run 後の診断はこれを一次情報にする。

## spot EC2 で重い run を回す（ローカル逼迫の回避。spot skills）

ローカルの CPU/メモリが逼迫するときは、**golden AMI の spot EC2** に run を投げる。ローカルデプロイ前提（fork 不要）で
自己完結し、外部依存は LLM(ollama) egress のみ。全 protocol を deploy 済みの anvil state を AMI に焼いてあり、
launch 時は `anvil --load-state` で全 5 venue を ~10 秒復元 → install/deploy なしで run（起動 ~3 分・full venue + LLM が安定 green）。
SSH 一本で結果を手元に回収（S3/IAM ロール不要）。AWS は `eris` profile（account `075096050160`）固定。スクリプトは
user-global の spot skills（`~/.claude/skills/spot-{run,bake,ops}/scripts/`）に同梱（repo の `infra/spot/` から移設）。
poc repo ルートで叩く（スクリプトは `$PWD` を poc とみなす。別パスは `ERIS_POC_DIR`）。設計と学びは memory `spot-ec2-runner`。

- **`/spot-run`** — golden AMI で run を回し結果を回収（日常ドライバ）。`ERIS_SPOT_AMI=latest` で最新 AMI 自動解決。
- **`/spot-bake`** — 新しい golden AMI を焼く（poc 依存追加 / deployer・constants 変更時。agent config だけなら不要）。~35 分。
- **`/spot-ops`** — 初回セットアップ（鍵 + SG + IAM）/ 状態確認 / 掃除（残骸インスタンス・古い AMI・IP 再許可）。
