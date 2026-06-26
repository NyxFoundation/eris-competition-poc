[← README](../../README.md)

# 市場ストレスイベント（spike/crash + Aave 清算。既定 off）

OU の base price に **SEED 由来でランダム化した決定論オーバーレイ**（`src/realtime/events.ts`）を重ねて effective price を導出する。effective は PriceFeed・Aave WETH オラクル・GMX・採点へ一貫伝播し、窓外では β≈0 を保つ。清算を成立させる seed 由来 victim 群（採点対象外）を建てる。`config/local.yaml` の `stress:` セクションで指定する:

```yaml
stress:
  events:
    - { type: crash, magnitudeRange: [0.12, 0.16], windowFrac: [0.3, 0.7], rampBlocks: 3, holdBlocks: 6, decayBlocks: 8 }
  victimCount: 0   # >0 で清算対象 victim を建てる（要 ARB_RPC_URL + full re-fork）
```

- `stress.events` — **値でなくレンジ**を与え過学習を抑制する（`spike`/`crash` の台形 ramp→hold→decay）。要 `run.blocks>0`。
- victim を建てるには **full re-fork 必須**（`ARB_RPC_URL` 設定 + soft-reset 不可）。割るには crash magnitude `m > (HF0−1)/HF0`（HF0=1.10 なら m>9.1% → 例の [0.12,0.16] で確実に割れる）。breach 不能な設定は `stress_calibration_warning` を emit する。
- victim を**建てられる**条件は `victimHf0 ≳ LT/(0.97·LTV)`（実測 Arbitrum WETH の LT=0.84 / LTV=0.80 で ≈1.08。これ未満は borrow が LTV 縁に張り付き fail-fast）。`stress.victimCount`(既定 0=無効) / `stress.victimHf0`(既定 1.10) / `stress.victimWethWei`(victim 1 体の supply) で指定する。
- stress run（events かつ `run.blocks>0`）は**時間制限を自動無効化**しブロック数で終了する（`--seconds` が先に切れて crash 窓へ到達しない事故を回避）。
- coordinator は `stress_schedule` / `stress_victim_hf` / `stress_liquidation` を `events.jsonl` へ emit する。liquidator agent には victim アドレスを `ERIS_LIQUIDATION_VICTIMS` で配布する。清算の帰属は agent ログの `liquidationCall`(rawTx) を一次情報にする。
