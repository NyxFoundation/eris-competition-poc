# ADR 0005: 実時間化で決定論を捨てた後の評価基盤 — 多 run 統計（unpaired）への再設計

## Status

Accepted

## Context

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータである。ADR 0001 で**環境の「識別力」**（戦略の実力差を PnL/リスク調整リターンの差として安定に表せる度合い）を主軸に据え、`discrimination`（C1 実力報酬 / C2 順位安定 / C3 リスク非潰れ）で品質を検証する。ADR 0002 では LLM 戦略自己改善の 2 層（live / offline）を導入し、offline の `/strategy-evolve` は **マルチシードの paired 非劣化ゲート** で過学習を抑える。これらはすべて **「同一 SEED = 同一市場（決定論）」** を前提にしている（`src/multiSeedRun.ts` が seed ごとに sim を実走し、旧/新戦略を同一 seed で paired 比較する）。

`feat/realtime-blocktime` で、競争環境を **実時間2秒ブロック・非同期フリーラン**へ作り替え、評価も**実時間に一本化**する方針を採用した（決定論を捨てる）。

**重要な前提（実測で確認済み）**: 実時間でも fairPrice は `Rng(seed)` で毎ブロック進むため、**価格パス（市場の軌道）は seed で再現可能**である。非決定なのは **tx のタイミング/ブロック着順 = 競争の結果**だけである。したがって「同一 SEED = 同一市場」は**結果のレベルでは成り立たなくなる**（同一 seed でも agent の PnL がランごとにぶれる）。

### 解決したい課題

1. **paired ゲートが成立しない**。`/strategy-evolve` の per-seed 非劣化（ADR 0002 §6 rule 2）と `multiSeedRun` の paired 比較は「同一 seed で旧/新が同一市場を踏む」前提。実時間ではこれが崩れ、paired 差分が市場ノイズではなくタイミングノイズを含み、ゲートが意味を失う。
2. **discrimination の "seed" 概念が変質する**。C2（seed 間順位相関）は元々「複数の市場実現にわたる順位安定」を測っているが、その「実現」が**再現可能な条件**から**ノイズある反復**へ変わるため、判定の解釈としきい値を更新する必要がある。
3. **改善の検証手段が一時的に欠落する**。realtime 移行（ADR 0003/0004 の前提）後、既存の paired ゲートが無効になり、「改善が汎化するか」を判定する土台が無い。

### 検討した選択肢

**ばらつき制御（評価の分散をどう抑えるか）**

- **A. 完全 unpaired 統計** — seed ペアリングを捨て、各 config を N 回 i.i.d. 反復実行し、unpaired 検定（bootstrap CI / Welch / Mann-Whitney）で比較。
- **B. seed-paired ＋ 統計** — seed で価格パスを固定し旧/新を同一 seed で比較（市場ノイズ相殺）、残るタイミングノイズだけ反復で統計処理。
- **C. 両対応（env 切替）** — 既定 A、フラグで B。

**識別力 C1/C2/C3 の作り替え**

- **形は維持・seed→反復に読み替え＋C1 に有意性** — C2/C3 はそのまま反復 run に適用、C1 に「統計的に有意に上回る」を追加。
- **統計検出力ベースで再設計** — 識別力を power 指標で定義し直す。

### 各選択肢の評価

| 観点 | A 完全unpaired | B seed-paired | C 両対応 | C1C2C3: 形維持 | C1C2C3: 再設計 |
|------|---|---|---|---|---|
| 「決定論を捨てる」方針との整合 | 高 | 中（残存決定論に依存） | 中 | — | — |
| 検出力（必要 run 数の少なさ） | 低（run 多） | 高（分散相殺） | 中 | — | — |
| 実装の素直さ | 高 | 中 | 低（二系統） | 高（集計層を再利用） | 低（資産を捨てる） |
| 既存資産の活用 | 中 | 中 | 中 | 高 | 低 |
| 過学習/偽陽性の抑止 | 中（CI で担保） | 高 | 高 | 高（C1 有意性） | 高 |

**採用**: ばらつき制御 = **A（完全 unpaired 統計）**、識別力 = **形は維持（seed→反復読み替え＋C1 有意性）**。realtime の「決定論を捨てる」方針に最も忠実で実装も素直な A を採る。検出力低下は N と run 長で調整する。識別力は既存の集計層（`aggregateAgents` 等）を再利用しつつ、ゲート判定だけ差し替える。

## Decision

**評価を「決定論 paired ゲート」から「config を N 回 i.i.d. 反復実行する unpaired 統計」へ作り替える。`multiSeedRun` を反復実行基盤へ置換し、`discrimination` C1/C2/C3 は形を維持して seed→反復に読み替える（C1 に bootstrap CI 有意性を追加）。`/strategy-evolve` の per-seed 非劣化 paired ゲートは、unpaired 有意性ゲート（新版 mean 改善の bootstrap CI 下限 > 0 ＋ holdout 非劣化）へ置換する。**

### 1. 反復実行基盤（multiReplication）

`src/multiSeedRun.ts` の「seed ごとに 1 回」を「config ごとに N 回反復」へ一般化する。SEED は市場の**条件（regime・価格パスの種）を選ぶラベル**に格下げし、同一条件でも実時間の非決定で結果がぶれることを前提に N サンプルを貯める。

```
Bad（決定論前提）: seeds=[1,2,3] を 1 回ずつ → seed ごとに 1 サンプル
                   旧 vs 新を seed で paired 比較（同一市場前提）

Good（本決定）: 各 config を replications=N 回（必要なら regime×N）実時間実行
               agent ごとに N サンプルを蓄積 → unpaired 統計で比較
               run 長は runBlocks 固定で揃える（価格パス長を一定化し公平に）
```

- `collectMultiSeedStats(seeds)` → `collectReplicationStats(config, replications, regimes?)` を追加（既存 `accumulateRun` / `AgentAcc` はそのまま再利用）。
- 実時間 run は wall-clock を消費するため `runBlocks` を固定して 1 run を短く保つ。`local sim roster size limit`（同一 anvil 並行不可）に従い直列実行する。
- **C2 は複数 regime を必須とする**（§2 参照）。同一 regime だけ反復すると C2 が市場多様性ではなくタイミングノイズ耐性を測ってしまうため、discrimination の反復は `regime × N` で組む（探索段の単一 regime 構成では C2 は評価しない/参考値とする — §4・Risks 参照）。

### 2. discrimination の再解釈（形は維持）

`src/discrimination.ts` の構造（`aggregateAgents` / C1/C2/C3）は維持し、「seed 列」を「反復 run 列」と読み替える。

- **C1（実力報酬）**: 従来の「median が最強 baseline を上回る」に加え、**超過（PnL / information ratio）の bootstrap CI 下限 > 0**（＝統計的に有意に上回る）を必須化する。「median は超えたが運」の誤判定を防ぐ。
- **C2（順位安定）**: 「seed 間の mean Spearman」を「**regime（異なる市場）間の mean Spearman**」として使う（コード不変。順位列の各スロットを「1 regime の代表ランク」にする）。C2 が保証するのは「**市場が変わっても同じ agent が勝つか = 市場多様性への頑健性**」であり、タイミングの運への頑健性ではない。**同一 regime だけを反復すると C2 が「タイミングノイズ耐性」に化けて本来の意味を失う**ため、discrimination の反復は必ず複数 regime をまたぐ構成にし、regime 内の replications は代表ランク（例: regime 内 median PnL）へ畳んでから順位相関へ渡す。ノイズ増を吸収するため最低反復数を引き上げる。
- **C3（リスク非潰れ）**: リスク調整 metric の median spread をそのまま使う（不変）。
- `DEFAULT_THRESHOLDS` は反復数・実測分散を見て**再較正**する（「決めていないこと」参照）。

### 3. strategy-evolve の unpaired ゲート（ADR 0002 §6 rule 2 を置換）

```
Bad（paired）: 全 seed で「新版 ≥ 旧版」を seed 個別に要求（同一市場前提）

Good（unpaired）: 旧版 N run・新版 N run を取り、分布で比較
  採用条件:
   (a) bootstrap CI( mean(新) − mean(旧) ) の下限 > 0   ← 有意な改善
   (b) holdout regime（ADR 0004）でも CI 上限が劣化閾値を割らない ← 汎化
   (c) win-rate（新が旧を上回る run 割合）を補助指標として併記
```

- 検定は **bootstrap**（分布非正規・外れ値耐性）を既定とし、Welch の t / Mann-Whitney を補助に置く。
- ADR 0004 の段階制（探索段は緩め、恒久化段=holdout で締める）と整合させる: 探索段は CI を緩め N を小さく、恒久化段は full regime × 大 N で締める。

### 4. コスト管理

- run 本数は **replications N × regime 数 × (旧/新)** で増える。直列実行ゆえ wall-clock も増える。
- 既定 N は小さく（例: 8）始め、`runBlocks` を短く保つ。検出力が足りなければ N を上げる。
- **adaptive / sequential 停止**（CI 幅が閾値以下になるまで run を足す）は follow-up。

## Consequences

### Positive

- realtime（決定論を捨てた競争環境）と評価が整合し、**改善検証の空白が埋まる**。
- unpaired 統計は「同一 SEED 再現」に依存しないため、実時間の非決定をそのまま扱える。
- C1 への有意性導入で「運で median を超えた」改悪/まぐれの恒久化を防げる（ADR 0004 の survivorship 抑止と方向が一致）。

### Negative

- **検出力が落ちる**（paired の分散相殺を失う）→ 必要 run 数が増える。
  - → N を上げる / regime を絞る / `runBlocks` 短縮 / 将来 adaptive 停止を導入。
- **既存の per-seed paired ゲート資産（ADR 0002）を捨てる**。
  - → 集計層（`aggregateAgents` / `AgentAcc` / `informationRatio`）は再利用し、ゲート判定ロジックだけ差し替えて影響を局所化する。

### Risks

- **N 過小で偽陽性/偽陰性**（改悪採用 or 改善却下）。
  - → 採用は CI ベースで判定し、最低 N を設け、win-rate を併用する。
- **実時間 wall-clock コストが評価ループを遅くする**。
  - → `runBlocks` 短縮・直列実行・頻度分け（探索は軽量・恒久化のみ厳格）。
- **regime family（ADR 0004）と反復の掛け算で run 爆発**。
  - → 探索段は単一 regime・少 N、恒久化段のみ full regime × 大 N に限定する。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| 反復数 N・CI 幅・有意水準の具体値 | 実時間 run のばらつきを実測してから | 実装後の実測データで |
| 検定の最終選択（bootstrap / Welch / Mann-Whitney） | 結果分布の形を見て決めるべき | 実装後 |
| adaptive / sequential 停止規則 | まず固定 N で十分か見極める | 固定 N 運用後 |
| `runBlocks`（1 run の長さ）の標準値 | 検出力とコストのトレードオフ実測が要る | 実装時 |
| 本 ADR が ADR 0001/0002/0004 を **ADR 文書として** supersede するか補完か（注: ADR 0002 §6 の **paired ゲート自体は本 ADR §3 で置換済み**。ここで未定なのは文書レベルの supersede 関係のみ） | realtime 一本化の完了後に判断 | 一本化完了後にレビュー |

## Notes

### 参考資料

- ADR 0001: 多エージェント競争プラットフォーム（識別力 C1/C2/C3 の出典）
- ADR 0002: LLM 戦略自己改善の2層アーキテクチャ（置換対象の paired ゲート §6）
- ADR 0003: 競争環境の識別力ハードニング（realtime 化と対の環境側）
- ADR 0004: 自己改善ループの汎化保証（holdout / regime family と整合）
- 実時間化プラン: `~/.claude/plans/velvet-hopping-clock.md`（決定論を捨てる方針の出典）
- 関連コード: `src/multiSeedRun.ts`（反復基盤へ置換）、`src/discrimination.ts`（C1/C2/C3 を再解釈）、`scripts/evaluate.ts` / `scripts/discrimination.ts`（CLI）、`/strategy-evolve`（ゲート差し替え）
