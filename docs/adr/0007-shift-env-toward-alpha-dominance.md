# ADR 0007: env を α 支配へ寄せる（β 抑制 + delta-neutral cross-venue スプレッド構造注入）

## Status

Proposed

## Context

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータで、環境の
**識別力**（賢い戦略を運から安定に分離できるか。ADR 0001 P1）を `npm run discrimination` の
C1/C2/C3 で測る。価格は平均回帰（OU 型）の fair price（`src/rng.ts` `nextFairPrice`、
env `ERIS_PRICE_REVERT_KAPPA`/`_VOLATILITY`/`_DRIFT`）で、cross-venue delta-neutral 裁定が
識別力の決定打だった（ADR 0001/0003、discrimination-needs-delta-neutral）。

### 解決したい課題

netPnl は `β·(P_T − P_0) + α·(cross-venue spread 捕捉)` に分解できる。ここで β = 方向
（純 WETH 在庫）エクスポージャ、α = 裁定スキル。採点（`src/realtime/reconstruct.ts`）は
WETH 在庫を**各ブロックの fairPrice でマーク**するため、β PnL = 純 WETH 在庫 ×（終値 fairPrice − 始値）
になる。regime（=SEED）は RNG パスのみを変え vol/kappa は global なので、β windfall は
「seed ごとの終値乖離の引き」に等しい。

直近の自己改善検証（selfimprove-validation-synthesis）で、**この土俵の支配的利益源は α でなく β**
であることが確定した:

- 既定 env（kappa=0.02）では終値の anchor 乖離が大きく、方向 β の運が PnL を支配する。
- その結果、戦略間の優劣が「市場スタイルの regime 適合（β）」で決まり、順位が regime で反転する
  （C2 失敗）。でたらめ売買（random）が方向の運で賢い裁定に並ぶ。
- 本番コンペ（competition-submission-format）で「賢い自己改善」を選別するには、優劣が
  スキル（α）で決まる土俵が要る。

本 ADR の deterministic ロスター `agents.crossvenue.json`（crossvenue=α 裁定 / venue-arb=単 leg
方向 β / random / noop）・REGIMES=3,4・REP=2・RUN_BLOCKS=120 のベースラインでこれを再現した:

```
判定 FAIL（C1 PASS / C2 FAIL / C3 PASS）
  C2 Spearman = 0.000（regime 3↔4 で順位が完全スクランブル）
  random: PnL median +97, IR 0.041（熟練の venue-arb IR −0.014 を上回る）
```

### 検討した選択肢

1. **採点を β 中立化**（在庫を固定参照価格でマークし α だけを採点）
2. **env を α 支配へ寄せる**（価格の平均回帰を強めて β を潰し、cross-venue α を構造的に増やす）
3. **戦略側を真の delta-neutral 化**（cross-venue-arb の 2 leg を価格で揃え残留 β を消す）

### 各選択肢の評価

| 観点 | A: 採点 β 中立化 | B: env を α 支配へ | C: 戦略 delta-neutral 化 |
|------|------------------|--------------------|--------------------------|
| 問題の所在を直す | 採点を変える（土俵は β 支配のまま） | 土俵自体を α 支配へ | 1 戦略のみ。別の β-carrier は依然勝てる |
| netPnl 採点の維持 | netPnl の意味が変わる | 維持（β の EV を 0 にする） | 維持 |
| 一般性（任意戦略に効く） | 採点ハック化の懸念 | 全戦略に一様に作用 | 戦略個別で非一般的 |
| コンペ本番への適用 | 提出物の採点を変える必要 | env プロファイルとして配布可 | 戦略は提出者依存で制御不可 |
| 後方互換 | 採点系の破壊的変更 | env 既定 off で互換維持可 | 互換 |

選択肢 A は「土俵を直さず採点で隠す」形で、別の β-carrier が現れれば再発する。C は env でなく
戦略の問題に矮小化する。**B が「環境の識別力」という本来の問題に正面から効き、netPnl 採点を
保ったまま全戦略へ一様に作用し、env プロファイルとして本番にも配布できる。**

## Decision

**fair price の平均回帰を強めて方向 β の期待値を 0 に近づけ（β 抑制）、毎ブロック delta-neutral な
cross-venue スプレッドを構造的に注入して裁定 α を厚くする（α 増幅）。両者を env 可変・既定 off の
「α 支配プロファイル」として導入する。**

### 1. β 抑制 — 平均回帰の強化（env のみ・コード変更なし）

`ERIS_PRICE_REVERT_KAPPA` を 0.02 → **0.15** にする。半減期が ~35 → ~4.6 block に縮み、
run 終了時の fair price がほぼ anchor に戻る（実測 終値 fairPrice ≈ anchor）。→ β PnL ≈ 0 を
**全 regime で一様に**。方向の運が消え、価格水準に依らない cross-venue α だけが残る。

### 2. α 増幅 — delta-neutral cross-venue スプレッド注入（新規 `FlowKind "spread"`）

`src/flow/logic.ts` に `buildCrossVenueSpreadFlow` を追加。毎ブロック、有効な AMM venue
（uniswap/balancer/curve）から 2 つを選び、一方で WETH を買い上げ（USDC→WETH、価格↑）、
他方で**同じ WETH 相当**を売り下げる（WETH→USDC、価格↓）。

```ts
// fair 周りに対称な spread を開ける → 2 leg の市場インパクトが相殺 = delta-neutral。
// その spread は「安い venue で買い・高い venue で売る」2-leg 裁定(α)だけが取れる:
//   - 単発 swap の random は片側しか取れず逆 leg の戻りで損になり得る → α を運で拾えない
//   - 単 venue β-carrier も各 venue が fair から半分しかズレず取り分小
const wethEquiv = randomBigInt(rng, maxWethWei / 4n, maxWethWei);
// up leg: USDC→WETH on upVenue / down leg: WETH→USDC on downVenue（同 wethEquiv = delta-neutral）
```

- config `crossVenueSpreadFlowMaxWethWei`（env `CROSS_VENUE_SPREAD_FLOW_MAX_WETH_WEI`、**既定 0 = off**）。
  0 のとき rng を一切消費せず空返し → 既存 flow と byte 互換（後方互換）。
- 専用の `FlowKind "spread"` ウォレット（venue ごと）を用意し、同一 venue の uninformed/informed
  leg と **nonce/fee 順序で干渉させない**。注入で枯れないよう cheatcode で深く資金供給する。
- 補助 `INFORMED_FLOW_MAX_WETH_WEI` 2e18 → **5e17**。cross-venue-arb / random は
  `defaultPriorityFeePerGasWei`（低 fee）で約定するため informed flow（default+rng50-100）に
  順序で負ける。informed が強いと注入 α を arb より先に潰すので、弱めて arb に残す。

```
α 支配プロファイル（env レシピ。runs/alpha-dominance/run-after.sh）:
  ERIS_PRICE_REVERT_KAPPA=0.15
  CROSS_VENUE_SPREAD_FLOW_MAX_WETH_WEI=2000000000000000000   # 2 WETH/leg
  INFORMED_FLOW_MAX_WETH_WEI=500000000000000000              # 0.5 WETH
```

### 3. 実証（同一ロスター・env のみ変更）

| metric | BEFORE（既定 env） | AFTER（α プロファイル） |
|---|---|---|
| verdict | ❌ FAIL | ✅ **PASS** |
| C2 Spearman（順位安定） | 0.000 | **0.600** |
| C2 gap CV | 0.646 | 0.133 |
| random PnL median | +97.0（β 運） | **−56.2**（損） |
| crossvenue paired CI 下限 | +124 | +210 |
| venue-arb baseline 超え | ✗ | ✓ |

AFTER は skilled（crossvenue, venue-arb）が両 regime で常に上位・random/noop が常に下位、
random の方向 β 運が消えて負ける。注入は実働（spread flow ≈ 2 tx/block）。

## Consequences

### Positive

- 環境の識別力が β 支配の FAIL から α 支配の PASS へ反転。優劣が **スキル（α）で regime 横断に
  安定** して決まる土俵になった（C1/C2/C3 同時 PASS）。
- 採点（netPnl）を変えずに達成。β の期待値を 0 に寄せたので netPnl が自然に α を選ぶ。
- env 可変・既定 off で既存評価と互換。α プロファイルは env レシピとして本番へ配布可能。

### Negative

- α プロファイルは 3 つの env を同時に変える複合変更で、個別レバーの寄与は未分離。
  - → 必要なら ablation（注入のみ / kappa のみ）で寄与を切り分ける。実装は env で個別に効かせられる。
- 注入は主に浅い balancer（seed 200 WETH）を動かすため、venue 間で価格インパクトが非対称。
  - → WETH 名目は両 leg 対称（delta-neutral は名目で成立）。spread が片 venue 集中でも α は capturable。

### Risks

- N=2 reps と少なく C2 Spearman 0.600 は閾値 0.5 に近い（統計的余裕が小）。
  - → 本採用前に REPLICATIONS を増やして硬化する。
- top 内順位（crossvenue ↔ venue-arb）は regime で揺れる（venue-arb の残留 β が一部 regime で効く）。
  - → 「最良戦略が常に首位」まで詰めるには kappa↑ か α 集中で追い込む。本 ADR の主目的
    （skill ≫ luck、random を報酬から排除）は達成済み。
- 注入ウォレットの枯渇で leg が revert すると注入が不整合になる。
  - → leg サイズ × run 長で枯れない深さを cheatcode で供給済み。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| α プロファイルを既定値へ昇格するか | 既存ベースライン（kappa 0.02 前提の評価）を無効化する破壊的変更 | LLM ロスター再評価で有効性を確認後 |
| LLM 自己改善ロスターでの再評価 | 高コスト（claude -p 並走）で本 ADR のスコープ外 | 別途。本丸の続き |
| 個別レバーの寄与分離（ablation） | 主目的（α 支配の実証）は複合で達成済み | 寄与の最小化・調整が必要になったとき |

## Notes

### 参考資料

- ADR 0001（multi-agent competition platform）— 識別力 C1/C2/C3 の定義
- ADR 0005（statistical evaluation after realtime）— regime×N 反復 + paired/unpaired 統計
- ADR 0006（separate environment from agent execution）— flow は環境側の市場機構・採点は run 後再構成
- メモリ: discrimination-needs-delta-neutral-not-flow / selfimprove-validation-synthesis /
  env-alpha-dominance-achieved
- 実験ログ: `runs/alpha-dominance/iteration-log.md`、再現スクリプト: `runs/alpha-dominance/run-after.sh`
- 実装: `src/flow/logic.ts`(`buildCrossVenueSpreadFlow`) / `src/protocols/types.ts`(`FlowKind "spread"`) /
  `src/config.ts` / `src/coordinator.ts` / `src/realtime/coordinator.ts` / `test/flow.test.ts`
