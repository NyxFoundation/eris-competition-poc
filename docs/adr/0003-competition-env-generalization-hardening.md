# ADR 0003: 競争環境の識別力ハードニング — 観測を oracle 価格へ隔離し priority-fee ordering を導入

## Status

Proposed

## Context

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータである。ADR 0001（多エージェント競争プラットフォーム）で**環境の「識別力」**（戦略の実力差を PnL/Sharpe の差として安定に表せる度合い）を主軸に据え、`discrimination`（C1 実力報酬 / C2 順位安定 / C3 Sharpe 非潰れ）で品質を検証している。

**コンペの提出形態（前提）**: 本番のコンペでは、参加者が **zip bundle（プロンプト + agent が使う汎用スクリプト）** を提出し、プラットフォームがそれを走らせて PnL/Sharpe で順位を付ける運用を想定する。したがって agent が**実行時に何を観測できるか**は、提出戦略の優劣を決める根幹であり、ここに真値（理論価格）が漏れていると「実力」ではなく「ラベルの読み取り」を測ることになる。

外部レビュー（codex によるアーキテクチャレビュー）で、現環境の**識別力の妥当性**に関わる2つの構造的課題が指摘された（自己改善ループの汎化保証は **ADR 0004** で別途扱う）。

### 解決したい課題

1. **真値（fair price）が観測へ漏れている**。`coordinator` は fair 更新 → oracle 追従の後に observation を配り、agent は `fairPriceUsdcPerWeth` を**真値そのまま**受け取る（`src/coordinator.ts:303`, `:611`）。さらに informed flow も同じ fair に pool を寄せる（`src/flow/logic.ts:103`）。→ fair/pool gap arb が「ラベルを読むだけ」で成立し、戦略実力ではなく**公開ラベルの読み取り＋ flow sizing への過適合**を測りやすい。
2. **priority fee が ordering に効かない（順序が固定）**。提出順が常に `flowIntents → agentIntents → rawTx` 固定で、tx に priority fee を載せても anvil 上では順序に反映されない（`src/coordinator.ts:412`, `:423`, `:468`）。→ 同一機会での勝敗が「誰が常に flow の前/後ろにいるか」という人工的な提出順で決まり、**手数料入札という実力軸**が機能しない。

### 検討した選択肢

**課題1（真値遮断）の選択肢**

- **A. 完全隔離（oracle のみ）** — fair を coordinator 内部の潜在変数に隔離し、agent には noise+lag つき oracle 価格のみ渡す。
- **B. 漸進（lag→noise）** — fair に観測ラグだけ先に入れ、後から noise を足す。
- **C. 最小（flow 隠蔽だけ）** — fair は当面残し、informed flow の意図隠蔽だけ行う。

**課題2（ordering）の選択肢**

- **X. priority-fee ordering** — 提出順固定をやめ、全 intent を priority fee 降順で block 内整列。手数料入札を実コストにする。
- **Y. MEV family** — latency / backrun / sandwich / batch auction など複数 ordering シナリオを pluggable に持つ。
- **Z. 現状維持** — 提出順固定のまま。

### 各選択肢の評価

| 観点 | 真値: A 完全隔離 | 真値: B 漸進 | 真値: C 最小 | order: X fee | order: Y MEV | order: Z 現状 |
|------|---|---|---|---|---|---|
| 真値漏洩の遮断 | 高 | 中 | 低 | — | — | — |
| 現実忠実性（oracle 参照は実 DeFi で普通） | 高 | 中 | 低 | 中 | 高 | 低 |
| 手数料入札の実力軸 | — | — | — | 中 | 高 | なし |
| 実装コスト | 中 | 中 | 小 | 小 | 大 | なし |
| 既存戦略への影響 | 大（一斉に要改修） | 中 | 小 | 小 | 中 | なし |
| コンペ定義の単純さ | 高 | 高 | 高 | 高 | 低（MEV を競技に含む判断が要る） | 高 |

**採用**: 真値=**A（完全隔離）**、ordering=**X（priority-fee ordering）**。真値漏洩は本丸なので妥協せず断つ。ordering は手数料入札という単一で理解しやすい実力軸に絞り、MEV/sandwich/latency は競技の射程外とする（必要なら将来別 ADR）。

## Decision

**agent observation から真値（fair price）を取り除き oracle 価格のみを参照可能にする。さらに提出順固定をやめ、全 intent を priority fee 降順で block 内整列する priority-fee ordering を導入する。**

### 1. 観測を oracle 価格へ隔離（課題1 / 選択肢 A）

`fairPriceUsdcPerWeth` は **PnL/評価の決済専用の潜在変数**に格下げし、agent observation からは取り除く。agent が見るのは noise+lag つきの **oracle 価格のみ**とする。

```
Bad（現状）: observation.fairPriceUsdcPerWeth = 真値（agent が直読み）
              informed flow の意図/サイズも observation 由来で読める
              → fair/pool gap arb が「ラベルを読むだけ」で成立

Good（本決定）: observation には oracle 価格のみ（noise + lag つき、実 Arbitrum の Chainlink 的挙動に寄せる）
               fairPrice は coordinator 内部に隠蔽し、決済時の time-weighted 評価にのみ使用
               informed flow の kind/意図は不可視（板・在庫に現れた約定結果だけ観測可能）
```

- agent が見る価格には観測誤差と遅延を入れる。**具体的な noise 分布・lag 長は follow-up で確定**（識別力を見ながらキャリブレーション）。
- flow の `kind`（informed/uninformed）は observation に出さない。約定結果として板・在庫に現れたものだけを観測対象とする。

### 2. priority-fee ordering の導入（課題2 / 選択肢 X）

coordinator は agent / flow から集めた全 intent を、**priority fee 降順で並べてから 1 block に提出**する。手数料を高く積んだ tx が先に通り、入札が実コスト・実効果を持つ。

```
Bad（現状）: 提出順 = flowIntents → agentIntents → rawTx（固定）
              priority fee は載っても anvil の順序に反映されない

Good（本決定）: 全 intent を収集 → priorityFeeWei 降順で整列 → その順で 1 block に提出
               同 fee は決定論的タイブレーク（例: intent hash）で再現性を担保
               agent は「いくら積めば前に出られるか」を観測・戦略化できる
```

- **射程外**: latency 競争・backrun/sandwich・batch auction といった MEV 戦は本 ADR に含めない。ordering の実力軸は「手数料入札」一本に絞る。
- coordinator の不変条件（**agent は RPC に触れない** / stdin・stdout 行 JSON のみ）は維持する。ordering は coordinator 内の提出スケジューラとして実装する。

## Consequences

### Positive

- discrimination（ADR 0001）の PASS が「実力の識別」を表す確度が上がる（ラベル漏洩・提出順交絡を除去）。
- oracle 参照・手数料入札はいずれも実 DeFi に近く、testnet（ADR 0001 の開催面）との乖離が縮まる。
- 提出 bundle（zip）方式のコンペで、参加者が「真値を読むだけ」のショートカットで上位を取れなくなる。

### Negative

- **既存13戦略の多くが動かなくなる**。`fairPriceUsdcPerWeth` 直読みに依存（例: `fair-mm`, `dn-lp`）。
  - → 観測アダプタで「oracle 価格」を旧 `fairPrice` キー互換に当てて段階移行し、戦略側は順次 oracle ベースへ書き換える。一括破壊はしない。
- **priority-fee ordering で flow と agent の手数料競争が起き、flow 設計の再調整が要る**。
  - → flow の priority fee レンジ（`src/flow/logic.ts` の tier）を再キャリブレーションし、flow が常に最前/最後に固定されない範囲に収める。
- **oracle ノイズ/ラグの入れ過ぎで識別力が潰れる**（誰も勝てず C3 が FAIL）。
  - → noise 強度を可変パラメータにし、`sim-loop` で discrimination を回しながら調整する。

### Risks

- **観測形状変更で `strategy observation shape gotcha`（メモリ既知の TypeError noop 化）が再発する**。
  - → observation の正規化を一箇所に集約し、oracle キーへの移行時に既存の正規化テストを更新する。
- **priority-fee ordering が「資金力ゲー」になり実力差を覆い隠す**（残高が多いほど高 fee を積める）。
  - → fee は gas コストとして実 PnL を削るため、無闇な高 fee は損になる設計を維持。必要なら fee の上限/予算を導入（follow-up）。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| oracle ノイズ/ラグの具体モデル（分布・lag 長） | キャリブレーションが必要で、先に決めると識別力を壊しうる | 柱1 実装時の follow-up |
| MEV（latency/backrun/sandwich/batch auction）の扱い | 本 ADR の射程外。競技に含めるかはコンペ定義の別判断 | 必要が生じた時に別 ADR |
| priority fee の上限/予算ルール | 資金力ゲー化の度合いを実測してから決める | ordering 実装後 |
| 本 ADR が ADR 0001 を supersede するか補完か | 段階導入の結果次第 | テーマ A/B 導入完了後にレビュー |

## Notes

### 参考資料

- ADR 0001: 多エージェント競争プラットフォーム（`docs/adr/0001-multi-agent-competition-platform.md`）
- ADR 0002: LLM 戦略自己改善の2層アーキテクチャ（`docs/adr/0002-llm-strategy-self-improvement-two-layer.md`）
- ADR 0004: 自己改善ループの汎化保証（テーマ B。本 ADR と対）（`docs/adr/0004-self-improvement-generalization-guarantees.md`）
- 外部レビュー: codex CLI によるアーキテクチャレビュー（2026-06-09 実施。本 ADR の課題1・2 の出典）
- 関連コード: `src/coordinator.ts`（fair 更新・observation・ordering）、`src/flow/logic.ts`（informed/uninformed flow）、`src/rng.ts`（fair price 生成）、`src/discrimination.ts`（識別力判定）
