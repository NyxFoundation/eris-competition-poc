# ADR 0003: 競争環境の識別力ハードニング — 観測を oracle 価格へ隔離し、手数料入札を実力軸として有効化する

## Status

Proposed

## Context

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータである。ADR 0001（多エージェント競争プラットフォーム）で**環境の「識別力」**（戦略の実力差を PnL/Sharpe の差として安定に表せる度合い）を主軸に据え、`discrimination`（C1 実力報酬 / C2 順位安定 / C3 Sharpe 非潰れ）で品質を検証している。

**コンペの提出形態（前提）**: 本番のコンペでは、参加者が **zip bundle（プロンプト + agent が使う汎用スクリプト）** を提出し、プラットフォームがそれを走らせて PnL/Sharpe で順位を付ける運用を想定する。したがって agent が**実行時に何を観測できるか**は、提出戦略の優劣を決める根幹であり、ここに真値（理論価格）が漏れていると「実力」ではなく「ラベルの読み取り」を測ることになる。

外部レビュー（codex によるアーキテクチャレビュー）で、現環境の**識別力の妥当性**に関わる2つの構造的課題が指摘された（自己改善ループの汎化保証は **ADR 0004** で別途扱う）。

### 解決したい課題

1. **真値（fair price）が観測へ漏れている**。`coordinator` は fair 更新 → oracle 追従の後に observation を配り、agent は `fairPriceUsdcPerWeth` を**真値そのまま**受け取る（`src/coordinator.ts:303`, `:611`）。さらに informed flow も同じ fair に pool を寄せる（`src/flow/logic.ts:103`）。→ fair/pool gap arb が「ラベルを読むだけ」で成立し、戦略実力ではなく**公開ラベルの読み取り＋ flow sizing への過適合**を測りやすい。
2. **手数料入札が実力軸として機能していない（ordering 機構は実装済みだが死蔵）**。Anvil は `--order fees` で起動し（`src/cli/anvil.ts`）、coordinator は各 tx に `maxPriorityFeePerGas` を載せて全 intent を 1 block に submit→`mine` する（`src/coordinator.ts:731`）。このため **block 内は priority fee 降順に整列される**（実測で確認・`check:ordering` 違反ゼロ）。問題は機構ではなく入札側にある: ほとんどの agent が `defaultPriorityFeePerGasWei`（全員同一）で出すため fee がタイになり、tie-break で提出順（`flow → agent`）に落ちる。→ 「flow が常に最前/最後」に見える症状の正体はこれで、**手数料入札という実力軸が（差別化されないために）働いていない**。

### 検討した選択肢

**課題1（真値遮断）の選択肢**

- **A. 完全隔離（oracle のみ）** — fair を coordinator 内部の潜在変数に隔離し、agent には noise+lag つき oracle 価格のみ渡す。
- **B. 漸進（lag→noise）** — fair に観測ラグだけ先に入れ、後から noise を足す。
- **C. 最小（flow 隠蔽だけ）** — fair は当面残し、informed flow の意図隠蔽だけ行う。

**課題2（手数料入札の有効化）の選択肢**

- **X. fee 入札の戦略化（ordering 機構は実装済み）** — ordering（`--order fees`）は既に動くので、観測に「いくら積めば前に出られるか」の手掛かり（直近 block の fee 分布等）を出し、agent/flow が fee を差別化入札できるようにする。
- **Y. MEV family** — latency / backrun / sandwich / batch auction など複数 ordering シナリオを pluggable に持つ。
- **Z. 現状維持** — 全員同一 fee のまま（fee がタイになり事実上の提出順依存を放置）。

### 各選択肢の評価

| 観点 | 真値: A 完全隔離 | 真値: B 漸進 | 真値: C 最小 | order: X fee | order: Y MEV | order: Z 現状 |
|------|---|---|---|---|---|---|
| 真値漏洩の遮断 | 高 | 中 | 低 | — | — | — |
| 現実忠実性（oracle 参照は実 DeFi で普通） | 高 | 中 | 低 | 中 | 高 | 低 |
| 手数料入札の実力軸 | — | — | — | 中 | 高 | なし |
| 実装コスト | 中 | 中 | 小 | 極小（機構は実装済） | 大 | なし |
| 既存戦略への影響 | 大（一斉に要改修） | 中 | 小 | 小 | 中 | なし |
| コンペ定義の単純さ | 高 | 高 | 高 | 高 | 低（MEV を競技に含む判断が要る） | 高 |

**採用**: 真値=**A（完全隔離）**、手数料入札=**X（fee 入札の戦略化）**。真値漏洩は本丸なので妥協せず断つ。ordering 機構（`--order fees`）は既に実装済みのため、X は「fee を差別化入札できる観測」を足して手数料入札を実力軸として有効化する一点に絞り、MEV/sandwich/latency は競技の射程外とする（必要なら将来別 ADR）。

## Decision

**agent observation から真値（fair price）を取り除き oracle 価格のみを参照可能にする。priority-fee ordering 機構は Anvil の `--order fees` で既に動いている（block 内は fee 降順に整列・実測確認済み）ため、本 ADR では agent/flow が手数料を差別化入札できるよう観測に手掛かりを足し、手数料入札を実力軸として有効化する。**

### 1. 観測を oracle 価格へ隔離（課題1 / 選択肢 A）

`fairPriceUsdcPerWeth` は **PnL/評価の決済専用の潜在変数**に格下げし、agent observation からは取り除く。agent が見るのは noise+lag つきの **oracle 価格のみ**とする。

真値漏洩は**二重**である点に注意する。`fairPrice` は coordinator メモリ内の潜在変数（`src/rng.ts` の `nextFairPrice` が乱数生成。オンチェーンに実 Chainlink は無い）であり、(a) observation の latent フィールドと (b) `updateOracles` が mock oracle（Aave `MockAggregator` / GMX `MockOracleProvider`）へ書く生コピーの両方で漏れている。

```
Bad（現状）: 真値漏洩は二重 ——
  (a) observation.fairPriceUsdcPerWeth = 真値の直値（coordinator が詰める）
  (b) updateOracles が mock oracle へ fairPrice を noise/lag ゼロの生コピーで書き込む
  + informed flow の意図/サイズも observation 由来で読める
  → fair/pool gap arb が「ラベルを読むだけ」で成立

Good（本決定）: (a) observation の latent fairPriceUsdcPerWeth フィールドを抹消
              (b) coordinator の fair→mock oracle 変換に noise+lag を注入
                  （ここでの oracle は coordinator が書く mock。実 Chainlink ではない）
              旧 fairPrice キー名は残し、中身を「加工後 oracle 値」に差し替えて既存戦略を壊さず移行（後述）
              fairPrice 自体は coordinator 内部 latent のまま、決済時の time-weighted 評価にのみ使用
              informed flow の kind/意図は不可視（板・在庫に現れた約定結果だけ観測可能）
```

- agent が見る価格には観測誤差と遅延を入れる。**具体的な noise 分布・lag 長は follow-up で確定**（識別力を見ながらキャリブレーション）。
- flow の `kind`（informed/uninformed）は observation に出さない。約定結果として板・在庫に現れたものだけを観測対象とする。

### 2. 手数料入札の有効化（課題2 / 選択肢 X）

**ordering 機構は既に実装済み**である。Anvil を `--order fees` で起動し、coordinator は各 intent に `maxPriorityFeePerGas` を載せて全 intent を 1 block に submit→`mine` するため、block 内 tx は priority fee 降順に整列する（実測で確認・`check:ordering` 違反ゼロ）。本 ADR で足すのは ordering 機構ではなく、**手数料を実力軸にするための「入札の戦略化」**である。

```
Bad（現状）: ordering は fee 降順で正しく動くが、ほとんどの agent が defaultPriorityFeePerGasWei
            （全員同一）で出すため fee がタイ → tie-break で提出順（flow→agent）に落ちる
            → 「flow が常に最前/最後」に見え、手数料入札が実力差を生まない

Good（本決定）: 観測に「いくら積めば前に出られるか」の手掛かり（直近 block の fee 分布・
              想定 txIndex 等）を出し、agent/flow が fee を差別化入札できるようにする
              ordering 機構（--order fees）と check:ordering はそのまま流用
```

- **射程外**: latency 競争・backrun/sandwich・batch auction といった MEV 戦は本 ADR に含めない。実力軸は「手数料入札」一本に絞る。
- coordinator の不変条件（**agent は RPC に触れない** / stdin・stdout 行 JSON のみ）は維持する。fee 差別化は観測の拡張で担保し、ordering 機構（`--order fees`）には手を入れない。

### 3. レビューでの決定（2026-06-10）

外部レビュー後の議論で以下を確定した（実装の指針）:

- **真値隔離の移行**: 旧 `fairPriceUsdcPerWeth` キー名を残し、中身を「加工後 oracle 値（noise+lag）」に差し替える。フィールド名不変で既存戦略を壊さず隔離を即時化（`strategy observation shape gotcha` 回避）。観測の正規化は一箇所に集約する。
- **真値漏洩の二重性**: 漏洩は (a) observation の latent フィールドと (b) `updateOracles` が mock oracle に書く生コピーの両方。両方を塞ぐ（latent 抹消＋ mock への noise+lag 注入）。実 Arbitrum に Chainlink 実体は無く、oracle は coordinator が書く mock である点に注意。
- **ordering は実装済み（課題2 の訂正）**: 2026-06-10 の実測で、Anvil `--order fees` により block 内 tx が priority fee 降順に整列することを確認（fee を差別化した 3 agent を提出順と逆に並べても block 内は fee 降順・`check:ordering` 違反ゼロ）。当初の課題2「priority fee が ordering に効かない／順序固定」は誤りで、真因は「ほとんどの agent が同一 fee で出し fee がタイ → 提出順に落ちる」。柱2 は ordering の新規実装ではなく**fee 入札の戦略化**に縮小。
- **導入順**: 柱1（観測の oracle 隔離）と柱2（手数料入札の有効化）を**同時投入しない**。回帰原因を切り分けるため **A（観測）→ X（fee 戦略化）** の順で段階導入し、各段で `discrimination` を確認する。X 投入時に flow の priority fee tier を再較正する。
- **fee の歯止め**: priority-fee ordering は**上限/予算なしで開始**。全 agent 同一初期インベントリのため資金力ゲーは二次効果。fee は実 gas として PnL を削る設計で実測し、必要なら上限/予算を follow-up で導入する。
- **ADR の位置づけ**: 本 ADR は ADR 0001/0002 を **supersede せず補完**。**0003 → 0004 の順**で段階導入し、効果確認後に Accepted へ。

## Consequences

### Positive

- discrimination（ADR 0001）の PASS が「実力の識別」を表す確度が上がる（ラベル漏洩を除去し、fee 差別化で「実質提出順依存」を解消）。
- oracle 参照・手数料入札はいずれも実 DeFi に近く、testnet（ADR 0001 の開催面）との乖離が縮まる。
- 提出 bundle（zip）方式のコンペで、参加者が「真値を読むだけ」のショートカットで上位を取れなくなる。

### Negative

- **既存13戦略の多くが `fairPriceUsdcPerWeth` 直読みに依存**（例: `fair-mm`, `dn-lp`）。
  - → **旧キー名は残し、中身だけ「加工後 oracle 値（noise+lag）」に差し替える**。フィールド名が変わらないので戦略は壊れず（`strategy observation shape gotcha` を回避）、隔離は即時に効く。戦略は順次 oracle ベースへ書き換え、一括破壊はしない。観測の正規化は一箇所に集約する。
- **fee 差別化が進むと flow と agent の手数料競争が起き、flow 設計の再調整が要る**。
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

## Notes

### 参考資料

- ADR 0001: 多エージェント競争プラットフォーム（`docs/adr/0001-multi-agent-competition-platform.md`）
- ADR 0002: LLM 戦略自己改善の2層アーキテクチャ（`docs/adr/0002-llm-strategy-self-improvement-two-layer.md`）
- ADR 0004: 自己改善ループの汎化保証（テーマ B。本 ADR と対）（`docs/adr/0004-self-improvement-generalization-guarantees.md`）
- 外部レビュー: codex CLI によるアーキテクチャレビュー（2026-06-09 実施。本 ADR の課題1・2 の出典）
- ordering の実測検証（2026-06-10）: `--order fees` 環境で fee を差別化した 3 agent を提出し、block 内が fee 降順に整列することを確認（提出順と独立・`check:ordering` 違反ゼロ）。課題2 の前提訂正の根拠。
- 関連コード: `src/coordinator.ts`（fair 更新・observation・submit）、`src/cli/anvil.ts`（`--order fees`）、`src/cli/checkOrdering.ts`（block 内 fee 降順検証）、`src/flow/logic.ts`（informed/uninformed flow）、`src/rng.ts`（fair price 生成）、`src/discrimination.ts`（識別力判定）
