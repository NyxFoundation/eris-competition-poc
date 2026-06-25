# Eris Competition MVP

Anvil の **Arbitrum One** フォーク上で動く、ローカルなマルチプロトコル DeFi 戦略シミュレータ。エージェントには RPC アクセス・秘密鍵・pending トランザクション・txpool は一切渡さない。コーディネータは各エージェントに**確定済み状態の観測のみ**を与え、受理した JSON アクションをトランザクションへ変換する。

対応プロトコルはプロトコルアダプタレジストリ（`src/protocols/`）でプラガブル: **Uniswap V3 / Balancer v2 / Curve / Aave v3 / GMX v2**。run ごとに `ENABLED_PROTOCOLS`（カンマ区切り、例 `ENABLED_PROTOCOLS=uniswap,balancer,curve,aave,gmx`）で有効プロトコルを選ぶ。Aave v3 と GMX v2 の価格は、コーディネータが毎ラウンド外生的な fair price に追従させる制御可能なモックオラクルで駆動する。

## プロトコルとアクション

各アダプタ（`src/protocols/<name>.ts`）は parse / validation・calldata 構築・観測・orderflow・PnL を実装する。エージェントの JSON アクション:

| プロトコル | アクション | venue (Arbitrum) |
|---|---|---|
| Uniswap V3 | `swap`, `mintLiquidity`, `removeLiquidity`, `collectFees` | WETH/USDC 0.05% プール |
| Balancer v2 | `balancerSwap` | 33/33/34 WETH/USDC/USDT weighted プール（フォーク時に seed） |
| Curve | `curveSwap` | tricrypto WETH↔USDT |
| Aave v3 | `aaveSupply`, `aaveWithdraw`, `aaveBorrow`, `aaveRepay` | native USDC / WETH リザーブ |
| GMX v2 | `gmxIncrease`, `gmxDecrease` | ETH/USD perp market |

加えてプロトコル非依存の `noop` / `bundle`（複数の bundle 可能な leaf を 1 tx に）/ `rawTx` / `rawBundle` がある。

### ステーブルコイン会計

Arbitrum の深い WETH/stable 流動性は USDC.e / USDT プールにあるため、native USDC・USDC.e・USDT はすべて `$1`・6 桁の **USDC 相当**として残高・PnL を合算する（`src/chain.ts` の `setActiveStables` / `getBalances`）。Uniswap / Aave / GMX は native USDC、Balancer は native USDC（プールをフォーク時に seed）、Curve は USDT を使う。

### オラクル制御（Aave v3 / GMX v2）

モックオラクル（`contracts/MockAggregator.sol` / `contracts/MockOracleProvider.sol`）を setup でフォークにデプロイする。Aave はコーディネータが ACL admin を impersonate して `AaveOracle` をモックに向け、GMX は `ROLE_ADMIN` を impersonate して keeper / controller ロールを付与し `DataStore` にモックプロバイダを登録する。毎ラウンド `updateOracles` が fair price を両モックへ書き込み、貸借のヘルスファクタと perp のマーク価格が動く。

### GMX のラウンド構造

GMX は非同期（注文作成 → keeper 実行）。各ラウンドは 3 つのサブブロックで進む: (1) モック価格を更新する**オラクルブロック**、(2) agent / flow の注文が priority fee で競合する**競争ブロック**（`--order fees`）、(3) コーディネータが競争ブロックの `OrderCreated` ログを読んで各注文を実行する **keeper ブロック**。GMX のポジション変化はエージェントに 1 ラウンド遅れて見える。GMX アクションは単独のみ（bundle 不可）。

## セットアップ

```bash
npm install
cp .env.example .env.local
cp agents.local.example.json agents.local.json
```

`.env.local` に `ARB_RPC_URL`（Arbitrum One の RPC エンドポイント）を設定する。`FORK_BLOCK_NUMBER` は任意（既定は RPC の最新ブロック）。コマンド実行前に読み込むか、同じ変数をシェルで export する。

推奨のローカル既定値:

```bash
ANVIL_PORT=8545
ANVIL_RPC_URL=http://127.0.0.1:8545
CHAIN_ID=42161
ROUNDS=1
ENABLED_PROTOCOLS=uniswap
AGENTS_CONFIG=agents.local.json
REPORT_DIR=./runs
```

モックオラクルのコントラクトをビルドする（Aave v3 / GMX v2 を有効化する場合に必要。Foundry が要る）。`npm run sim` は `presim` フックでこれを自動実行する:

```bash
npm run build:contracts
```

秘密鍵の変数はローカル Anvil run では空でよい（コーディネータが Anvil の既定 dev キーにフォールバックする）。コーディネータは専用の `admin`（モックをデプロイし GMX `CONTROLLER` / Aave `POOL_ADMIN` を保持）と `keeper`（GMX 注文 keeper）アカウントも導出する。`ADMIN_PRIVATE_KEY` / `KEEPER_PRIVATE_KEY` で上書き可能。

## スモークテスト

ターミナル 1:

```bash
set -a
source .env.local
set +a
npm run anvil
```

ターミナル 2:

```bash
set -a
source .env.local
set +a
export ROUNDS=1 ENABLED_PROTOCOLS=uniswap
npm run sim
```

出力は `runs/<run_id>/` 下に書かれる。確認できること:

- 全 agent と flow ウォレットのセットアップが完了する。
- WETH deposit・トークン approve・初回の WETH → USDC swap が完了する。
- 1 ラウンドで flow トランザクションと有効な agent トランザクションが提出される。
- `anvil_mine` が提出済み tx の receipt を生成する。
- run ディレクトリ下に `events.jsonl` / `blocks.csv` / `summary.json` / `history.json` が書かれる。

## 出力チェック

`summary.json` で各 agent の最終残高・net PnL・gas 使用量・revert 数・提出/included tx 数を確認する。

`blocks.csv` で Anvil の fee 順序を確認する:

```bash
npm run check:ordering -- runs/<run_id>
```

`events.jsonl` で `tx_submit_failed` / `tx_receipt_failed` / `action_rejected` / `revert` / `timeout` を確認する。tx 単位の提出・receipt 失敗はログに残してスキップするため、1 本の不正な tx が run 全体を止めない。

## フル run

スモークテストが通ったら、マルチプロトコルのシミュレーションを回す。`agents.multi.json` は venue を跨ぐ agent 群（cross-venue arb / Aave レバレッジ / GMX long / Uniswap fee bidder）を含む:

```bash
set -a
source .env.local
set +a
export ROUNDS=20 ENABLED_PROTOCOLS=uniswap,balancer,curve,aave,gmx AGENTS_CONFIG=agents.multi.json
npm run sim
```

`summary.json` は agent ごとの `protocolValuesUsdc`（Uniswap LP 価値・GMX ポジション equity・Aave net collateral−debt）とベースウォレット価値を報告し、`finalValueUsdc` / `netPnlUsdc` に合算する。GMX / Aave run はラウンドあたり ~3 ブロックを使い、`check:ordering` が検証する fee 順序付きの agent / flow swap は競争ブロックにのみ載る。

単一プロトコル設定の例: `agents.aave-test.json` / `agents.gmx-test.json`。

## ローカルリアルタイムシミュレーション（非fork）

Arbitrum を fork せず、隣接 repo `eris-app-deployer` がローカル anvil 上に全 protocol を deploy したものに poc が接続して realtime run を回すモード。fork backend への cold state RPC 往復（fork RPC レイテンシ）を避けられ、マルチアセット（WETH/WBTC）も動く。実時間 run（`sim:realtime`）を fork 無しで実行する。

### 前提

- 隣接 repo `../eris-app-deployer`（全 venue のローカルデプロイに対応したブランチ）が必要。
- poc 側は anvil を起動しない（deployer が anvil を所有する）。`ERIS_LOCAL_DEPLOY=1` のとき `npm run anvil` は fail-fast する。

### 手順

1. **deployer で anvil 起動 + 全 venue deploy**（別ターミナル推奨）:

   ```bash
   cd ../eris-app-deployer
   npm run deploy -- --keep-fresh
   ```

   - `--keep-fresh` は `deployments.json` を初期化してから deploy する。
   - `--exit` を**付けない**こと。付けると deploy 後に anvil を停止してしまう。付けなければ anvil は起動したまま `127.0.0.1:8545` で待機する。
   - 全 5 venue（Uniswap V3 / Balancer V2 / Aave V3 / Curve / GMX V2）＋共有トークン（WETH/USDC/USDT/DAI/WBTC）＋ Multicall3 を deploy する。完了まで数分（GMX が最も重い）。
   - 完了すると `../eris-app-deployer/deployments/deployments.json` が出力され、「anvil は起動したままです」と表示される。

2. **poc で `constants.local` を生成**（deploy アドレスを poc に取り込む）:

   ```bash
   npm run gen:local-constants
   ```

   `../eris-app-deployer/deployments/deployments.json` を読んで `src/constants.local.ts` を生成する（`DEPLOYMENTS_JSON` env でパス上書き可）。deploy は決定論アドレスなので、再生成しても差分は出ないことが多い。

3. **リアルタイム run を実行**（`ERIS_LOCAL_DEPLOY=1` で `127.0.0.1:8545` のローカルデプロイに接続）:

   ```bash
   ERIS_LOCAL_DEPLOY=1 \
   AGENTS_CONFIG=agents.local.json \
   SEED=1 \
   ERIS_RUN_BLOCKS=24 \
   ERIS_RUN_SECONDS=70 \
   ENABLED_PROTOCOLS=uniswap,balancer,curve \
   INITIAL_WETH_WEI=0 \
   npm run sim:realtime
   ```

### 主要な env

| 変数 | 説明 |
|---|---|
| `ERIS_LOCAL_DEPLOY=1` | ローカルデプロイ（非fork）モードを有効化。**必須** |
| `AGENTS_CONFIG` | エージェントロスター JSON。`agents.local.json`（noop / random / simple の 3 体）や `agents.multi-asset.json`（noop / venue-arb / multi-arb） |
| `SEED` | 市場条件のラベル（価格パス再現用） |
| `ERIS_RUN_BLOCKS` | run 長（ブロック数） |
| `ERIS_RUN_SECONDS` | 実時間の上限（24 ブロック ≒ 48 秒なので 70 程度を確保） |
| `ENABLED_PROTOCOLS` | 有効 venue（カンマ区切り。例 `uniswap,balancer,curve`） |
| `INITIAL_WETH_WEI=0` | USDC-only 配布（初期の方向性エクスポージャを排除する） |
| `FLOW_MAX_WBTC_SATS=50000000` | マルチアセット（WBTC）を取引させる場合に指定。WBTC の AMM flow を有効化して WBTC の価格乖離＝裁定機会を作る（既定 0 で WBTC flow off） |

> **注**: ローカルデプロイのアカウント 0（account0）は deployer のデプロイアカウントと重なり、残留残高で価値が歪む。ロスターは AGENT1 以降（account1+）を使うこと（`agents.local.json` / `agents.multi-asset.json` はそうなっている）。

### 出力

run ごとに `runs/<timestamp>/` が生成される:

- `summary.json` — agent ごとの initial / final value・netPnl・includedTxCount・revertCount、`valueSeries.failedReads`、`violations`。
- `agents/<id>.jsonl` — 各 agent の自己申告ログ（direct モードでは mempool 活動 `kind:"mempool"`: submitted / submit_failed / rejected。WBTC 等の market 取引は `base` フィールドで判別できる）。
- `events.jsonl` / `blocks.csv` — イベント列とブロックごとの tx 記録。

### トラブルシュート

- **接続できない**: deployer の `npm run deploy -- --keep-fresh` が起動中か（`--exit` を付けていないか）確認する。
- **アドレス不一致 / コントラクトが無い**: deploy 後に `npm run gen:local-constants` を再実行したか確認する。
- **run が価格窓に到達せず早期終了する**: `ERIS_RUN_SECONDS` を十分大きくする。

## LLM 駆動の自律エージェント

`examples/agents/claude-llm.ts` は、戦略を実行時に LLM が生成・改訂するエージェント。手書きのトレードロジックは無く、モデルが自然言語のプランと、毎ラウンド `vm.Script` サンドボックスで動く TypeScript の executor 関数の両方を書く。

### アーキテクチャ

- **遅い層（LLM API/CLI）**: 起動時に 1 度呼んで初期戦略を設計し、その後 `ERIS_LLM_REVIEW_EVERY` ラウンドごと（既定 10）、または実現 PnL が開始時 USD の `1 - ERIS_LLM_DRAWDOWN_RATIO`（既定 5%）を下回ったときに再度呼ぶ。呼び出しはバックグラウンドで走り、ラウンド応答をブロックしない。
- **速い層（vm.Script）**: 毎ラウンド、現在の executor 本体を観測に対して 200ms タイムアウトで評価する。戦略が未準備（init 進行中の最初の ~10 秒）や executor が throw / 無効アクションを返した場合、そのラウンドは `noop` を出して継続する。
- 戦略は `runs/<run_id>/agent-<id>/strategy-vN.{md,params.json,executor.ts}` に書き出され、モデルの判断を読める。ラウンドごとの判断と API 呼び出しのテレメトリは同ディレクトリの `decisions.jsonl` / `claude-calls.jsonl` に残る。

### バックエンド

`ERIS_LLM_AUTH` で利用するトランスポートを選ぶ。`auto`（既定）は利用可能な最良を選び、認証情報が無くてもクラッシュしない。

| モード | 認証 | 使う場面 |
|---|---|---|
| `cli` | Claude Pro/Max OAuth（`claude -p`） | ローカルのサブスクリプション run |
| `codex` | Codex CLI 認証（`codex exec`） | 別 API プールでの並列実行 |
| `ollama` | `OLLAMA_API_KEY` または `ERIS_OLLAMA_API_KEY` | Ollama Cloud API（`https://ollama.com/api/chat`）を直接呼ぶ |
| `subscription` | Claude Pro/Max OAuth（Claude Code CLI 経由） | `claude` をインストール済み・ログイン済み |
| `apikey` | `ANTHROPIC_API_KEY` | CI / 並列 sim run / 課金を明示したいとき |
| `mock` | なし | オフラインのスモークテスト（常に noop 戦略を返す） |
| `auto` *(既定)* | `cli` → `apikey` → `ollama` → `mock` を順に試す | 利用可能な認証が状況で変わるローカル開発 |

### 実行（subscription、API キー不要）

```bash
# 一度ログインしておくこと: `claude auth login`（Pro/Max プランを使う）
set -a
source .env.local
set +a
AGENTS_CONFIG=agents.claude-llm.json npm run sim
```

`auto` は PATH 上の `claude` バイナリを検出し Claude Agent SDK 経由でルーティングする。stderr に `[claude-llm] strategist=subscription (auto-detected Claude Code OAuth)` が出る。

### 実行（API キー）

```bash
export ANTHROPIC_API_KEY=sk-ant-...
AGENTS_CONFIG=agents.claude-llm.json ERIS_LLM_AUTH=apikey npm run sim
```

LLM 呼び出しは非同期で `requestAction` を止めないため、`AGENT_TIMEOUT_MS` は既定 5000ms で実用上問題ない。

### 実行（Ollama Cloud API）

ローカルの `localhost:11434` ではなく Ollama の Cloud API エンドポイントを使う。モデル名は通常の id（例 `gpt-oss:120b`、ローカルの `-cloud` エイリアスではない）。

```bash
export OLLAMA_API_KEY=ollama-...
AGENTS_CONFIG=agents.claude-llm.json \
  ERIS_LLM_AUTH=ollama \
  ERIS_LLM_MODEL=gpt-oss:120b \
  npm run sim
```

任意の上書き:

```bash
export ERIS_OLLAMA_BASE_URL=https://ollama.com/api
export ERIS_OLLAMA_MODEL=gpt-oss:120b
export ERIS_OLLAMA_MAX_RETRIES=3
```

### オフラインモック

`ERIS_LLM_MOCK=1`（または `ERIS_LLM_AUTH=mock`）で LLM を完全にスキップし、固定の noop 戦略を使う。認証もトークン消費も無しでハーネスをスモークテストするのに便利:

```bash
AGENTS_CONFIG=agents.claude-llm.json ERIS_LLM_MOCK=1 npm run sim
```

### チューニング

環境変数（親シェルで設定する。`agentProcess.ts` が `ANTHROPIC_API_KEY` と任意の `ERIS_LLM_*` を子プロセスへ転送する）:

| 変数 | 既定 | 効果 |
|---|---|---|
| `ERIS_LLM_AUTH` | `auto` | `cli` \| `codex` \| `ollama` \| `subscription` \| `apikey` \| `mock` \| `auto`（上のバックエンド表を参照） |
| `ERIS_LLM_MODEL` | バックエンド依存 | モデルのエイリアス / id。Ollama の既定は `gpt-oss:120b` |
| `OLLAMA_API_KEY` / `ERIS_OLLAMA_API_KEY` | 未設定 | `ERIS_LLM_AUTH=ollama` の Bearer トークン |
| `ERIS_OLLAMA_BASE_URL` | `https://ollama.com/api` | Ollama Cloud API のベース URL |
| `ERIS_OLLAMA_MAX_RETRIES` | `3` | Ollama の `429` / 一時的な `5xx` に対するリトライ回数 |
| `ERIS_LLM_REVIEW_EVERY` | `10` | 定期改訂の間隔（ラウンド数） |
| `ERIS_LLM_DRAWDOWN_RATIO` | `0.05` | 臨時改訂をトリガーする PnL 下落率 |
| `ERIS_LLM_HISTORY_CAPACITY` | `30` | 改訂プロンプトに含める直近ラウンド数 |
| `ERIS_LLM_EXECUTOR_TIMEOUT_MS` | `200` | ラウンドあたり executor 実行のハードキャップ |
| `ERIS_LLM_MOCK` | 未設定 | `1` でオフラインモック戦略を強制（`ERIS_LLM_AUTH=mock` のエイリアス） |
