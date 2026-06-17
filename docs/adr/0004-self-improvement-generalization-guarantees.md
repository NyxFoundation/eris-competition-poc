# ADR 0004: 自己改善ループの汎化保証 — holdout 分離・提出 bundle の公平採点・帰属の因果化

## Status

Proposed

## Context

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータである（ADR 0001: 識別力を主軸）。ADR 0002（LLM 戦略自己改善の2層アーキテクチャ）で、live（online・弱ゲート）と offline（`/strategy-evolve`・マルチシード paired ゲート・恒久化）の2層で戦略を進化させる仕組みを導入した。

**コンペの提出形態（前提）**: 本番のコンペでは、参加者が **zip bundle（プロンプト + agent が使う汎用スクリプト）** を提出し、プラットフォームがそれを走らせて順位を付ける。**bundle は実行時にプロンプト/LLM を使ってよい**＝ live 自己改善（revise や損切り rollback）は**参加者が自分の bundle 内で行う正当な戦略**である。一方、`src/llm/baseStrategies.ts` を磨く**プラットフォーム内部の進化**（ADR 0002 の B 層）は、コンペ運営側の R&D であり別物である。

外部レビュー（codex によるアーキテクチャレビュー）で、**自己改善ループの汎化保証**に関わる構造的課題が指摘された（観測の真値漏洩・ordering は **ADR 0003** で別途扱う）。本 ADR はこの「テーマ B」を担う。

### 解決したい課題

1. **進化ゲートが同一生成器内の model selection に閉じている**。`evaluate` は同じ generator/config に `SEED` だけ差し替えて回す（`scripts/evaluate.ts`, `src/multiSeedRun.ts`, `src/rng.ts:22`）。探索・選抜・最終検定が同一分布なので overfitting を止めきれない。さらに「全 seed 個別非劣化」ゲート（ADR 0002 §6 rule 2）は探索を保守化し局所最適を強化する。
2. **内部進化が live 生存版だけを収穫すると survivorship bias を自己強化する**。live rollback（`src/llm/claudeAgent.ts:36`, `:455`）は採点対象と同じ run の PnL を見て 5 round / 4% drop で前版へ巻き戻す。参加者戦略としては正当だが、**プラットフォーム内部の B 層が「live で生き残った版」だけを `baseStrategies` に収穫する**と、「risky な変更を試し負けだけ巻き戻す free option」の生存バイアスが恒久ライブラリへ蓄積する。
3. **attribution が因果を分離していない**。live attribution は `action.type` ごとの次ラウンド評価額差分にすぎず、市場ベータ・flow 影響・含み益・他 agent との相互作用を分離していない（`src/llm/attribution.ts:21`, `src/discrimination.ts:70`）。→ LLM が「swap が損 / noop が得」など誤帰属を学び防御的戦略へ収束する／外部性で勝つ報酬ハックを見逃す。

### 検討した選択肢

**課題1（holdout）の選択肢**

- **A. train/validation/sealed-holdout + regime family** — 探索・選抜・最終検定の分布を分離し、恒久化は封印 holdout 通過を条件とする。
- **B. seed を増やすだけ** — 同一 generator で seed 数を増やす（現状の延長）。
- **C. 現状維持** — 5 seed の paired ゲートのみ。

**課題2（採点 / survivorship）の選択肢**

- **P. 提出 bundle 単位の公平採点 + 内部進化のみ counterfactual** — 競技は bundle 単位で公平に採点（live 自己改善は参加者の自由）。survivorship 除去は**プラットフォーム内部の収穫**にのみ適用。
- **Q. live を一律別カテゴリ/禁止** — live 自己改善をプラットフォームが制限する。
- → bundle 提出方式では Q は参加者の自由を奪い不成立。**P を採用**。

### 各選択肢の評価

| 観点 | holdout: A | holdout: B | holdout: C | 採点: P | 採点: Q |
|------|---|---|---|---|---|
| overfitting の抑止 | 高 | 低 | 低 | — | — |
| survivorship の除去 | — | — | — | 高（内部のみ） | 中 |
| 参加者の自由（bundle 方式と整合） | — | — | — | 高 | 低（自由を制限） |
| 評価コスト | 大 | 中 | 小 | 中 | 小 |
| 実装コスト | 大 | 小 | なし | 中 | 中 |

## Decision

**進化の探索・選抜・最終検定を train/validation/sealed-holdout と regime family に分離し、`baseStrategies` への恒久化は封印 holdout 通過を条件とする。競技は提出 bundle 単位で公平に採点し（live 自己改善は参加者の自由）、プラットフォーム内部の収穫だけ offline counterfactual で survivorship を除去する。さらに attribution を因果化する。**

### 1. 評価の holdout・regime family 分離（課題1 / 選択肢 A）

```
train      : 探索・live revise・offline 変更案生成に使う seed/regime
validation : paired ゲート（ADR 0002 §6）の判定に使う seed
holdout    : 封印。恒久化（baseStrategies へ commit）の直前に一度だけ通す
             unseen seeds かつ unseen regime（drift/vol・flow 強度・ordering）を含む
```

- **regime family**: `src/rng.ts` の固定パラメータ（drift 0.00005 / vol 0.004）は単一レジームに過ぎない。drift/vol・flow 強度を変えた**市場レジーム族**で評価する。
- **恒久化条件の強化**: `baseStrategies` への昇格は train/validation を通った上で、**sealed holdout（unseen seeds + unseen regime）で非劣化**を確認したものだけに限定する。
- **保守化ゲートの段階制**: 「全 seed 個別非劣化」は局所最適を強化するため、**探索段では緩め、恒久化段（holdout）で締める**段階制へ見直す。

### 2. 提出 bundle 単位の公平採点（課題2 / 選択肢 P）

- 競技単位は**提出 bundle**。live 自己改善（revise・rollback などの adaptive policy）は**参加者の正当な戦略**とし、禁止も別カテゴリ化もしない。
- 公平性は**実行予算の均一化**で担保する。全 bundle に同一の **LLM call budget / 実行時間 / executor 実行上限**を割り当て、「呼べた回数」で差がつかないようにする（具体値は follow-up）。

### 3. 内部進化の survivorship 除去（課題2 / 選択肢 P）

- ADR 0002 の B 層が live 版を `baseStrategies` へ収穫する際、**live で生き残った版だけを拾わない**。
- 収穫候補は **offline counterfactual paired replay** で評価する: 同一 seed・同一介入予算で **rollback あり/なしを揃えて再走**し、「負けだけ巻き戻す free option」で水増しされた成績を剥がした上で恒久化を判断する。

### 4. attribution の因果化（課題3）

- `action.type` 別の単純差分（`src/llm/attribution.ts`）に加え、主要 action について **counterfactual replay / ablation**（その action を抜いた反実 PnL との差）を導入する。
- 評価指標を PnL/IR 単独から、**exposure-adjusted alpha・drawdown・未決済ポジション・liquidity impact・他 agent への転嫁**を併記する形へ拡張し、誤帰属と報酬ハックを検知しやすくする。

### 5. レビューでの決定（2026-06-10）

外部レビュー後の議論で以下を確定した（実装の指針）:

- **survivorship 除去の作り込み**: **近似 ablation から開始**する。主要 action のみ ablation で安く水増し（「負けだけ巻き戻す free option」由来）を剥がし、full counterfactual replay は恒久化候補に限定。近似と full の乖離が大きい action だけ full replay へ昇格する。
- **柱の優先順**: 柱1（holdout/regime 分離）→ 柱2（bundle 公平採点）→ 柱3（survivorship/attribution）。柱3 は上記の近似 ablation スタート。
- **ADR の位置づけ**: 本 ADR は ADR 0001/0002 を **supersede せず補完**。**0003 → 0004 の順**で段階導入し、効果確認後に Accepted へ。

## Consequences

### Positive

- `baseStrategies`（恒久ライブラリ）が unseen regime で崩れにくくなり、ADR 0002 の自己改善が「汎化する改善」に近づく。
- survivorship 除去により、自己強化ループ（risky 改変→負けだけ巻き戻し→生存版収穫）の暴走リスクが下がる。
- bundle 単位・均一予算の採点で、コンペの公平性が「戦略の質」に収束する（LLM を多く呼べた者勝ちにならない）。
- 因果的 attribution により、LLM の誤学習（防御的収束）と報酬ハックを早期に検知できる。

### Negative

- **評価コストが増える**（regime family × holdout × counterfactual replay で run 本数が増大）。
  - → train は軽量・holdout は恒久化直前に一度だけ、と頻度を分ける。`local sim roster size limit`（同一 anvil 並行起動の干渉）に留意し直列化する。
- **counterfactual replay の実装が重い**（rollback あり/なしの揃った再走、ablation 再走）。
  - → まず主要 action のみ ablation、full replay は恒久化候補に限定して段階導入する。
- **均一 call budget の設計が難しい**（subscription/apikey でレート特性が違う）。
  - → budget は「呼び出し回数 × 実行時間」で抽象化し、バックエンド差は ADR 0002 のコスト表を基準に正規化する。

### Risks

- **holdout が固定化されて二次的な過適合を招く**（holdout に対する overfitting）。
  - → holdout の seed/regime はローテーションし、恒久化の都度更新する。封印解除の記録を残す。
- **counterfactual の近似が甘いと survivorship を取り切れない**。
  - → 近似 ablation と full replay の乖離を定期的に測り、乖離が大きい action は full replay へ昇格する。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| 均一 call budget の具体値（回数/時間） | バックエンド差の実測が要る | 柱2 実装時の follow-up |
| holdout の seed/regime 集合とローテーション規則 | holdout 自体の overfitting を避ける運用設計が要る | 柱1 実装時 |
| regime family の定義（どの drift/vol/flow を「別レジーム」とするか） | 実測しながら決めるべき | 柱1 実装時 |

## Notes

### 参考資料

- ADR 0001: 多エージェント競争プラットフォーム（`docs/adr/0001-multi-agent-competition-platform.md`）
- ADR 0002: LLM 戦略自己改善の2層アーキテクチャ（`docs/adr/0002-llm-strategy-self-improvement-two-layer.md`）
- ADR 0003: 競争環境の識別力ハードニング（テーマ A。本 ADR と対）（`docs/adr/0003-competition-env-generalization-hardening.md`）
- 外部レビュー: codex CLI によるアーキテクチャレビュー（2026-06-09 実施。本 ADR の課題1〜3 の出典）
- 関連コード: `scripts/evaluate.ts` / `src/multiSeedRun.ts`（多 seed 評価）、`src/discrimination.ts`（識別力判定）、`src/llm/claudeAgent.ts`（live rollback）、`src/llm/attribution.ts`（帰属）、`src/llm/baseStrategies.ts`（恒久化対象）
