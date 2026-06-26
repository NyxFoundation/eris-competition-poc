[← README](../../README.md)

# ローカルリアルタイムシミュレーション（非fork）

Arbitrum を fork せず、本 repo 同梱の `deployer/` がローカル anvil 上に全 protocol を deploy したものに poc が接続して realtime run を回すモード。fork backend への cold state RPC 往復（fork RPC レイテンシ）を避けられ、マルチアセット（WETH/WBTC）も動く。

## 前提

- `deployer/` は本 repo に同梱されたサブパッケージ（自己完結の package.json / foundry.toml を持つ。全 venue のローカルデプロイに対応）。
- poc 側は anvil を起動しない（deployer が anvil を所有する）。`ERIS_LOCAL_DEPLOY=1` のとき `npm run anvil` は fail-fast する。

## 初回セットアップ（deployer サブパッケージ）

`deployer/` は独立したビルド/依存を持つため、初回のみ次を実行する（数分）:

```bash
cd deployer
npm install
forge build                  # 共有 mock トークンをコンパイル
cp .env.example .env
./scripts/setup-vendors.sh   # 外部 repo(GMX) を clone+パッチ、Aave deps を install
cd ..
```

> `vendor/` の重いクローン（`gmx-src` / `curve-src` / `twocrypto-src`）は git 管理外で、`setup-vendors.sh` が固定コミットで再現する。`vendor/curve` の prebuilt bytecode と `gmx-localhost.patch` のみ同梱済み。

## 手順

1. **deployer で anvil 起動 + 全 venue deploy**（別ターミナル推奨）:

   ```bash
   cd deployer
   npm run deploy -- --keep-fresh
   ```

   - `--keep-fresh` は `deployments.json` を初期化してから deploy する。
   - `--exit` を**付けない**こと。付けると deploy 後に anvil を停止してしまう。付けなければ anvil は起動したまま `127.0.0.1:8545` で待機する。
   - 全 5 venue（Uniswap V3 / Balancer V2 / Aave V3 / Curve / GMX V2）＋共有トークン（WETH/USDC/USDT/DAI/WBTC）＋ Multicall3 を deploy する。完了まで数分（GMX が最も重い）。
   - 完了すると `deployer/deployments/deployments.json` が出力され、「anvil は起動したままです」と表示される。

2. **poc で `constants.local` を生成**（deploy アドレスを poc に取り込む）。リポジトリルートで:

   ```bash
   npm run gen:local-constants
   ```

   `deployer/deployments/deployments.json` を読んで `src/constants.local.ts` を生成する（`DEPLOYMENTS_JSON` env でパス上書き可）。deploy は決定論アドレスなので、再生成しても差分は出ないことが多い。

3. **リアルタイム run を実行**（ローカルデプロイモードで `127.0.0.1:8545` に接続）:

   ```bash
   npm run sim:realtime -- \
     --local-deploy \
     --agents agents.local.json \
     --seed 1 --blocks 24 --seconds 70 \
     --protocols uniswap,balancer,curve
   # USDC-only 配布（funding.wethWei: "0"）やマルチアセット（flow.baseMax）等は config/local.yaml で
   ```

## 主要な設定（CLI フラグ / config/local.yaml のキー）

| CLI フラグ | config キー | 説明 |
|---|---|---|
| `--local-deploy` | `run.localDeploy` | ローカルデプロイ（非fork）モードを有効化。**必須** |
| `--agents <path>` | `run.agentsConfig` | ロスターファイル（`agents.local.json` 等）。config に inline `agents:` でも可 |
| `--seed` | `run.seed` | 市場条件のラベル（価格パス再現用） |
| `--blocks` | `run.blocks` | run 長（ブロック数） |
| `--seconds` | `run.seconds` | 実時間の上限（24 ブロック ≒ 48 秒なので 70 程度を確保） |
| `--protocols` | `run.protocols` | 有効 venue（CLI はカンマ区切り、YAML は配列） |
| —（YAML のみ） | `funding.wethWei` | USDC-only 配布（`"0"` で初期の方向性エクスポージャを排除する） |
| —（YAML のみ） | `flow.baseMax` | マルチアセット（WBTC）を取引させる場合（例 `{ WBTC: "50000000" }`）。WBTC の AMM flow を有効化して価格乖離＝裁定機会を作る（既定 off） |

> **注**: 「config キー」列は `config/local.yaml` のネストパス。CLI フラグは YAML の値を一回限り上書きする。ローカルデプロイのアカウント 0（account0）は deployer のデプロイアカウントと重なり残留残高で価値が歪むため、ロスターは AGENT1 以降（account1+）を使う（`agents.local.json` / `config/example.yaml` はそうなっている）。

## トラブルシュート

- **接続できない**: deployer の `npm run deploy -- --keep-fresh` が起動中か（`--exit` を付けていないか）確認する。
- **アドレス不一致 / コントラクトが無い**: deploy 後に `npm run gen:local-constants` を再実行したか確認する。
- **run が価格窓に到達せず早期終了する**: `--seconds`（`ERIS_RUN_SECONDS`）を十分大きくする。

## Tips

- **一部 venue だけ deploy（高速化）**: `npm run deploy -- --only uniswap,balancer`（GMX/Aave の重い hardhat-deploy を回避）。poc 側の `--protocols` も合わせる。
- **マルチアセット（WBTC）**: `config/local.yaml` の `flow.baseMax: { WBTC: "50000000" }` で WBTC の AMM flow を有効化すると価格乖離＝裁定機会ができる（既定 off）。`funding.base` / `limits.agentBase` で初期在庫・per-round 上限も指定できる。
- **逐次 run の断面**: ローカルは fork が無いので resetFork は `evm_snapshot` / `evm_revert` に分岐する。snapshot ID は `.local-snapshot` に永続化され、run 間でクリーン断面から始まる（並行 run は非対応）。
