# ADR 0012: 自己改善 base 戦略レパートリーの拡充（多様化）

## Status

Proposed

> ADR 0002（自己改善2層）の **共有コア `baseStrategies.ts`** を対象に、自己改善エージェントが
> シードできる base 戦略の**種類**を増やす方針と優先順位を記録する。実装機構は変えず、
> レパートリーの拡張ロードマップを定義する。

## Context

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータ。
自己改善エージェントは単一の汎用ラッパー（`examples/agents/claude-llm.ts` = `src/llm/claudeAgent.ts`）
で動き、`ERIS_LLM_AUTH`（`codex`/`claude`/…）でバックエンドを切り替え、`ERIS_BASE_STRATEGY=<id>`
で **base 戦略を v1 として決定論シード**し、以降 LLM revise が磨く（ADR 0002）。

base 戦略は `src/llm/baseStrategies.ts` にあり、executor（`(obs, params, helpers) => AgentAction` の
関数本体文字列、`node:vm` サンドボックスで毎ラウンド実行・ラウンド跨ぎ状態なし）として表現される。
現在 **16 種**: `arb` / `venue` / `crossvenue` / `cvbal` / `statarb` / `lp` / `fairmm` / `jitlp` /
`ladder` / `aave` / `aaveloop` / `lpyield` / `gmxperp` / `gmxrev` / `gmxtrend` / `dnlp`。

評価土俵は **AMM-only**（`ENABLED_PROTOCOLS=uniswap,balancer,curve`）＋ **USDC-only / α-clean**
（ADR 0007、[[usdc-only-funding-for-alpha-clean-eval]]）が標準。実走ロスター `agents.mixed30.json` も
自己改善 18 体すべてが AMM 系 base（`crossvenue`/`cvbal`/`venue`/`arb`/`statarb`）を循環している。

### 解決したい課題

- **16 種のうち評価土俵で実効性があるのは AMM 系 9 種に偏っている。**
  - `gmx` 系 4 種（`gmxperp`/`gmxrev`/`gmxtrend`/`dnlp`）は realtime で **keeper が注文を執行せず約定しない**
    （[[gmx-realtime-keeper-no-execute]]）。
  - `aave` 系 3 種（`aave`/`aaveloop`/`lpyield`）は評価土俵が AMM-only のため protocol 無効で機能しない。
- **経済ガス軸（ADR 0011）で「入札を学習する」base が `arb` 1 種だけ。** 他の裁定 base は priority fee 固定。
- **stress 軸（ADR 0009）の清算（liquidator）base が無い。** 清算は `examples/agents/liquidator.ts` の
  固定ルールのみで、タイミング/入札を自己改善できない。
- `executor` が返せる `AgentAction` は `swap`/`balancerSwap`/`curveSwap`/`bundle`/`mintLiquidity`/
  `aaveSupply`/`aaveBorrow`/`gmxIncrease`/`gmxDecrease`/`noop` のみで、**`rawTx` を返せない**。
  flash loan / 清算など rawTx 起動の戦略は executor 形式へそのまま移植できない。

```
現状の base 16 種（実効性で分類）
┌─ 評価土俵(AMM-only)で機能する 9 種 ────────────────────────────┐
│  arb  venue  crossvenue  cvbal  statarb   ← 裁定（入札は arb のみ） │
│  lp   fairmm  jitlp  ladder                ← LP / MM                │
└──────────────────────────────────────────────────────────────────┘
┌─ 死蔵 7 種（前提インフラ/土俵が無く noop） ───────────────────────┐
│  gmxperp gmxrev gmxtrend dnlp  ← keeper 未執行で約定しない          │
│  aave aaveloop lpyield         ← aave protocol が評価土俵で無効     │
└──────────────────────────────────────────────────────────────────┘
未移植の固定戦略（examples/agents、base 候補）
   adaptive-arb(入札/swap) flash-arb(rawTx) liquidator(rawTx)
   inv-hedge(gmx) spot-hedge(現物) aave-arb(aave)  …
```

### 検討した選択肢

1. **現状維持** — 16 種で十分とし拡充しない。
2. **既存固定戦略を base へ移植** — `examples/agents/` の未移植戦略を executor 形式へ移し、移植容易な
   ものから取り込む。
3. **死蔵 7 種の前提を修復** — gmx keeper を直し、aave を評価土俵に含めて gmx/aave 系を生かす。
4. **完全新規カテゴリを発明** — triangular arb / funding carry / MEV backrun 等を新規実装。

### 各選択肢の評価

| 観点 | 1: 現状維持 | 2: 既存移植 | 3: 死蔵修復 | 4: 新規発明 |
|------|------------|------------|------------|------------|
| 多様性の増分 | なし | 中（移植元の数だけ） | 大（9→最大16 実効化） | 大 |
| 実装コスト | 0 | 小〜中（rawTx 戦略のみ中） | 中〜大（keeper 調査/土俵設計） | 大 |
| 評価土俵での即効性 | — | 高（AMM 系は即動く） | 低（前提整備が先） | 中 |
| α 支配（ADR 0007）への影響 | 中立 | 低（裁定中心は中立） | 低 | **高リスク**（ディレクショナルは β 混入） |
| 既存資産の活用 | — | ◎（移植元あり） | ◎（死蔵を蘇生） | ✗（ゼロから） |

選択肢 1 は「多様な戦略をサポートしたい」という要求を満たさない。選択肢 4 は最も自由度が高いが、
ディレクショナル/モメンタム系は β を持ち込み α 支配を壊す（[[discrimination-needs-delta-neutral-not-flow]]）
ため識別力を毀損するリスクが高く、優先度は最後。**選択肢 2 と 3 は既存資産を活用でき、移植容易性と
評価土俵での実効性で段階化できる**ため、両者を組み合わせて段階導入する。

## Decision

**自己改善エージェントが選べる base 戦略のレパートリーを、「移植容易性 × 評価土俵での実効性 ×
カテゴリ新規性」の3軸で段階拡充する。第1段は executor 形式に収まる `adaptive-arb` を追加、第2段は
executor に `rawTx` アクション型を導入して `flash-arb`・`liquidator` を base 化、第3段は gmx keeper と
aave 土俵を修復して死蔵 7 種を蘇生する。α 支配（ADR 0007）を壊すディレクショナル系は当面追加しない。**

### 1. Tier 1 — `adaptive-arb` を base 追加（executor で完結・即効）

`examples/agents/adaptive-arb.ts` は競争シグナル（`obs.competition`、ADR 0011）を見て「機会価値を
超えない範囲で勝てる最小限」を priority fee に入札する arb。`swap` を返すだけで executor 形式に収まり、
rawTx もアクション型拡張も不要。現 `arb`（利益の固定割合 `bidProfitFraction` を機械的に積む）に対し、
**入札そのものを機会価値で最適化する**ため経済ガス軸（ADR 0011 / [[adr0011-economic-gas-progress]]）で
直接効く。

```ts
// baseStrategies.ts: 既存 ARB_EXECUTOR をコピーし、bid 決定を obs.competition ベースに差し替える
const ADAPTIVE_ARB_EXECUTOR = `… const comp = obs.competition; …
  // 勝てる最小限を、機会価値(profitWei)を超えない範囲で入札
  return { type: best.swapType, tokenIn, amountIn, maxPriorityFeePerGasWei: bid.toString(), slippageBps };`;
BASE_STRATEGIES.adaptivearb = { notes: "…", params: { …, bidMarginBps }, executorTs: ADAPTIVE_ARB_EXECUTOR };
```

`agents.mixed30.json` 等の循環 base に `adaptivearb` を組み込む。

### 2. Tier 2 — executor に `rawTx` を導入し `flash-arb` / `liquidator` を base 化

`flash-arb`（フラッシュローンで自己資金上限を超えるサイズの cross-venue 裁定 = **資本制約を外す新カテゴリ**）
と `liquidator`（Aave 清算 = **stress 軸の自己改善版**）はともに rawTx で起動する。executor が `rawTx`
アクションを返せるよう `src/llm/strategy.ts` / `src/action.ts` を拡張し、`helpers.ADDRESSES` を
**Arbitrum 値へ修正**（ADR 0002 Risks で既知の mainnet 値バグ）したうえで移植する。

- `flash-arb`: AMM-only 土俵で動く。レバレッジ裁定という既存 16 種に無いカテゴリを足す。
- `liquidator`: victim 前提のため **stress run（ADR 0009）専用**。α 識別の標準評価では noop。

### 3. Tier 3 — 死蔵 7 種を蘇生（前提インフラ/土俵の修復）

- **gmx keeper 修正**: realtime で注文が執行されない原因を調査・修正し、`gmxperp`/`gmxrev`/`gmxtrend`/
  `dnlp`（および移植すれば `inv-hedge`）を実効化する。
- **aave を評価土俵に含める**: `ENABLED_PROTOCOLS` に aave を加えるプロファイルを用意し、`aave`/
  `aaveloop`/`lpyield`（および `aave-arb`）を実効化する。ただし USDC-only / α-clean 方針
  （[[usdc-only-funding-for-alpha-clean-eval]]）との整合（初期 β 混入の回避）を設計時に確認する。

### 4. 追加しない／後回しにするもの

- **ディレクショナル/モメンタム系の新規発明**（spot trend、funding carry 等）は β を持ち込み α 支配
  （ADR 0007）を壊すため、α 識別土俵には追加しない。stress / gas など別軸が確立したら再検討。
- `simple-rule` / `rt-arb` / `raw-swap` / `rt-fee-swap` は arb の劣化版・テスト用で戦略的多様性が低く、
  base 化しない。
- `inv-hedge` / `spot-hedge` は β 畳みのデモ用（ダッシュボード実証）で α を生まないため、base 化の優先度は低い。

## Consequences

### Positive

- 自己改善が選べる戦略カテゴリが広がり、ロスターの多様性（=競争の厚み・識別の頑健性）が増す。
- Tier 1 は低コストで経済ガス軸（ADR 0011）の「入札を学習する」次元を厚くする。
- Tier 2 で executor に rawTx を入れると、flash loan・清算という rawTx 系戦略の道が開ける（将来拡張の基盤）。
- 既存資産（`examples/agents/` の固定戦略・死蔵 base）を活用するため、ゼロから発明するより安価で確実。

### Negative

- base が増えるほど revise プロンプト・回帰テスト・較正の保守対象が増える。
  - → Tier ごとに段階導入し、各 Tier で discrimination（C1/C2/C3）非劣化を確認してから次へ進む。
- executor に rawTx を許すと、LLM が誤アドレス/誤 calldata の rawTx を生成する余地が広がる。
  - → `helpers.ADDRESSES` を Arbitrum 値へ修正し、rawTx は限定ヘルパ（FlashArb/liquidationCall）経由に
    絞る。ADR 0002 の prompts「semantic action 優先・rawTx 非推奨」を rawTx base のときだけ緩める。
- gmx/aave の実効化は前提インフラ修復が重く、評価土俵の前提（AMM-only / USDC-only）を変える。
  - → Tier 3 は env プロファイルとして opt-in にし、標準評価土俵は不変に保つ。

### Risks

- **多様性を増やしても α 支配を壊せば識別力が落ちる**（特に Tier 3 の方向性露出）。
  - → 追加は裁定/delta-neutral 中心に限定し、ディレクショナル系は除外。各 Tier で C1/C2/C3 を実測。
- **flash loan / 清算は約定が contested**で、入札・着順依存が再現性（ADR 0005）を下げる。
  - → N 反復 + unpaired 統計で吸収。経済ガス（ADR 0011）の入札=実力という枠組みに乗せる。
- gmx keeper の修正コストが想定より大きく Tier 3 が停滞する。
  - → Tier 1・2 は keeper に依存せず独立に価値を持つ（段階の独立性を担保）。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| Tier 2 の rawTx アクション型の正確なスキーマ（汎用 rawTx か限定ヘルパか） | 安全性と表現力の兼ね合いを実装で見極める | Tier 2 実装時 |
| gmx keeper 未執行の根本原因と修正方針 | 調査未了（[[gmx-realtime-keeper-no-execute]]） | Tier 3 着手時に調査 |
| aave を含む評価プロファイルの初期配布（β 混入回避の具体策） | USDC-only 方針との整合設計が要る | Tier 3 設計時 |
| 完全新規カテゴリ（triangular/funding carry/MEV backrun）の採否 | α 支配への影響が未検証 | stress/gas 軸が確立した後に A/B |
| 循環ロスター（mixed30 等）への新 base の配分比 | 較正実測で決める | 各 Tier 導入後 |

## 実装ノート（2026-06-22）

設計後の実装で以下が判明・確定した（**Status は Proposed 据え置き**: Tier 3 が実走検証を残すため）。

### Tier 1 — 完成
`adaptivearb` を `baseStrategies.ts` に追加（`ADAPTIVE_ARB_EXECUTOR` + エントリ）。executor だけで完結し、`obs.competition`（ADR 0011）で「競合最高入札を marginPct 上回り profit×ceilFraction/gas で頭打ち」する入札を学習する。`base-strategies.test.ts` に動作 3 件を追加し全 35 件 pass。`marginPctNormal`/`marginPctFrontrun`/`ceilFraction`/`gapThreshold` を revise で磨けるため自己改善の実質を持つ。

### Tier 2 — flasharb は完成、rawTx は既存、liquidator は不可
- **rawTx 型の導入は不要だった**: `parseAction`/`validateAction`（`src/action.ts`）が `rawTx`/`rawBundle` を既に受理する。executor が `{type:"rawTx", tx, maxPriorityFeePerGasWei}` を返せば通る。
- **flasharb を executor 化（完成）**: `helpers` に `encodeAbiParameters` を追加し、`DEFAULT_ADDRESSES` を Arbitrum 値へ修正（ADR 0002 の mainnet 値バグも併せ解消）。`FLASH_ARB` アドレスは `claudeAgent` が **`ERIS_FLASH_ARB=1` のときだけ注入**し、未注入なら executor が noop する **env ベース self-guard**（aave base が `obs.protocols.aave` で self-guard するのと同型）。executor 内で flashLoanSimple calldata を組み rawTx を返す。test 4 件追加。
- **liquidator は executor 化不可（設計上の制約）**: RPC で victim の `getUserAccountData` を直読みする必要があり、victim は観測に含まれない原則。executor サンドボックスは network 不可なので原理的に乗らない。→ **標準 agent のまま frozen ロスターに組み込む**（追加実装不要。stress run で清算カテゴリの多様性に貢献）。

### Tier 3 — gmx keeper / aave は原因特定・整備済み、実走検証を残す
- **gmx keeper 原因特定**: realtime の `keeperTask`（`coordinator.ts:790-811`）が `afterMine` を `noMine:true` で呼び、`gmx.ts:684-702` が executeOrder を **mempool に投げるだけで mine も receipt 確認もしない**。oracle setPrice・executeOrder・注文作成が並列 mempool で**順序とブロック経過が保証されない**。対する同期経路（`gmx.ts:704-721`）は `increaseTime(2)`→`mine`→receipt 待ちで確実に約定する。GMX は実 GMX V2 をフォークで使い oracle provider のみ mock 差し替え。
  - **修正は coordinator のメインループ順序制御**（executeOrder を oracle 確定後の次ブロックで receipt 確認付き実行）で、env デーモンの中核に触る。ADR 0006/0009/0011 の順序保証（oracle 最前列）への**回帰テストと anvil 実走での revert reason 確認**が前提。回帰環境を整える前の盲目編集は評価基盤を壊すため行わない → **実走デバッグを次ステップとする**。
- **aave 整備**: `ENABLED_PROTOCOLS=uniswap,balancer,curve,aave` で aave アダプタが有効化され `aave/aaveloop/lpyield` base が動く下地は実装済み。ただし **aave supply は WETH 担保が要り、USDC-only（`INITIAL_WETH_WEI=0`）の α-clean 方針と衝突**するため、`INITIAL_WETH_WEI` で担保を配る専用プロファイル `agents.aave-eval.json` を用意した。realtime での実効性は **anvil 実走で要検証**。

### 実走検証（2026-06-22、anvil Arbitrum fork、20 block 単発 sim:realtime）
- **adaptivearb**: ✅ frozen で実走。20 ラウンド全て swap、入札ロジックが動作（`comp=1gwei→bid=2gwei` margin / `comp=0→bid=1gwei` floor / `comp=6gwei→bid=5gwei` ceiling 頭打ち）。netPnl +753 USDC、violations なし、再構成 failedReads 0。
- **flasharb**: executor は正しい calldata（to=Aave Pool / flashLoanSimple / receiver=FlashArb / asset=USDC / amount / profitTo）を生成したが、**realtime coordinator に FlashArb デプロイが欠けていた**（同期 `coordinator.ts:279-288` にはあるが realtime に未移植）ことを実走で発見。receiver にコードが無く flashLoanSimple が revert（全 tx submit_failed）。`src/realtime/coordinator.ts` の setup に同期版と同じ gate（`flashArbDemo && aave && uniswap && balancer`）で `deployFlashArb` を追加 → `ENABLED_PROTOCOLS=...,aave ERIS_FLASH_ARB=1` で再走し **rawTx 2 件着弾・revert 0・netPnl +3294 USDC** で完全動作。setup フェーズの 1 回デプロイで interval mining / 順序保証には不干渉（gmx keeper の mempool 順序問題とは別性質）。**flasharb は ENABLED_PROTOCOLS に aave を含める必要**がある（FlashArb の gate と Aave Pool flashLoan のため）。
- **aave base**: ✅ frozen で `aave`(aaveSupply 2→aaveBorrow 2) / `aaveloop`(aaveSupply 2→aaveBorrow 5) / `lpyield`(mintLiquidity 3→aaveSupply 17) が action を出し included。`ENABLED_PROTOCOLS=...,aave` + WETH 担保配布で aave 系 base は realtime で機能する（USDC-only だと担保不足で不可）。
- **gmx keeper**: 実走で **当初の原因仮説（mempool 順序・executeOrder 投げっぱなしで未執行）が誤りと判明**。blocks.csv では keeper の executeOrder は **7 件すべて success**、gmxperp の gmxIncrease も included されるが **gmx position が建たない**（netPnl −112=gas のみ）。GMX が注文を execute せず**キャンセル**している。acceptablePrice は `looseAcceptablePrice` で max/0（無制限）、`MockOracleProvider` の timestamp は `block.timestamp` で鮮度常時通過 → **これらは無罪**。同期経路との決定的差は executeOrder 前の `increaseTime(2)`（`gmx.ts:704`、realtime は 685 でスキップ）。真因（oracle min/max range / 注文 expire / collateral 最小等）の確定には **GMX EventEmitter の OrderCancelled reason の実走取得（可視化実装）が必要 = 次ステップ**。→ 修正は coordinator mempool 順序ではなく gmx.ts 局所の可能性が高く、当初想定より軽い見込み。

## Notes

### 参考資料

- ADR 0002（LLM 戦略自己改善の2層）— 本 ADR が拡張する共有コア `baseStrategies.ts` / `ERIS_BASE_STRATEGY` シード機構
- ADR 0005（statistical evaluation after realtime）— 新 base の受理は N 反復 + 統計ゲートで判定
- ADR 0007（shift env toward alpha dominance）— ディレクショナル系を除外する根拠（α 支配の保全）
- ADR 0009（market stress events and liquidations）— `liquidator` base（Tier 2）と stress 軸
- ADR 0010 / 0011（gas 経済コスト化）— `adaptive-arb`（Tier 1）の入札が効く軸
- 実装: `src/llm/baseStrategies.ts`（base 定義）/ `src/llm/strategy.ts`・`src/action.ts`（executor アクション型・Tier 2 で rawTx 追加）/ `examples/agents/{adaptive-arb,flash-arb,liquidator,aave-arb}.ts`（移植元）
- メモリ: [[gmx-realtime-keeper-no-execute]] / [[usdc-only-funding-for-alpha-clean-eval]] / [[discrimination-needs-delta-neutral-not-flow]] / [[adr0011-economic-gas-progress]] / [[mixed30-roster-plan]]
