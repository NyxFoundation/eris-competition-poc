<p align="center">
  <img src="docs/eris-logo.png" alt="Eris" width="360">
</p>

<h1 align="center">Eris — Competition MVP</h1>

<p align="center">
  <strong>The Agentic Financial Simulation Layer</strong><br>
  <em>Let your contracts face the swarm.</em>
</p>

<p align="center">
  <a href="https://erisnet.xyz/">erisnet.xyz</a> &nbsp;·&nbsp;
  <a href="#クイックスタートローカルデプロイモード非fork">クイックスタート</a> &nbsp;·&nbsp;
  <a href="#ドキュメント">ドキュメント</a>
</p>

<p align="center">
  <img alt="status" src="https://img.shields.io/badge/status-MVP%2FPoC-orange">
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white">
  <img alt="node" src="https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white">
  <img alt="foundry" src="https://img.shields.io/badge/contracts-Foundry-black">
</p>

<!-- GitHub README は iframe を描画しないため、YouTube サムネ画像をリンクにする（クリックで再生）。 -->

<p align="center">
  <a href="https://youtu.be/7ulkvodT-bA">
    <img src="https://img.youtube.com/vi/7ulkvodT-bA/maxresdefault.jpg" alt="Eris デモ動画" width="640">
  </a>
</p>

> **Markets ship behavior.** 監査の箇条書きではなく、敵対的なマーケットフローのなかで AMM の弱点・清算経路・オラクル遅延を実際の振る舞いとして surface させる。これは [erisnet.xyz](https://erisnet.xyz/) が掲げる *Agentic Financial Simulation Layer* の、ローカルで動く**競争シミュレータ MVP**（Proof of Concept）。

ローカル anvil 上に全 protocol を deploy したマルチプロトコル DeFi 環境で動く戦略シミュレータ。複数の自律エージェントが同じ mempool で互いに競い、コーディネータが市場を駆動して run 後に価値系列を再構成・採点する。エージェントには RPC・秘密鍵・pending トランザクション・txpool を一切渡さず、**確定済み状態の観測のみ**を与える。

---

## これは何か

- **マルチプロトコル DeFi 環境** — Uniswap V3 / Balancer v2 / Curve / Aave v3 / GMX v2 を 1 つの Anvil 上に揃え、プロトコルアダプタレジストリ（`src/protocols/`）でプラガブルに有効化する。
- **多エージェント競争** — エージェントは完全独立プロセスとして自分のペースでブロックを購読し、自分で署名して直接送信する。ブロック内順序は anvil `--order fees`（priority fee 降順）で決まる。
- **制御可能な fair price** — コーディネータが SEED 由来の決定論的な fair price を毎ブロック生成し、オンチェーンの `PriceFeed` とモックオラクルへ書き込む。Aave のヘルスファクタや GMX のマーク価格がこれに追従する。
- **市場ストレス & 清算** — 価格スパイク／クラッシュを注入し、Aave 清算経路を誘発できる。
- **LLM 駆動の自律エージェント** — 戦略を実行時に LLM が生成・改訂する（手書きのトレードロジック無し）。
- **fork 無しのローカルデプロイモード** — fork backend への cold state RPC 往復（fork RPC レイテンシ）を避け、マルチアセット（WETH/WBTC）も動く。

## アーキテクチャ（環境とエージェント実行の分離）

```
環境プロセス（src/realtime/coordinator.ts = 環境デーモン + 採点者）   agent プロセス × N（完全独立）
  ・anvil ライフサイクル（setup/interval mining）                    ・env で受領: RPC URL / 自分の秘密鍵 /
  ・fair price 生成(Rng(seed)) → PriceFeed/oracle を毎ブロック更新       PriceFeed アドレス / runId・ログ出力先
  ・flow bot 注文の relay 送信（市場を動かす）                        ・自分のペースでブロック購読・state 読取
  ・GMX keeper（注文執行）                                           ・自分で署名し直接送信（nonce 自己管理）
  ・採点: run 後に歴史ブロック読取で価値系列を一括再構成               ・runs/<id>/agents/<id>.jsonl へ自己申告ログ
         └──────────── 同じ mempool。ブロック内順序は anvil --order fees ────────────┘
```

- **fair price はオンチェーン配布**（`contracts/PriceFeed.sol` + `src/realtime/priceFeed.ts`）。書込 tx は次ブロック着弾なので情報は全員等しく 1 ブロック遅れる（仕様）。
- **採点は run 後再構成**（`src/realtime/reconstruct.ts`）— blockNumber 指定の Multicall3 で全 agent 同一断面の価値系列を `events.jsonl` に書き、`runs/<id>/summary.json` に集計する。
- **ルール執行は事後検出**（`src/postRunCheck.ts`）— `blocks.csv` から fee 上限超過等を検査し違反 run を `violations` に記録する。

---

## クイックスタート（ローカルデプロイモード・非fork）

Arbitrum を fork せず、本 repo 同梱の [`deployer/`](deployer/) がローカル anvil 上に全 protocol を deploy したものに接続する。fork RPC レイテンシを避けられ、マルチアセット（WETH/WBTC）も動く。詳細は [ローカルリアルタイムシミュレーション](docs/guide/local-deploy.md)。

### セットアップ

```bash
# poc（リポジトリルート）
npm install
cp config/example.yaml config/local.yaml   # run 設定 + エージェントロスター
cp .env.example .env.local                  # 秘密情報のみ（ローカルは Anvil の dev キーで動くため任意）
npm run build:contracts                     # PriceFeed + モックオラクルを forge build（out/ が無ければ初回 1 回）

# 同梱 deployer/（初回のみ。GMX クローン取得 + Aave 依存 install で数分）
cd deployer
npm install
forge build                  # 共有 mock トークンをコンパイル
cp .env.example .env
./scripts/setup-vendors.sh   # 外部 repo(GMX) を clone+パッチ、Aave deps を install
cd ..
```

### 実行

```bash
# 別ターミナル: deployer で anvil 起動 + 全 venue deploy（--exit は付けない）
cd deployer && npm run deploy -- --keep-fresh

# poc 側（リポジトリルート）: deploy アドレスを取り込み、ローカルデプロイモードで run
npm run gen:local-constants
npm run sim:realtime -- --local-deploy --agents agents.local.json \
  --seed 1 --blocks 24 --seconds 70 --protocols uniswap,balancer,curve
```

出力は `runs/<run_id>/` 下に書かれる（`summary.json` / `events.jsonl` / `blocks.csv` / `agents/<id>.jsonl`）。確認できること:

- 全 agent と flow ウォレットのセットアップが完了する。
- 各ブロックで flow トランザクションと有効な agent トランザクションが提出される。
- `summary.json` の `valueSeries.failedReads` が `0`。

---

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [プロトコルとアクション](docs/guide/protocols-and-actions.md) | 各 venue のアクション・ステーブルコイン会計・オラクル制御・GMX 非同期実行 |
| [設定（config/local.yaml）](docs/guide/configuration.md) | YAML 単一ソースの設定・セクション・ロスターの書き方 |
| [ローカルリアルタイムシミュレーション](docs/guide/local-deploy.md) | 非fork のローカルデプロイモードの前提・手順・主要設定・トラブルシュート |
| [LLM 駆動の自律エージェント](docs/guide/llm-agents.md) | 実行時に戦略を生成・改訂する LLM エージェント（2 層構成・バックエンド・チューニング） |
| [市場ストレスイベント](docs/guide/stress-events.md) | 価格スパイク／クラッシュの注入と Aave 清算の誘発 |
| [リポジトリ構成](docs/guide/repository-layout.md) | ディレクトリ構成の早見表 |
| [run 出力と解析](docs/guide/run-output.md) | `runs/<id>/` の出力ファイルと run 後の解析方法 |

---

## 免責

これは研究・実験用の **MVP / Proof of Concept** であり、本番運用を意図しない。Aave / GMX のオラクルはコーディネータが制御するモックで、fair price は決定論的に生成される合成パスである。シミュレーションの結果（PnL・順位・識別力）は環境の構成・SEED・サンプル数に依存し、実市場のパフォーマンスを保証しない。

<p align="center">
  <sub>Built by <a href="https://erisnet.xyz/">Nyx Foundation</a> · <em>Let your contracts face the swarm.</em></sub>
</p>
