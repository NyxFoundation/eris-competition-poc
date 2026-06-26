[← README](../../README.md)

# アーキテクチャ（環境とエージェント実行の分離）

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
