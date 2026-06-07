# ADR 0002: LLM 戦略自己改善の2層アーキテクチャ（live online × offline gated）

## Status

Proposed

## Context

本シミュレータ（ADR 0001: 多エージェント競争プラットフォーム）には、戦略を LLM が自己改善する仕組みがある。

現状の構成:

- **戦略表現**: `Strategy = { notes, params, executorTs }`。`executorTs` は `(obs, params, helpers) => AgentAction` の関数本体文字列で、`node:vm` サンドボックス（200ms / network・import 不可 / **ラウンド跨ぎの状態を持てない**）で毎ラウンド実行される（`src/llm/strategy.ts`）。
- **ベース戦略ライブラリ**（`src/llm/baseStrategies.ts`）: 既存ルール戦略を executor 形式へ移植した v1 シード（現在 arb / lp / venue / aave / statarb / cvbal / dnlp / gmxperp / gmxrev / gmxtrend / fairmm / jitlp / ladder の 13 種）。`ERIS_BASE_STRATEGY=<id>` で claude-llm が v1 として決定論シードする。
- **live revise**: sim 実行中、claude-llm エージェントが N ラウンドごと（既定 10）に `claude -p`（print mode CLI）を**背景で** spawn し、単一 JSON `{notes, params, executor_ts}` を受け取って戦略を差し替える（`src/llm/claudeCliStrategist.ts` / `src/llm/prompts.ts` の `buildReviseMessage`）。**品質ゲートは無く即適用**。
- **offline 進化**: `/strategy-evolve` スキルが、マルチシードのペアゲート（`src/multiSeedRun.ts`）で過学習を抑えつつ 1 agent / 1 変更ずつ進化させ、勝者を恒久化する想定。

実走で以下が観測・確認された:

- 13 戦略すべてが live で実際に自己改善できる（`ERIS_LLM_CALL_TIMEOUT_MS` 緩和＋ revise スケジュール分散で revise 24/24 成功、各 v2〜v4）。
- 一方で **LLM が存在しないバグを「修正」して劣化させる**ことがある（例: `venue` の revise が「`balancerSwap`/`curveSwap` は無効」と誤認。実際は `src/action.ts` が受理する有効 action）。live には品質ゲートが無いため、この劣化がそのまま適用される。
- `claude -p` は `--disallowed-tools` に `SlashCommand` 等を含み、かつ単一 JSON・高速・背景実行が要件のため、**live revise でスキルは使えない／使うべきでない**。
- 改善のフィードバックが「自分の直近 12 ラウンド＋集計 PnL%」のみで、**何が効いて何が損したかの帰属（attribution）が弱い**。探索も漸進 refine のみで単調。

### 解決したい課題

- live の自己改善で**ハルシネーションによる劣化を即適用してしまう**。
- 改善判断の材料が弱い（**帰属・メモリ・レジーム情報が無い**）。
- 探索が単調（**単一候補・漸進のみ**で戦略空間を広げられない）。
- 「より自己改善を促す仕組み」を、live の高速・ツール無し制約と両立させたい。

### 検討した選択肢

1. **live revise のプロンプト/ロジックだけ強化**（単層・online のみ）
2. **offline スキル（`/strategy-evolve`）だけ強化**（単層・offline のみ。live は現状維持）
3. **live revise を Claude Code スキル化**して高機能化（スキルで帰属・ゲート・多候補を担わせる）
4. **2層アーキテクチャ（本 ADR の採用案）**: live（online・プロンプト強化＋弱ゲート）と offline（agentic スキル・強ゲート・恒久昇格）を、共有コアで連携させる

### 各選択肢の評価

| 観点 | 1: live のみ | 2: offline のみ | 3: live をスキル化 | 4: 2層（採用） |
|------|---|---|---|---|
| 劣化（ハルシネ）抑止 | △ 文言のみ・実測不可 | ○ 強ゲート | ○ | ◎ live弱＋offline強 |
| 改善の実測検証 | ✗ chain再実行不可 | ◎ multi-seed PnL | ◎ | ◎（offlineが担当） |
| live での即時適応 | ◎ | ✗ 無い | △ 多ツールで遅延/ハング | ◎ |
| 実装コスト | 低 | 中 | 高（CLI制約と衝突） | 中（段階導入可） |
| `claude -p` 制約との整合 | ◎ | n/a | ✗ skill不可・単一JSON崩れる | ◎（liveは非skill） |
| 探索の多様性 | △ | ○ 多候補 | ○ | ◎ |

選択肢 3 は、`claude -p` がスキルを使えない／単一 JSON・高速要件と本質的に衝突するため不採用。選択肢 1・2 は片肺。**両者は別レイヤーで補完し合い、共有表現（`Strategy`）でループを閉じられる**ため、選択肢 4 を採用する。

## Decision

**LLM 戦略自己改善を「A: in-sim online revise（プロンプト強化＋ sanity ゲート）」と「B: offline agentic 進化スキル（強ゲート＋恒久昇格）」の2層に分け、`prompts.ts` / `Strategy` 表現 / `multiSeedRun` ゲート / `baseStrategies.ts` / change→result メモリ からなる共有コアで連携させる。スキル化は B（offline）にのみ適用し、A（live）は `claude -p` の単一 JSON・高速・ツール無し設計を維持する。**

### 1. レイヤー構成と責務

```
        ┌──────────── 共有コア（単一ソース）────────────┐
        │ prompts.ts（SYSTEM/SIM_RULES/反ハルシネ/出力契約）│
        │ strategy.ts（Strategy型 + parse/validate + 帰属）│
        │ baseStrategies.ts ← B が勝者を書き戻し / A が seed │
        │ multiSeedRun.ts（ペアゲート）A=弱 / B=強 で再利用  │
        │ memory（change→result 履歴）A も B も読む          │
        └──────┬───────────────────────────┬─────────────┘
   seed(ERIS_BASE_STRATEGY)│               │ 候補(live strategy-vN を収穫)
                           ▼               ▲
   A: in-sim online                   B: offline skill (/strategy-evolve)
   ・Nラウンドごと claude -p revise     ・run診断→多候補→強ゲート→恒久昇格
   ・単一JSON / 高速 / ツール無し        ・baseStrategies.ts へ commit
   ・sanity ゲートで劣化を即適用しない    ・live版を候補に収穫
        └──── 改良版を供給 ──► B ──── 良seed を底上げ ──► A
```

- **A（live / online）**: その run 内で戦略を適応。真の PnL ゲートは持てない（chain 再実行が必要）ため、**コンパイル＋直近観測での valid-action / 非退化チェック（sanity ゲート）**に限定。
- **B（offline / agentic）**: run を実走して**真の multi-seed PnL でゲート**し、勝者を `baseStrategies.ts` に恒久昇格。スキルなのでフルツール（Bash で sim 実行、ログ Read、ペア replay）・多ターン・メモリ運用が可能。

### 2. 共有データ構造

```ts
// 帰属（RoundRecord.inventoryUsd 差分を action.type で集計。新規プラミング不要）
type Attribution = { byAction: Record<string,{rounds:number; netUsd:number; valid:number; failed:number}>;
  topNoopReasons: Array<[string,number]>; drawdownUsd:number; turnover:number };

// Change Contract（revise 出力 JSON を拡張。executor 改変時のみ重く）
type StrategyOutput = { notes:string; params:object; executor_ts:string;
  change_type:"params_only"|"executor_logic"; hypothesis:string;
  expected:string; rollback_condition:string; why_executor_change?:string };

// Memory レコード（runs/strategy-iterations/ + 共有 memory）
// 例: "v3 (params_only): gapThreshold 0.0008→0.0012 -> fail率↓ / PnL -1.2% → 却下, 旧版維持"
```

### 3. A（live）の変更点（ファイルフック）

- `src/llm/prompts.ts`: `SYSTEM_PROMPT` に**反ハルシネ規則**（観測に無いバグを仮定しない／executor 改変は直近ログの具体的失敗を引用／不明なら no-change）を追記。`buildReviseMessage` に **Attribution ブロック**と **Memory 直近数件**を追加し、**Change Contract を必須・既定 params-only** とする。
- `src/llm/strategy.ts`（`parseStrategyFromToolInput`）: Change Contract を optional メタとして受理し、**`change_type!=="executor_logic"` のとき `executor_ts` を無視して `prev.executorTs` を流用**（無根拠な executor 改変を構造的に封じる）。
- `src/llm/claudeAgent.ts`（revise 適用点 `state.strategy = result.strategy`）: **sanity ゲート**を挿入。State に直近 K 個の `AgentObservation` をリング保存し、新 executor がそれらで「valid な非 noop を 1 つ以上出す／全 noop 退化でない」ことを確認。満たさねば旧版維持＋却下理由を memory へ。
- `src/llm/claudeCliStrategist.ts`: 構造変更なし（単一 JSON のまま、中身に Change Contract が乗る）。

### 4. B（offline）の変更点（`/strategy-evolve` スキル）

1. マルチシード baseline run（既存）
2. **帰属診断**: `events.jsonl` の per-round inventory 系列＋ action ログから最弱 agent と出血 action を特定（既存の最弱診断を attribution ベースへ）
3. **多候補生成**: exploit 版＋ explore 版を K 個（各 Change Contract 付き・共有 prompts を使用）
4. **強ゲート**: `multiSeedRun.ts` で旧版 vs 候補を paired 実走 → PnL/DD/失敗率で非劣化の勝者のみ採用
5. **恒久昇格**: 勝者を `baseStrategies.ts` の該当ベースへ書き戻し commit。過去 live run の `agent-*/strategy-vN` も候補として収穫（A→B 供給路）
6. **メモリ**: change→result を蓄積し A の `buildReviseMessage` に注入

### 5. 段階導入

A-1（prompts 文言: 反ハルシネ＋ params-only 既定＋ Change Contract）→ A-2（Attribution ブロック）→ A-3（live sanity ゲート）→ B-1（帰属診断＋多候補＋強ゲート昇格）→ B-2（live 版収穫＋ memory 共有でループ閉）。各段は独立に価値を持つ。

## Consequences

### Positive

- live の即時適応と offline の厳格検証を**両取り**できる（探索 = live、昇格 = offline）。
- 共有表現（`Strategy`）と共有コアにより、**A↔B が相互強化**（A が改良ネタを供給、B が良 seed を底上げ）。
- `claude -p` の制約（skill 不可・単一 JSON・高速）を壊さずに自己改善を強化できる。
- ハルシネ劣化を、A=構造的抑止（params-only 既定・反ハルシネ）＋ sanity、B=実測ゲートの**二重**で防げる。

### Negative

- 仕組みが2層になり**複雑度が増す**。
  - → 共有コアに一元化（prompts/strategy/multiSeedRun/baseStrategies/memory）し、二重実装・文言乖離を避ける。
- B はトークン・計算コストが大きい（multi-seed × 多候補）。
  - → `/strategy-evolve` は元々マルチシード前提。候補数 K と頻度を抑え、A で安価に探索してから B で選別。
- live sanity ゲートは**真の PnL を見ない**ため、PnL を悪化させる「正気だが弱い」変更は通り得る。
  - → 恒久昇格は必ず B の real PnL ゲートを通す。live の劣化は run 内に限定され、実行時 `parseAction→noop` で暴走は阻止される。

### Risks

- **メモリの陳腐化**: 古いレジームの「効いた変更」に引きずられる。
  - → memory に regime タグを付け、直近・同一 regime を優先注入。
- **ゲートが保守的すぎて探索が止まる**: 非劣化条件が厳しいと改善が採用されない。
  - → A は探索を許容（弱ゲート）、B のみ厳格。閾値は P1/P3 データで調整（ADR 0001 の識別力ハーネスと整合）。
- **`helpers.ADDRESSES` が mainnet 値**（`strategy.ts`）: LLM が `rawTx` 方向へ revise すると Arbitrum 上で誤アドレスになる潜在バグ。
  - → 当面 prompts で「semantic action（swap/mintLiquidity 等）優先・rawTx は非推奨」を明示。別途アドレス修正を検討。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| 帰属の精緻度（手数料/スリッページ/約定後価格まで含めるか） | まず inventoryUsd 差分の安価版で十分か見極める | A-2 実装後のデータで判断 |
| 多候補数 K と explore/exploit 比 | コストと効果のバランスを実測で決める | B-1 実装後 |
| live sanity ゲートの合否基準（非退化の定義） | 過度に塞ぐと探索が死ぬため実走で調整 | A-3 試走後 |
| competitor/regime 特徴量を観測へ常設するか | 過剰適合リスクがあり効果未検証 | B-1 以降に A/B テスト |

## Notes

### 参考資料

- ADR 0001: 多エージェント競争プラットフォーム — 環境の「識別力」を主軸に（`multiSeedRun.ts` のペアゲート / 識別力ハーネスは本 ADR の B 強ゲートの土台）
- 主要モジュール: `src/llm/prompts.ts` / `src/llm/strategy.ts` / `src/llm/baseStrategies.ts` / `src/llm/claudeAgent.ts` / `src/llm/claudeCliStrategist.ts` / `src/llm/history.ts` / `src/multiSeedRun.ts`
- スキル: `/strategy-evolve`（offline 進化, 対象ロスター `agents.evolve.json`）/ `/sim-loop`
- 経緯: `claude -p` はスキル不可（CLI help: `--disable-slash-commands`=「Disable all skills」/ skills は `/skill-name` で解決）。live revise は `--disallowed-tools` で `SlashCommand` 等を無効化しているため、自己改善プロンプトのスキル化は offline(B) のみが適切、という結論に至った。
