# ADR 0011: gas 経済コスト化 — priority-fee 上限の撤廃と MEV の識別軸化（ADR 0010 を Supersede）

## Status

Proposed

> 承認時に Accepted へ昇格し、**同時に ADR 0010 を Superseded** にする（0010 冒頭へ
> 「Superseded by ADR 0011」を付す）。本 ADR は ADR 0010 が見送った**選択肢 B（gas 経済
> コスト化）**へ転換する判断を、0010 が反対した2つの核心理由を別機構で解いたうえで記録する。

## Context

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータ。agent は
共有 mempool に tx を出し、anvil は **`--order fees`**（priority fee 降順）でブロック内を並べる
（ADR 0006、direct モード）。env（環境デーモン兼採点者）は fair price を生成して `PriceFeed`
コントラクトへ毎ブロック tx で書き込み、価格を α 支配へ寄せている（ADR 0007）。

ADR 0010 は現状（**priority-fee 上限 `maxPriorityFeeWei`＝5 gwei を維持、gas endowment を 100 ETH と
大きく取り fee を実質ノーコストの順序レバーに保つ**）を事後文書化し、選択肢 B（経済コスト化）を
見送った。その核心理由は2つ:

1. **env の決定論的順序保証** — oracle/keeper を `maxPriorityFeeWei + premium`
   （`coordinator.ts:637-638`、`oracleFee = cap + 1gwei` / `keeperFee = cap + 0.5gwei`）に置き、
   「価格確定 → 約定」の順を有限プレミアムで最前列固定している。上限を外すと資本厚い agent が
   oracle 更新を outbid して front-run し得る。
2. **α 分離（ADR 0007）** — gas 入札・トレジャリ管理は α と直交し、勝者を「資本量」に相関させる
   系統的バイアスを採点へ持ち込む。

### 解決したい課題（なぜ今 0010 を見直すか）

- **上限は順序を実力ベースにしない（0010 の過小評価）**: priority-fee ordering で上限を設けると、
  競合機会を取りに行く合理戦は**全員が上限ちょうどを積む**。fee 同値 → anvil は同値 tx を到着順
  （FIFO）で並べる → 勝者は**着順＝レイテンシ＝運**。これは清算に限らず**アビトラ・backrun を含む
  全 contested 機会**で起きる（0010 は §6/Negative で清算のみ自認しており一般化が漏れている）。
  上限は「公平な順序」ではなく「**資本で順序を買えなくする＋env を最前列に固定する**」道具にすぎない。
- **「ガス＝タダ」前提の非現実性**: 本番（実チェーン／competition submission）ではガスは実コスト。
  sim でガスを無視するよう最適化した戦略は本番で乖離する（0010 Risk 節で自認しつつ未対処）。
- **realistic MEV／execution スキルを測れない**: 機会を正しく評価して入札する・gas トレジャリを
  管理するという execution スキルは現実 DeFi の本質だが、上限がこの次元を潰している。

### 検討した選択肢

1. **現状維持（ADR 0010）** — 上限 + 大 endowment。fee は実質ノーコストの順序レバー。
2. **経済コスト化（本 ADR）** — 上限撤廃 + 経済 fee 入札をスキル軸化。env 順序保証を **state-write** へ移し
   上限非依存にする。endowment 縮小で gas を実コスト化。
3. **ハイブリッド** — 清算 tx のみ経済 fee（ADR 0009 選択肢2）。

### 各選択肢の評価

| 観点 | A: 現状維持（上限） | B: 経済コスト化（本 ADR） | C: ハイブリッド |
|------|---------------------|---------------------------|-----------------|
| env の順序保証 | 有限プレミアムで保証（上限依存） | **state-write で機械的に保証（上限非依存）** | 通常は上限・例外枠で穴 |
| contested 機会の勝者 | 着順＝運（全機会） | **機会を高く評価した者＝実力** | 清算のみ実力・他は運 |
| 測るスキル | α/リスク管理のみ | **α + execution/MEV** | 部分的に execution |
| 現実性（realistic MEV） | 低い（gas が誤差） | **高い** | 中 |
| α 分離（ADR 0007）純度 | 高い | 下がる（→§3 で抑制） | 部分的に下がる |
| 再現性／分散（ADR 0005） | 低分散 | endogenous 増（→N 反復で吸収） | 中 |
| 影響範囲／実装コスト | 既存 | 大（順序機構＋全 agent gas 管理） | 中 |

選択肢 A は「資本で勝てなくする」点で α 分離に資するが、**順序を実力ベースにはしない（運に委ねる）**うえ
realistic MEV を一切測れない。C は例外枠の front-run と規約複雑化の穴が残る。**B は、0010 が反対した
2つの核心理由を別機構で解けるなら、現実性と識別次元の追加を同時に取れる。** 本 ADR はその別機構を
Decision §1・§3 に与える。

## Decision

**priority-fee 上限を撤廃して gas を実コスト化し、機会評価に基づく priority-fee 入札（realistic MEV）を
識別軸へ昇格する。env の順序保証は「上限＋premium」ではなく「ブロック境界での価格 state-write」へ
移して上限非依存にする。ADR 0010 を Supersede する。**

### 1. env 順序保証を上限非依存へ — price を tx でなく state-write で確定

現状は `updatePriceFeedMempool`（`src/realtime/priceFeed.ts`）が `setPrice` tx を mempool へ出し、
`oracleFee = cap + 1gwei` で `txIndex 0` を取っている（`coordinator.ts:634-637`）。上限が消えると、
資本厚い agent がこの tx を outbid して oracle を front-run できる。

**変更**: fair price を**ブロック境界で `PriceFeed` の storage へ直接書く**。価格は block N が
開く前に storage に在るため、block N に env の price tx は無く、agent が front-run する対象が消える。

```
現状（上限依存）:  [block N]  txIdx0=oracle(cap+1gwei)  txIdx1..=agents(<=cap)
                              └ 上限が無いと agent が oracle を outbid 可能

変更（上限非依存）: <block 境界で env が PriceFeed storage を直接 set（tx 無し）>
                   [block N]  txIdx0..=agents（fee 自由入札）
                              └ 価格は既に storage 確定済み → front-run 対象が存在しない
```

- **実装は anvil cheatcode `anvil_setStorageAt` で `PriceFeed` の `answer` slot を直書き**する方式を採る。
  価格配布は env（シミュレータ）機構であり agent 動作ではないため、cheatcode 利用は agent の現実性を
  毀損しない。agent からの読み口（`readFairPrice` = `PriceFeed.latestAnswer`）は不変なので
  **agent 体験・submission 互換は変わらない**（1 ブロック遅延の仕様も維持）。
  - 代替案（fallback）として automine 制御で oracle を env-only 専用ブロックに先 mine する方式があるが、
    共有 mempool で agent tx の混入を防ぐゲーティングが要り実装が重いため採らない（cheatcode 直書きが
    front-run 対象を機構的に消すうえ最も単純）。slot 番号は自社管理の小コントラクトで安定。
- keeper（GMX 注文執行）も同様にブロック境界の制御実行へ寄せる。keeper は agent の注文配置の**後**に
  走ればよく（1-block 遅延は不変）、最前列固定は不要。
- flow bot relay は env 側の市場機構（採点対象外）なので従来通り mempool tx のまま。

これは ADR 0010 §3 が挙げた再検討条件「**env の順序保証を上限非依存の別機構へ移せたとき**」を満たす。

### 2. 上限撤廃と gas の実コスト化

- **上限執行を撤廃**。`postRunCheck.checkRunFeeViolations`（fee > cap で run 無効化）を退役させる。
  `--order fees` はそのまま：agent は自分の機会評価に応じて priority fee を積み、**高く評価した者が
  先に約定**する（realistic priority gas auction）。
- **`initialEthWei` を大幅縮小**（既定 100 ETH → 較正後の控えめな値）。gas は `valueUsdc = usdc +
  (eth+weth)·fairPrice`（`src/pnl.ts`）経由で既に PnL を減らすため、endowment を絞れば fee が機会価値に
  対して意味を持つ。
- **ETH 枯渇時は WETH/USDC → ETH swap で補充**（追加 tx + slippage = 現実の treasury 管理コスト）。

### 3. 「資本量でそのまま勝つ」系統的バイアスの抑制

無制限入札は「資本散布で勝つ」を招きうる（ADR 0010 が最も恐れた点）。これを設計で抑える:

- **入札は機会価値で経済的に上限が付く** — 合理 agent は期待利益を超えて積まない。よって入札額自体が
  「機会を正しく評価した」**α 相関シグナル**であり、生の資本量ではない。
- **全 agent 等資本スタート**（初期 endowment 対称）→ 資本優位は earned（endogenous）= **スキルの複利**
  であり正当。
- 残る雪だるまバイアスは **N 反復（ADR 0005）＋ 資本正規化採点（return on capital 等）**で抑える
  （後者は未決。「決めていないこと」参照）。
- **α は依然 price process（ADR 0007 平均回帰）が駆動**。MEV 入札はその上に乗る**二次の識別軸**で、
  識別力を削るのではなく次元を足す。

### 4. 移行の fail-safe

- 既存戦略・互換シム（`examples/agents/lib/directShim.ts`）は「ガスを気にせず取引」前提。endowment
  縮小は naive 戦略を黙ってガス切れさせる → **directShim に既定の gas マネージャ**（ETH 残量監視＋
  自動 swap 補充）を入れ、無改修戦略も停止しないようにする。
- **ロールバック／プロファイル化**: `ERIS_ECONOMIC_GAS`（仮）を run 単位スイッチにし、`0` で ADR 0010 の
  上限プロファイルを再現できるよう残す。経済化は env プロファイルとして opt-in。

## Consequences

### Positive

- realistic MEV／execution（機会評価→入札、treasury 管理）が測れ、本番（実チェーン）との戦略乖離が縮む。
- env 順序保証が上限から独立し、front-run 不可性が「価格が block 開始前に storage に在る」という
  **機械的事実**で担保される（fee 天井に依存しない）。
- 着順＝運だった contested 機会（アビトラ/清算）が「機会を高く評価した者が勝つ」＝実力で決まり、
  識別軸が増える。

### Negative

- ADR 0007 の「純 α 分離」が fee 次元で崩れる（MEV/treasury スキルが採点に混入）。
  - → 等資本スタート + 機会価値による入札上限 + 資本正規化採点で「資本量そのもの」を抑え、混入を
    「機会評価スキル」へ寄せる。α は price process が依然支配。
- endogenous 状態（gas 残・swap）が増え、再現性／低分散（ADR 0005）が落ちる。
  - → run 長固定（`ERIS_RUN_BLOCKS`）+ N 反復 + unpaired 統計で吸収。swap slippage はプール深度で抑える。
- 影響範囲が大きい（全 agent/シム/examples/self-improve が gas 管理前提に変わる）。
  - → directShim の既定 gas マネージャで無改修戦略を fail-safe 化。経済化は env プロファイルで opt-in、
    既定を当面 0010 維持にもできる。

### Risks

- 較正ミス（endowment 過小）で大量 agent が一斉にガス切れ → run が空転する。
  - → setup で「最低 N tx 分の gas 余力」を検証し fail-fast。swap 経路の健全性も事前確認。
- 資本雪だるまで早期に運良く勝った agent が入札で独走し α を覆い隠す。
  - → 資本正規化採点 + N 反復。深刻なら入札に soft cap（機会価値 ×k）を検討（「決めていないこと」）。
- state-write 価格が「実チェーンに無い特権操作」で本番 submission と乖離する懸念。
  - → 価格配布は env 機構で、agent からは `PriceFeed` read で不変。agent 体験は変わらず submission 互換は保たれる。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| `initialEthWei` の具体値／swap 補充の slippage モデル | 較正実測が要る | 経済化プロファイル設計時 |
| 資本正規化採点（return on capital 等）の採用 | まず素の PnL で雪だるま影響を実測する | 雪だるまが識別力を壊すと確認されたとき |
| 入札 soft cap（機会価値 ×k） | 過剰設計回避、まず無制限で観測 | 資本独走が問題化したとき |
| keeper 執行を state-write 化するか mempool tx のままか | 実装の単純さ優先で後決め | 実装時 |
| 清算のみ経済 fee のハイブリッド（ADR 0009 選択肢2） | 全機会経済化で不要化 | （経済化を撤回する場合のみ再検討） |

## Notes

### Supersede 関係

- 本 ADR が Accepted になった時点で **ADR 0010 を Superseded** にし、0010 冒頭へ「Superseded by ADR 0011」
  を付す。ただし **0010 の上限プロファイルは削除せず**、`ERIS_ECONOMIC_GAS=0` として再現可能に残す
  （経済化が識別力を毀損した場合のロールバック先）。
- ADR 0009（清算）は「fee 上限維持」を前提に清算スキルを検知/資本/正確性で定義していた。本 ADR 採用後は
  清算の取得順も入札で実力決定になるため、0009 §6 の「着順＝運」緩和は不要化する（0009 は要追記）。

### 参考資料

- ADR 0005（statistical evaluation after realtime）— endogenous 増を N 反復 + 統計で吸収
- ADR 0006（separate environment from agent execution）— direct モード・同一ブロック mempool 順序
- ADR 0007（shift env toward alpha dominance）— α 分離。本 ADR は fee 次元で部分的に逆行し execution を足す
- ADR 0009（market stress events and liquidations）— 清算スキル。本 ADR で取得順が実力決定化
- ADR 0010（priority-fee 上限の維持）— 本 ADR が Supersede
- 実装: `src/config.ts`（`initialEthWei` / `maxPriorityFeeWei`）/ `src/realtime/priceFeed.ts`
  （`updatePriceFeedMempool` → state-write 化）/ `src/realtime/coordinator.ts:634-637`（env premium ordering）/
  `src/postRunCheck.ts`（`checkRunFeeViolations` 退役）/ `src/pnl.ts`（gas が valueUsdc を減らす）
- メモリ: competition-submission-format / discrimination-needs-delta-neutral-not-flow
