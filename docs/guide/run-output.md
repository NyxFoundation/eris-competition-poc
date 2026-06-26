[← README](../../README.md)

# run 出力と解析

run ごとに `runs/<run_id>/` が生成される。評価・採点・可視化系の専用コマンドは撤去済みで、解析は出力ファイルを直接読む。

| ファイル | 内容 |
|---|---|
| `summary.json` | agent ごとの initial / final value・netPnl・gas・revert 数・提出/included tx 数、`protocolValuesUsdc`、`valueSeries.failedReads`、`violations` |
| `events.jsonl` | イベント列（observation・stress・liquidation 等）。採点の一次情報 |
| `blocks.csv` | ブロックごとの tx 記録（fee はチェーン上の tx フィールド由来） |
| `agents/<id>.jsonl` | 各 agent の自己申告ログ（判断 `reason` / `signals` / `state`、direct モードの mempool 活動 `kind:"mempool"`） |

```bash
npm run check:ordering -- runs/<run_id>   # Anvil の fee 順序を検査
npm run check:strategy -- <file>          # 戦略コードの cheatcode 静的検査（入口側）
```

> run は `sim:realtime` 一本。**SEED(=regime) は市場条件のラベル**で価格パスは再現可能だが、tx タイミング/着順は非決定 → 同一 regime でも結果はぶれる。run の比較が要るときは同一 config を複数回回してサンプルを貯め、`summary.json` を集計する。

## summary.json の主なフィールド

| フィールド | 意味 |
|---|---|
| `agents[].initialValueUsdc` / `finalValueUsdc` | run 開始・終了時の総価値（USDC 相当） |
| `agents[].netPnlUsdc` | `finalValueUsdc − initialValueUsdc`（gas 込み） |
| `agents[].protocolValuesUsdc` | venue ごとの内訳（Uniswap LP 価値 / GMX equity / Aave net collateral−debt 等） |
| `agents[].includedTxCount` / `revertCount` | included / revert した tx 数 |
| `valueSeries.failedReads` | 価値再構成で読めなかった断面数（健全なら `0`） |
| `violations` | 事後ルール検査（fee 上限超過等）の違反 |

## 清算の帰属（stress run）

清算の帰属は専用ツールではなく、`events.jsonl` の `stress_liquidation` と各 agent の `agents/<id>.jsonl` の `liquidationCall`(rawTx) を突き合わせて解析する（jsonl を直接読む）。詳細は [市場ストレスイベント](stress-events.md)。
