# ADR 0013: マルチアセット取引ペア対応（registry + market 駆動化）

## Status

Accepted

> 取引対象を **WETH/USDC 単一ペア**から複数ペアへ拡張する。第一歩として **WBTC/USDC を全5 venue
> に追加**し、同時に「将来は**定数追加＋プール deploy だけ**で任意トークンを増やせる **token registry +
> market config 駆動**」へコア構造を作り変える。既存 WETH run は **byte 互換**で不変に保つ。

## Context

eris-competition-poc は Anvil 上に DeFi プロトコル一式を動かす競争シミュレータで、ローカルデプロイ
（非 fork）で全5 venue（Uniswap/Balancer/Curve/GMX/Aave）が動く段階に到達している
（[[localdeploy-eris-app-deployer-path]]）。識別力は「平均回帰価格（β 除去）＋ cross-venue 裁定」で
出る設計（ADR 0001 / 0007 / [[discrimination-needs-delta-neutral-not-flow]]）で、評価は USDC-only 配布で
初期 β を消す方針（[[usdc-only-funding-for-alpha-clean-eval]]）。

現状、取引対象は **WETH/USDC の単一ペアに強く結合**している。`TokenSymbol = "WETH" | "USDC"` が
`src/types.ts` と `src/constants.ts` に二重定義され、その前提が貫通している:

- **型・action**: `tokenIn: TokenSymbol`、`MintLiquidityAction.amountWethDesired/amountUsdcDesired` のように
  WETH/USDC を名前で埋め込む。
- **価格**: `src/rng.ts` `nextFairPrice()` は**単一スカラー**の OU（WETH/USD 1 本）。`contracts/PriceFeed.sol`
  も `int256 _answer` 単一価格。stress（`src/realtime/events.ts`）は `wethMult` のみ。
- **採点**: `src/pnl.ts` `valueUsdc()` は ETH/WETH/USDC のみ。`src/realtime/reconstruct.ts` は WETH 残高と
  単一 fairPrice で価値再構成（ADR 0006）。
- **venue**: 各 adapter が WETH/USDC leg をハードコード（uniswap `sortedTokens`、gmx `ETH_USD` market 固定 等）。

### 解決したい課題

- **市場が単一資産しか無く、戦略の評価軸が狭い。** 単一資産の方向/裁定に過適合しやすく、複数資産間での
  一般化（同じ裁定スキルが BTC 市場でも効くか）を測れない。ADR 0012 で base 戦略の**種類**は増やしたが、
  戦略が働く**市場**は WETH/USDC のままだった。
- **トークン追加が構造改造を要する。** 現状 1 トークン足すだけで型・価格・採点・全 adapter に波及し、
  「定数追加で増える」状態になっていない。将来の多資産化（ETH/BTC に留まらず）に耐えない。
- **既存資産を壊せない。** evaluate/gate/discrimination のベースライン、既存戦略ロスター
  （`examples/agents/*`・`agents.*.json`）、決定論再現性（ADR 0005、SEED=regime のラベル）を毀損すると、
  これまでの評価結果が無効化する。

### 検討した選択肢

1. **現状維持** — WETH/USDC 単一のまま。
2. **union 拡張＋分岐**（最小ハードコード）— `TokenSymbol = "WETH" | "USDC" | "WBTC"` にして各所を
   if 分岐で WBTC 対応。
3. **token registry + market config 駆動**（本 ADR の提案）— トークンをレジストリ化し、venue ごとの取引
   ペアを `MarketConfig` に外出し。adapter は market を回す。トークン追加は定数＋プール deploy で済む。
4. **完全汎用化** — base/quote も任意ペア（BTC/ETH 直接ペア等）まで一般化し、N-token グラフを扱う。

### 各選択肢の評価

| 観点 | 1: 現状維持 | 2: union＋分岐 | 3: registry+market | 4: 完全汎用 |
|------|------------|---------------|--------------------|------------|
| 市場の多様性 | なし | 中（WBTC 限定） | 中→大（定数で増える） | 大 |
| トークン追加コスト | — | 高（毎回分岐追加） | **低（定数＋deploy）** | 低 |
| 後方互換（WETH byte 一致） | ◎ | △（分岐で崩れやすい） | **◎（既定 off 設計）** | △ |
| 実装コスト | 0 | 中 | **中〜大** | 特大 |
| 識別力（α 支配）への影響 | 中立 | 中立〜リスク | **中立（OU 維持で管理）** | 高リスク（相関 β） |
| 保守性（将来の多資産） | — | 低（分岐が増殖） | **高** | 中（過剰設計） |

選択肢 1 は要求を満たさない。選択肢 2 は WBTC は足せるが「分岐の増殖」で 3 トークン目以降が二次曲線的に
重くなり、将来の多資産化に耐えない（ユーザー要求「将来は任意トークンを追加できるように」に反する）。
選択肢 4 は base/quote 任意ペアまで広げると資産間相関由来の隠れ β を持ち込み α 支配（ADR 0007）を壊す
リスクが高く、現時点で必要な表現力を超える。**選択肢 3 が「いま WBTC を足す」と「将来 定数で増やす」を
両立し、後方互換も設計で担保できる**ため採用する。

## Decision

**トークンを `TOKENS` レジストリ（`kind: base|stable`）、venue ごとの取引ペアを `MarketConfig` に外出しし、
adapter・価格・採点を market 駆動へ一般化する。`PriceFeed` は mapping 拡張で複数アセット価格を 1 contract に
持たせ、価格は per-asset 独立 OU で進める。WBTC/USDC を全5 venue に追加するが、WBTC は RNG を後置消費し
既定 off にすることで、既存 WETH run を byte 互換に保つ。対象は local-deploy 経路一本とする。**

### 1. token registry + market config 駆動

`TokenSymbol` のリテラル union を剥がし（`= string`＋`TokenKind = "base" | "stable"`）、`TOKENS` を
レジストリ化する。venue 固有の leg は新規 `src/markets.ts` の `MarketConfig` へ移す。

```
                         src/markets.ts（新規・純粋層）
TOKENS(constants) ──→ tokenRegistry: Record<sym, {address, decimals, kind}>
                          ├─ baseTokens()    = kind:"base"  （WETH, WBTC, …）
                          └─ stableTokens()  = kind:"stable"（USDC 相当）
各 venue 定数  ──────→ MarketConfig { key:"WBTC/USDC", protocol, base, quote, <venue leg> }
                          ├─ marketsFor(protocol)      … adapter が回す対象
                          ├─ marketFor(protocol, base) … action から解決
                          └─ defaultBaseFor(protocol)="WETH" … 後方互換の既定
```

adapter（`src/protocols/*.ts`）は「有効 market 配列を回す」形になり、WETH/USDC ハードコードが消える。
重複（`sortedTokens`/`assetFor`/swap 方向解決）は新規 `src/protocols/marketHelpers.ts`
（`sortedPair`/`swapLeg`/`resolveMarket`）へ集約する。**新トークンは `TOKENS` への 1 エントリ追加と
deployer でのプール seed で増える**（型・分岐の改造不要）。

### 2. PriceFeed mapping 拡張 + per-asset 独立 OU

`PriceFeed.sol`（ADR 0006 §3 のオンチェーン配布）を mapping に拡張する。**複数インスタンスより 1 contract +
mapping を選ぶ**: agent への配布アドレスが 1 本で済み、`latestAnswer()` を WETH 既定で残せば旧 agent が
無改修、採点再構成（`reconstruct.ts`）も 1 contract の multicall で全 asset を読める。

```solidity
mapping(address => int256) private _answers;     // token => USD 8桁
function setPrice(address token, int256 answer) external;  // owner only
function answerOf(address token) external view returns (int256);
function latestAnswer() external view returns (int256);    // 後方互換: WETH を返す
```

価格は asset ごとに**独立な OU**で進める。`nextFairPrice` に optional `OuParams` を足して既存挙動を保存し、
`nextFairPrices(current, rng, anchors, paramsBy)` を新設。vol/kappa は env で per-asset 指定可
（`ERIS_PRICE_VOLATILITY_WBTC` 等、無指定はグローバル fallback）。

### 3. 採点の base 一般化

`valueUsdc`/`balanceToInventory`（`src/pnl.ts`）の price 引数を `number → Record<sym, number>` にし、
**全 base 残高 × 各 USD 価格 ＋ 全 stable 合算**で評価する（単一 number 互換ラッパを残し段階移行）。
`reconstruct.ts` は per-base 残高を multicall に追加し、全 uniswap/gmx market のポジションを合算する。
`inventory.valueUsdc` ベースの集計なので `perRoundValues` 以降の評価パイプライン（ADR 0005）は無改修で
正しい総価値を受け取る。

### 4. 後方互換の核（WETH byte 互換 ＋ WBTC 既定 off）

決定論再現性（ADR 0005）を守るため、RNG 消費順序を不変に保つ。

```
RNG 消費順（価格・flow・stress すべて）:
  [ WETH を必ず先頭で消費 ] → [ WBTC を後置 ]
  WBTC 既定 off（flow max=0 / 初期配布 0）⇒ WBTC ループで RNG を消費しない
  ∴ WBTC market を「足しても」既存 WETH-only run は byte 一致
```

- observation/action の**既存フィールドは意味維持で残す**（`fairPriceUsdcPerWeth`・`amountWethDesired`・
  `pool.pair:"WETH/USDC"` 等）。マルチアセット用は `fairPricesUsd`/`markets`/`baseBalances`/`base?` を
  **追加**する。既存戦略は WETH market にだけ反応する限り無改修で動く。
- **WBTC 初期配布は 0**（USDC-only 配布の α-clean 方針 [[usdc-only-funding-for-alpha-clean-eval]] と整合）。
  agent は市場で USDC→WBTC を買う。これにより初期 inventory 構成が全 agent で揃い、採点の資本正規化を保つ。

### 5. 識別力との整合（ADR 0001 / 0007）

- **各 base で平均回帰（OU）を維持**する。WBTC も anchor へ引き戻すことで方向 β windfall を 0 に寄せ、
  「pool と fair の乖離を当てる α」だけが残る構図を全資産で保つ。
- **資産間相関は v1 = 0**（個別ショックのみ）。BTC と ETH を相関させると相関由来の隠れ β が入り α 支配を
  壊すため最初は入れない。ショック生成を「共通因子 ＋ 個別」に分解できる形だけ用意し、相関は将来フックとする。

### 6. スコープは local-deploy 一本

検証経路は local-deploy（`feat/local-deploy-mode` ＋ `eris-app-deployer feat/shared-tokens-gmx-aave`）に
固定する。deployer 側で WBTC anchor **$60,000 統一**・各 venue 片側 ~$3M（50 WBTC / 3M USDC）で seed し、
golden AMI を焼き直す（[[spot-ec2-runner]]）。fork 経路は対象外。

## Consequences

### Positive

- 市場が多資産化し、「同じ裁定スキルが BTC 市場でも効くか」という一般化を識別力評価に持ち込める。
- registry/market 抽象により、**以後のトークン追加が定数＋プール deploy で済む**（型・分岐改造が不要）。
- PriceFeed mapping・per-asset OU・採点 base 一般化で、価格〜採点が「N アセット」を素直に扱える基盤になる。
- 後方互換の核（WETH byte 一致・WBTC 既定 off）により、既存ベースライン・ロスター・既存テストを汚さず段階導入できる。

### Negative

- 触る範囲が広い（型・constants・rng・PriceFeed・5 adapter・flow・採点・stress・deployer）。
  - → 依存順フェーズに分割し、各フェーズで typecheck/test の WETH 経路不変を確認してから次へ進む。
- registry/market 抽象の導入で間接層が増え、単純な WETH/USDC 直読みより可読性が一段下がる。
  - → `defaultBaseFor("uniswap")="WETH"` 等の互換 getter と marketHelpers への集約で、呼び出し側の見た目を保つ。
- 採点再構成が per-base 残高ぶん multicall 読取を増やす。
  - → anvil の歴史保持深度 ~1,050 ブロック（[[anvil-historical-state-depth-limit]]）を圧迫しうるため、
    multicall サイズを監視し必要なら chunk 化する。

### Risks

- **RNG 消費順序の破壊**: WBTC を先頭で消費すると価格/flow/stress の決定論が崩れ、全ベースラインと
  `test/flow.test.ts` 等が変動する。
  - → WETH 先頭消費＋WBTC 既定 off（RNG 非消費）を全フェーズで厳守し、WETH byte 互換 assert をテストに追加。
- **8 decimals の取り違え**: WBTC は 8 桁（WETH 18 / USDC 6 と異なる）。Curve `initial_price`・GMX
  `toGmxPrice` の decimals・raw/human 量の混同で価格が桁ずれする。
  - → venue 別の桁注意点を実装チェックリスト化し、各 venue の WBTC spot≈$60k を deploy 後に検証する。
- **採点の二重計上/欠落**: base 残高（wallet）と LP/GMX/Aave の base ポジ（adapter）の境界を取り違えると
  価値が重複または欠落する。stable 合算に base を混ぜるのも誤り。
  - → kind（base/stable）判定を厳格化し、WETH-only reconstruct の総価値が旧値一致することを回帰で確認。
- **GMX マーケット未生成**: WBTC market は自動生成されず、未追加だと seed が無音 skip する。
  - → deployer の `markets.ts` localhost 配列に WBTC を明示追加し、seed 側を「市場が無ければ throw」に変更。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| 資産間相関の導入（共通因子の重み） | 相関由来の隠れ β が α 支配に与える影響が未検証 | stress/gas 軸が安定した後に A/B |
| WBTC を評価 env プロファイルへ昇格（既定 on 化） | まず WETH byte 互換を保ったまま機構を入れるのが先 | 機構の green 確認後、較正実測で |
| base 別の limits / flow 強度の較正 | WBTC 市場の深さ・約定実績を見てから決める | 統合実走（Phase 10）の実測後 |
| base/quote 任意ペア（BTC/ETH 直接ペア等） | 現要求は base/USDC で足り、過剰設計を避ける | 多資産が定着し需要が出たら |
| ETH/USD の venue 間 anchor 不一致（AMM $3000 vs Aave $4000 の既存矛盾） | 本 ADR のスコープ外（既存課題） | 別途。WBTC は $60k 統一で回避 |

## Notes

### 参考資料

- ADR 0001（multi-agent competition platform）/ ADR 0007（shift env toward alpha dominance）—
  各 base で平均回帰を維持し相関 β を入れない根拠（α 支配の保全）
- ADR 0005（statistical evaluation after realtime）— WETH byte 互換で守る決定論再現性と unpaired 統計
- ADR 0006（separate environment from agent execution）— PriceFeed オンチェーン配布と採点 run 後再構成。
  mapping 拡張・per-base multicall はこの機構の上に乗る
- ADR 0009（market stress events）/ ADR 0011（economic gas）— stress `baseMults` 化と、base 拡張下でも
  入札=実力の枠組みを保つ前提
- ADR 0012（diversify self-improvement base strategies）— 戦略の「種類」を増やした前段。本 ADR は戦略が
  働く「市場」を増やす
- 実装: 新規 `src/markets.ts`・`src/protocols/marketHelpers.ts` / `src/types.ts`・`src/constants.ts` /
  `src/rng.ts` / `contracts/PriceFeed.sol`（+ `src/realtime/priceFeed.ts`）/ `src/pnl.ts`・
  `src/realtime/reconstruct.ts`・`src/protocols/oracles.ts` / 5 adapter / `src/flow/logic.ts` /
  `scripts/genLocalConstants.ts`。deployer: `src/protocols/{uniswap-v3,balancer-v2,curve,gmx-v2,aave-v3}.ts`・
  `vendor/gmx-src/config/markets.ts`・`deployments/deployments.json`
- メモリ: [[localdeploy-eris-app-deployer-path]] / [[usdc-only-funding-for-alpha-clean-eval]] /
  [[discrimination-needs-delta-neutral-not-flow]] / [[env-alpha-dominance-achieved]] /
  [[anvil-historical-state-depth-limit]] / [[spot-ec2-runner]]
