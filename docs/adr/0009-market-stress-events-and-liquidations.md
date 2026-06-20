# ADR 0009: 市場ストレスイベント（価格スパイク／クラッシュ）の注入と Aave 清算の誘発

## Status

Proposed

> **第一版スコープ**: spike / crash と **WETH 担保の Aave 清算**に限定する。stablecoin depeg は
> 採点アーティファクトの懸念から phase 2 へ送る（§「決めていないこと」）。本 ADR で解決した 4 つの
> 設計判断（評価軸の分離 / SEED 由来ランダム化 / 清算スキル定義 / depeg 除外）は §Notes に記録する。

## Context

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータ。価格は
平均回帰（OU 型）の fair price（`src/rng.ts` `nextFairPrice`、env `ERIS_PRICE_REVERT_KAPPA` /
`_VOLATILITY` / `_DRIFT`）で生成され、cross-venue delta-neutral 裁定（α）が識別力の決定打になる
よう env を α 支配へ寄せてある（ADR 0007、discrimination-needs-delta-neutral）。realtime
coordinator は環境デーモン兼採点者で、agent はチェーンを直接読み書きする（ADR 0006）。

価格生成の鎖は次の通りで、**fair price は 1 本のスカラ**が唯一のチョークポイントになっている:

```
nextFairPrice(current, rng, anchor)  ← coordinator.ts:615（毎ブロック 1 回）
   └→ PriceFeed.setPrice            ← agent が読む fair（coordinator.ts:646 / priceFeed.ts）
   └→ Aave WETH オラクル setAnswer  ← oracles.ts:76（fairPrice 追従）
   └→ GMX オラクル                  ← updateGmxOracle
```

採点は run 後の歴史再構成（ADR 0006 §4）で行い、Aave のポジションは
**`totalCollateralBase − totalDebtBase`（USD 8 桁、Aave オラクル建値）** を加算する
（`reconstruct.ts:255`）。

### 解決したい課題

現状の市場は **calm 一辺倒**で、清算を伴う tail event が存在しない。このため次の 4 つが測れない／
作れない（本 ADR はこの 4 目的すべてを満たすことを狙う）:

1. **清算ハンティングの報酬化** — crash で HF<1 の被害者を作り、`liquidationCall` で清算益を獲る
   liquidator スキルを評価する。
2. **agent 自身のリスク管理の検証** — レバレッジを取った競技 agent がストレス下で被弾する。生き残る／
   被害を抑えるスキルを評価する。
3. **デモ／可視化** — dashboard で「急騰・急落 → 清算」が起こる様子を見せる。
4. **現実性の付与（regime 拡張）** — calm に加えて tail event を持つ regime を足す。

ただし**根本的な緊張**として、イベントは本質的に**方向性ショック（β）**である。決定論 crash の最適
打ち回しは「事前に WETH を売り底で買い戻す」= 方向タイミング（β）であり、ADR 0007 が消したはずの
β を再注入する。これを α 識別（discrimination の C1/C2/C3）の土俵に混ぜると、**「イベントを当てたか」
が順位を支配し α 支配が壊れる**。この緊張の扱いが本 ADR の中心論点になる。

制約として、次は既存実装の都合で前提になる:

- **fair price は単一チョークポイント**なので、ここを 1 箇所いじれば spike/crash が PriceFeed・
  Aave WETH・GMX へ一貫伝播する。ただし **OU の revert 項は `current` に依存**するため、ショックを
  状態に混ぜると平均回帰が壊れる（窓外の β 中立が崩れ ADR 0007 を毀損する）。
- 既存 `liquidationDemo`（`ERIS_LIQUIDATION_DEMO`、`src/liquidationDemo.ts`）は **同期 sim 専用**で
  `sendAndMine` によるオラクル後上書き方式。realtime の mempool／interval-mining とは噛み合わない。
- memory（gmx-realtime-keeper-no-execute）より **GMX keeper は realtime で約定しない** → perp 清算は
  現状不可。**清算は Aave（現物レンディング）に絞る**。
- memory（anvil-reset-does-not-clear-state）より **soft-reset では Aave ポジションが run 間に残留**。
  victim を毎 run 建てるため、これは清算設計の致命的前提になる。

### 検討した選択肢（価格注入機構）

1. **価格モデルを置換**（イベントを内包した新しい価格生成器に作り替える）
2. **OU パスに決定論オーバーレイを重ねる**（base/effective を分離し、その上に再現可能なイベント
   スケジュールを乗せる）＋ seed 由来 victim 供給
3. **`liquidationDemo` を realtime へ最小移植**（既存の後上書き方式を mempool 対応にするだけ）

### 各選択肢の評価

| 観点 | A: 価格モデル置換 | B: OU + 決定論オーバーレイ | C: liquidationDemo 最小移植 |
|------|-------------------|----------------------------|------------------------------|
| 既存 OU / 窓外 β 中立（ADR 0007）の維持 | 作り直しで再検証が必要 | **base はそのまま・窓外 β≈0 を保つ** | 維持 |
| spike/crash を統一的に扱う | 可能だが大改修 | **オーバーレイ 1 本で表現** | crash のみ |
| 採点系（reconstruct）への波及 | 不透明 | **無改修**（effective が PriceFeed に焼かれる） | 後上書きが採点と不整合になりやすい |
| 再現性（SEED=市場条件） | モデル依存 | **決定論オーバーレイで完全再現** | shock は決定論だが victim が seed 非依存 |
| 後方互換（既定 off） | 困難 | **イベント無し＝従来 run と一致** | off で互換 |

**B を採用。** base/effective 分離により窓外の β 中立を保ったまま spike/crash を 1 本のオーバーレイで
表現でき、effective が PriceFeed に焼かれるため採点・dashboard が無改修で追従する。

## Decision

**OU 価格パス（base）はそのまま進め、その上に SEED 由来でランダム化した決定論イベント・
オーバーレイを重ねて effective price を導出する。spike/crash を WETH 倍率で表現し、WETH 担保の
seed 由来 victim 群を供給して清算を成立させる。評価は α 識別（discrimination）とは独立した
「stress 評価軸」で行い、既存 C1/C2/C3 には混ぜない。depeg は第一版スコープ外。既定 off で
従来 run と一致させる。**

### 1. base/effective 分離 — イベント・オーバーレイ（`src/realtime/events.ts` 新規）

OU の状態は **base 系列**で進め、イベントは分離可能な歪みとして effective を導出する。窓外では
従来通り β≈0 を保ち、窓内だけ鋭い乖離が生まれる。

```ts
// Good: base を汚さない（revert 項は base に対してのみ働く）
baseFair      = nextFairPrice(baseFair, rng, anchor);   // OU 状態。イベントで触らない
const { wethMult } = schedule.at(blockIndex);           // 決定論オーバーレイ（v1 は WETH 倍率のみ）
effectiveFair = baseFair * wethMult;                    // PriceFeed/WETH オラクル/GMX/採点が使う

// Bad: 倍率を状態に混ぜると revert が壊れ β 中立が崩れる
baseFair = nextFairPrice(baseFair * wethMult, rng, anchor); // ✗ ADR 0007 を毀損
```

`coordinator.ts:615` 周辺で `blockIndex = bn - runStartBlock` を計算し、effective を PriceFeed・
oracle・`latestHistory`・採点へ渡す。`EventSchedule` は純粋関数（config+seed → `at(blockIndex)`）で
ユニットテスト対象。**インタフェースは depeg 用の `usdcPx` も返せる形にしておく**（v1 は常に 1）。

### 2. イベント型（台形プロファイル）

各イベントは ramp→hold→decay の**台形**。瞬間ジャンプは**オラクル更新の 1 ブロック遅延**と相性が
悪いため、全員が等しく 1 ブロック遅れで反応できる余地を残す（公平性）。

| 型 | 効き先 | プロファイル | 主に炙り出す対象 |
|----|--------|--------------|------------------|
| `spike` | `wethMult` を 1→(1+m)→1 | 台形（上） | WETH ショート／過剰借入 |
| `crash` | `wethMult` を 1→(1−m)→1 | 台形（下） | **WETH 担保の Aave 清算** |
| ~~`depeg`~~ | ~~`usdcPx`~~ | — | **phase 2（§決めていないこと）** |

### 3. SEED 由来ランダム化スケジュール（過学習の抑制）

config は**固定値ではなくレンジ**を与え、実際のタイミング／magnitude は **SEED から決定論的に派生**
させる。これで「block 40 で crash」のような定数を自己改善 agent が暗記するのを防ぎ（ADR 0004 の
汎化）、能力（ストレス耐性）を測る。SEED→同一パスなので**再現性は維持**される。

```
env 例（stress プロファイル。値ではなくレンジを与える）:
  ERIS_STRESS_EVENTS='[{"type":"crash","magnitudeRange":[0.06,0.10],"windowFrac":[0.3,0.7],
                        "rampBlocks":3,"holdBlocks":6,"decayBlocks":8}]'
  # 実 startBlock と magnitude は Rng(seed) がレンジ内で選ぶ。flow と別 Rng を使い price 本路を消費しない。
```

### 4. 清算を成立させる victim 供給（`liquidationDemo` の realtime 一般化）

HF≈1 のレバレッジ保有者がいないと清算は起きない。`liquidationDemo` を realtime setup 向けに
一般化し、**seed 由来鍵の victim 群**（WETH supply + USDC borrow、HF≈H0）を建てる。victim は
**採点対象外**（liquidator agent の利益源）。

**較正（自由パラメータではない）**: WETH 担保・USDC 債務の victim は
`HF = (W·P·LT)/D`。HF0=H0 で建てると、crash 後の HF は `H0·(1−m)`。よって
**`m > (H0−1)/H0` で清算**される。競技 agent の巻き添えを避けるため、victim の buffer を薄く・
magnitude を中庸にする:

```
victim:   HF0 ≈ 1.05  → 清算に必要な m > (1.05−1)/1.05 ≈ 4.8%
crash:    m ∈ [6%,10%] → victim は確実に清算
agent:    HF 1.30 の健全レバレッジは m=10% でも HF→1.17 で生存（巻き添えにしない）
```

（初版ドラフトの「HF≈1.02 + magnitude 18%」は過大で全員巻き添えになるため撤回。）

- 個数・H0・型を config 化、victim 鍵は `seed` 由来で regime ごとに決定論再現。
- オラクル更新は §1 の effective 経由で mempool に載るため、既存 `applyOracleShock` の同期
  後上書き（`liquidationDemo.ts:93`）は realtime では使わない（採点・PriceFeed と整合）。
- **【ハード要件】full re-fork が必須**: victim を毎 run 建てるため、soft-reset
  （`anvil_reset []`）だと前 run の victim ポジが残留・スタックして HF 計算が壊れる
  （anvil-reset-does-not-clear-state、ADR 0007 訂正の原因）。**stress run は必ず `ARB_RPC_URL` を
  設定して full re-fork で回す**。未設定時は victim setup を fail-fast させる。

### 5. 独立した stress 評価軸（discrimination と分離）

イベントは β を持ち込むため、**α 識別の C1/C2/C3 には混ぜない**。stress regime は別ロスター／別
レポートで、**異なるスキル**を別指標で測る:

| 対象 | 指標（案） | 測るスキル |
|------|------------|------------|
| 競技 agent | 生存率 / 最大ドローダウン / 清算被弾回数 / イベント後 PnL | リスク管理（目的 2） |
| liquidator agent | 清算捕捉数 / 清算益 / 検知遅延（HF<1 から清算までのブロック数） | 清算ハンティング（目的 1） |

`evaluate`/`discrimination` のコア（reconstruct・統計）は無改修で再利用し、**stress 用の指標抽出と
レポートを別途追加**する（専用ツール化の要否は §「決めていないこと」）。SEED は引き続き市場条件
ラベルで、着順だけ非決定 → **N 回反復 + unpaired 統計**で吸収（ADR 0005）。

### 6. 清算のスキル成分の定義（fee 上限は維持）

`liquidationCall` の取得は同一ブロックの priority-fee レースで、`maxPriorityFeeWei` 上限が事後検査
（`postRunCheck`）で効く。competent 同士は上限を積んで**着順=運**になり得る。これを許容しつつ、
**清算で差がつくスキル成分を明示**する:

1. **検知**: HF<1 のポジションを毎ブロック走査して見つけられるか（naive agent は試行すらしない）。
2. **資本準備**: repay 用の USDC を手元に確保しているか（裁定資本と競合する判断）。
3. **正確性**: `liquidationCall` の `debtToCover` / 担保資産を正しく組めるか（revert しない）。

competent 同士の運成分は **N 反復で吸収**する。fee 上限の緩和は識別力ではなく入札ゲームを増やす
ため**第一版では行わない**（必要なら §「決めていないこと」で再検討）。

### 7. 採点・可視化への波及

- 採点: effective price 経由のため reconstruct は無改修。crash 中に清算された victim/agent の損失は
  Aave net に恒久反映される（価格は復帰しても清算は不可逆 = path-dependence）。
- 可視化: イベント窓と victim HF を `events.jsonl` に emit し、dashboard が帯で表示（ADR 0008、
  SSE 契約は不変）。

## Consequences

### Positive

- **4 目的を一体で満たす**（清算報酬・リスク管理検証・可視化・regime 拡張）。
- **ADR 0007 を壊さない**: stress を α 識別と分離し、base/effective 分離で窓外 β≈0 を維持。effective が
  PriceFeed に焼かれるため reconstruct/dashboard/evaluate のコアは無改修。
- **過学習しにくい**: SEED 由来ランダム化で「能力」を測り「定数の暗記」を測らない（ADR 0004）。
- **既定 off で互換**: イベント無し・victim 無しのとき従来 run とバイト一致。

### Negative

- **評価パイプラインが 2 本**（α 識別 + stress 軸）になり、運用と指標設計の重複が増える。
  - → stress 指標は reconstruct を再利用し、抽出層だけ追加して重複を最小化。
- **較正コスト**: `m`・H0・Aave LT の連動を「victim は清算・健全 agent は生存」の窓に合わせる必要。
  - → §4 の式（`m > (H0−1)/H0`）で機械的に設定。victim HF をログで確認。
- **GMX perp 清算は不可**（keeper 未約定）。清算は Aave のみ。
  - → 目的に対し Aave 清算で十分。GMX は keeper 修正後に別途。

### Risks

- **victim の事前清算／未清算**: 金利で HF が割れる、または magnitude 不足で割れない。
  - → setup 直後に建て、event 窓と run 窓のオフセットを config 制御。HF をログ監視。
- **Aave timestamp パニック**（aave-fork-timestamp-overflow）: victim の borrow + interval mining +
  金利累積が `block.timestamp < reserve.lastUpdateTimestamp` のエッジに触れ得る。
  - → 既存の warp 修正を victim setup でも通す。feasibility を最初の spike で確認。
- **stress 軸でも着順非決定で清算者がぶれる**: 同一 regime でも誰が清算を獲るかは変わる。
  - → 仕様（ADR 0005）。N 反復 + unpaired 統計で吸収。
- **anvil 歴史深度**（anvil-historical-state-depth-limit）: stress run を長くすると再構成が深度 ~1,050 超。
  - → `ERIS_RUN_BLOCKS` 固定、event 窓は run 窓に収める。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| stablecoin depeg（USDC オラクル可変） | spot USDC=$1 固定との非対称で採点アーティファクト（C3 汚染・非識別的タダ金）が出る。borrow ガード/numéraire 連動の設計が要る | depeg を識別力に使う phase 2。pool 波及・numéraire 連動とセットで |
| depeg の pool 価格波及（AMM の USDC/WETH を実 swap で動かす） | 第一版は spike/crash のオラクル直撃に限定 | 完全な depeg を作るとき（phase 2） |
| numéraire 連動（spot USDC も depeg 評価） | 採点系（`pnl.ts`）の破壊的変更 | depeg を保有 USDC の損として採点したい場合 |
| GMX perp 清算（funding/liquidation） | keeper が realtime で未約定（gmx-realtime-keeper-no-execute） | keeper 修正後に別 ADR |
| 清算 tx の fee 上限緩和 | 識別力でなく入札ゲームを増やす。第一版はスキル成分（検知/資本/正確性）で差をつける | competent 同士の運が問題化したとき |
| stress 指標の専用ツール化（`npm run stress-eval` 等） | 第一版は reconstruct 再利用 + 抽出層で足りる | stress 評価を反復運用したくなったとき |

## Notes

### 設計判断（2026-06-20、4 fork の結論）

1. **評価軸**: stress を α 識別（discrimination C1/C2/C3）と**分離**し独立軸で評価（β 再注入が α 支配を
   壊すのを回避）。
2. **再現方法**: 固定 JSON ではなく **SEED 由来ランダム化**（レンジ指定）で過学習を抑制（ADR 0004）。
3. **清算**: **スキル成分（検知/資本準備/正確性）を定義**し fee 上限は維持。
4. **depeg**: 採点アーティファクトのため**第一版から除外**（spike/crash + WETH 担保清算のみ）。

### 参考資料

- ADR 0004（self-improvement generalization guarantees）— 過学習抑制（SEED 由来ランダム化の根拠）
- ADR 0005（statistical evaluation after realtime）— regime=SEED は市場条件ラベル・N 回反復 + 統計
- ADR 0006（separate environment from agent execution）— 採点は run 後再構成・flow は環境機構
- ADR 0007（shift env toward alpha dominance）— OU の β 中立前提（オーバーレイで保つ対象）
- ADR 0008（realtime visualization dashboard）— イベント窓/HF の可視化先（SSE 契約不変）
- メモリ: gmx-realtime-keeper-no-execute / anvil-reset-does-not-clear-state（victim 残留）/
  anvil-historical-state-depth-limit / aave-fork-timestamp-overflow
- 実装予定: `src/realtime/events.ts`（新規・EventSchedule）/ `src/realtime/coordinator.ts`（base/effective
  分離）/ `src/liquidationDemo.ts`（realtime victim 一般化・full re-fork 必須化）/ `src/config.ts`
  （`ERIS_STRESS_EVENTS` / victim config）/ stress 指標抽出層 / `test/events.test.ts`
