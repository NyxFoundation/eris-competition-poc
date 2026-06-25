---
name: sim-loop
description: |
  シミュレーターを 1 サイクル進める: ベースライン実行 → 結果診断 → 最大インパクト課題を 1 つ抽出 → 修正プラン → 実装 → 再実行 → 改善を before/after 比較。
  iter ログを runs/iterations/iter-NN.md に保存。次イテレーションでは前回ログを参照して比較。
  使用: ユーザーが「次のイテレーション」「ループ回して」「sim-loop」「sim を改善して」「課題見つけて直して」と言ったとき。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
  - Agent
---

# sim-loop: 段階的シミュレーター改善ループ

このスキルは eris-competition-poc のシミュレーター品質を 1 サイクル分進めるためのもの。
**1 回呼び出し = 1 イテレーション分**。複数回続けたい場合はユーザーが再度呼び出す（または明示的に "n 回回して" と指示）。

## 0. 前提

- `npm run anvil` が別ターミナルで起動済みであること（curl で疎通確認）
- 修正後にテスト走行し、結果を **iter ログ** にサインオフして残す
- 各サイクルは 1 課題のみ扱う。複数課題を同時に直さない（原因切り分けが効かなくなる）

## 1. Baseline 取得

最新 `runs/<id>/` に **ベースライン** を要求する。古い場合は再実行。

```bash
# Anvil 疎通確認
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://127.0.0.1:8545 | head -c 100

# 直近の run の age を確認 (15 分以上前なら再実行を提案)
LATEST=$(ls -t runs/ | head -1)
ls -ld "runs/$LATEST"
```

ベースラインが古い・無い・前回イテレーションで触ったコードを反映していない場合:
```bash
npm run leaderboard -- --agents agents.swarm.json 2>&1 | tail -20
```

## 2. Diagnose

`runs/<latest>/` の `summary.json` / `blocks.csv` / `events.jsonl` / `leaderboard.md` を読み、
以下のチェックリストを順に評価:

### 公平性 / setup 健全性
- [ ] **initialValueUsdc の spread**: 全 agent 間で max-min が初期値の 5% 以下か？ それ以上は setup 不公平 → 候補
- [ ] **initial WETH/USDC のバラつき**: agent の `initial.weth` / `initial.usdc` が想定通り (10 → 5 WETH, ~swap 相当 USDC)？
- [ ] **Anvil フォーク残存**: 最新 run 直前に Anvil 再起動 / `anvil_reset` していたか？ していなければ前回残高汚染の可能性

### 競争メカニクス
- [ ] **revert 比率**: `revertCount / submittedTxCount` が agent 間で大きく違う？ 競争で後手に回った agent が 30%+ なら正常
- [ ] **block.csv の priority fee 順序**: 各ラウンドで `txIndex 0` の priority fee が最大か？ 違反していたら ordering バグ
- [ ] **同一機会で勝者が常に 1 体**: 最高 bid が常に同じ agent なら戦略多様性なし

### 経済性
- [ ] **gas が PnL を食い過ぎていないか**: `gasCostEth × ETH価格 / netPnlUsdc` > 30% は経済性に問題
- [ ] **netPnL の散らばり**: 全 agent が正の小さな PnL → アービ機会が薄い / フロー過小
- [ ] **Sharpe spread**: 全 agent が同じ Sharpe レンジ (±0.02) → 戦略差が出ていない

### モデル妥当性 (L2 前提)
- [ ] **fairPrice trajectory**: history.json の fair price が drift だけで動いていない (jump がない) → 単純 RW のまま
- [ ] **L1 calldata cost を反映していない**: gas 計算が L2 execution gas のみ
- [ ] **物理時間が round に紐付いていない**: Aave 利息戦略が時間スケールで不利

各チェックで「失格」した項目を **インパクト × 修正コスト** で並べ、トップ 1 を選ぶ。
直前イテレーションで触った領域を **連続して触らない**（複合変更は原因切り分け不能）。

## 3. Plan (簡潔に)

選んだ課題に対して以下を 30 行以内で書く:
- **問題の要約**: 数値で示す (e.g. "initial spread 71,545 USDC = 21%")
- **根本原因**: コードのファイル:行 を指す (e.g. `coordinator.ts:79-83 で wallet 順次 swap")
- **修正方針**: 1 アプローチのみ。代替案は書かない
- **影響範囲**: 触るファイル
- **想定される副作用**: 既存テストが壊れるか / 他 metric に影響するか
- **成功条件**: 数値しきい値 (e.g. "initial spread < 1%")

ユーザーには確認しない（auto モード時）。プランは iter ログに含める。

## 4. Implement

**1 課題に対する変更だけ** をコミット。リファクタや関連ない掃除を混ぜない。
- typecheck (`npm run typecheck`) 通過
- 既存ユニットテスト (`npm run test`) 通過
- 必要なら新規ユニットテストを追加

## 5. Re-run

```bash
npm run leaderboard -- --agents agents.swarm.json 2>&1 | tail -20
```

## 6. Diff / 評価

before (前 iter の summary.json) と after (新 run の summary.json) を比較し、
**3. で書いた成功条件** に対する達成可否を判定:
- 改善した metric → 数値で表示
- 悪化した metric → 警告
- 想定外の副作用 → next iter のキューに入れる

## 7. iter ログを保存

`runs/iterations/iter-NN.md` に以下を残す:

```md
# Iteration NN — <topic>

**Date**: <ISO date>
**Baseline run**: runs/<id-before>
**After run**: runs/<id-after>

## Problem
<3. の Plan セクション>

## Implementation
<1-2 行: 何を変更したか + 主要ファイル>

## Result
| metric | before | after | Δ | 成功条件 | OK? |
|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ✓/✗ |

## Next candidates
<次回回せそうな課題を箇条書きで 2-3 個。優先度ヒント付き>
```

NN は既存 iter-*.md の最大番号 + 1（ゼロ埋め 2 桁）。

## 8. ユーザーへ報告

短い要約で:
- 何を直したか (1 行)
- 改善した数値 (before → after)
- 副作用の有無
- 次の候補 (1-2 個)

「次回まわす？」とは聞かない。ユーザーが続けたければ自分で `/sim-loop` を呼ぶ。

---

## Notes

- 1 イテレーション = ~10-20 分（128 round 走行 ~5 分 × baseline + after = ~10 分 + 実装時間）
- 課題が見つからない / 全項目グリーンの場合は「ループ完了」と報告して終了
- 同じ課題で連続失敗（成功条件未達）したら 3 回でアラートを上げ、ユーザー判断を仰ぐ
- iter ログは git に commit しない（runs/ は通常 .gitignore 対象）
