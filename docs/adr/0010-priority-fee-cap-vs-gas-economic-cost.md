# ADR 0010: priority-fee 上限の維持と gas 経済コスト化の見送り（順序保証の根拠）

## Status

Accepted

> 本 ADR は既にコードに存在する「priority-fee 上限」という運用上の決定を**事後的に文書化**し、
> 代替案（gas を実コスト化して上限を廃する）を評価して見送りの根拠と再検討条件を残すもの。

## Context

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータ。agent は
共有 mempool に tx を出し、anvil は **`--order fees`** でブロック内を priority fee 降順に並べる
（ADR 0006、direct モード）。env（環境デーモン兼採点者）は識別力（賢い戦略を運から分離）を測るため、
価格を α 支配へ寄せている（ADR 0007）。

現状の fee まわりの事実:

- **priority fee = ブロック内の順番を買うレバー**。約定順（裁定・清算・backrun の先頭取り）を決める。
- agent はガス用に潤沢な ETH を渡される（`initialEthWei` 既定 100 ETH、`config.ts:154`）。
- **ガスは既に PnL を減らす**: `valueUsdc = usdc + (eth+weth)·fairPrice`（`pnl.ts:13`）で ETH も価値に
  入るため、ガスで ETH を焼けば netPnl は下がる。ただし endowment が巨大で fee（5 gwei × ~10^6 gas
  ≈ $10）が機会価値に対して**誤差**なので、コストとして実質効いていない。
- **上限 `maxPriorityFeeWei`**（既定 5 gwei、`config.ts:164`）。超過 run は `postRunCheck`
  （`checkRunFeeViolations`）が blocks.csv の実 fee で**事後検出して無効化→再実行**する。
- env は oracle/keeper を **`maxPriorityFeeWei + 1gwei / +0.5gwei`**（`coordinator.ts:575-576`）に置き、
  「oracle 更新 → 約定」の順を**有限のプレミアムで最前列固定**している。

### 解決したい課題

上限は人工物である。現実の市場では gas は実コストで、機会価値を超える入札は割に合わないため
gas 戦争は**経済的に自己制限**する。ならば「ガス endowment を絞って fee を意味のある実コストにし、
足りなければ swap で補充させれば、上限という人工物は不要では」という提案が出た。これは ADR 0009 の
「清算 fee 入札を識別軸にするか」とも関係する。この提案を評価し、採否を決める。

### 検討した選択肢

1. **現状維持** — 上限 + 大きな gas endowment（fee は実質ノーコストの順序レバー、上限で抑制）
2. **gas 経済コスト化** — endowment を縮小し fee を採点資本から払わせ、枯渇時は swap 補充。上限は撤廃
3. **ハイブリッド** — 通常は上限維持、清算など特定 tx のみ経済 fee／入札を許す

### 各選択肢の評価

| 観点 | A: 現状維持（上限） | B: 経済コスト化 | C: ハイブリッド |
|------|---------------------|-----------------|-----------------|
| 環境の順序保証（oracle 最前列） | **有限プレミアムで保証** | 崩れる（oracle front-run 余地） | 通常は保証・例外枠で穴 |
| 測るスキルの純度（α 分離。ADR 0007） | **gas 次元を潰し α に寄る** | gas 管理 + MEV 入札が混入 | 部分的に混入 |
| 現実性（realistic MEV） | 低い（gas が誤差） | **高い** | 中（清算のみ現実的） |
| 影響範囲 | **小（事後検査のみ）** | 大（全 agent/shim が gas 管理） | 中 |
| 再現性／分散（ADR 0005） | **低分散（fee 次元が縮退）** | swap 等で endogenous 状態増 | 中 |
| 実装コスト | 既存 | 大（順序機構の作り直し含む） | 中 |

選択肢 B は現実準拠で美しいが、(1) env の順序保証を別機構で作り直す必要があり、(2) gas トレジャリ
管理 + MEV 入札という **α 分離（ADR 0007）と直交するスキル**を採点へ持ち込み、(3) 全 agent を作り替える。
C は穴（例外枠の front-run・規約の複雑化）を残す。**A が順序保証を有限プレミアムで担保したまま、
測りたいスキル（α／リスク管理）を gas 次元から隔離でき、影響範囲も最小。**

## Decision

**priority-fee 上限（`maxPriorityFeeWei`）を維持し、gas 経済コスト化は見送る。** 上限は単なる
anti-PGA（priority gas auction 化の防止）にとどまらず、**環境の決定論的順序保証**（oracle/keeper を
有限プレミアムで最前列に固定）を担っており、経済化はその役割を別機構で作り直す必要があるうえ、
α 分離（ADR 0007）と直交する gas 管理・MEV 入札スキルを採点に混入させるため。

### 1. 維持する具体（現状の追認）

- agent の priority fee は `maxPriorityFeeWei` 以下に制約。超過 run は `postRunCheck` が事後無効化。
- env tx は `maxPriorityFeeWei + premium` で最前列固定（`coordinator.ts:575-576`）。
- gas は名目上 PnL を減らすが（`valueUsdc` 経由）、endowment 巨大で誤差に保つ（順序レバーとしての
  fee と、コストとしての gas を実質分離する）。

### 2. 経済化を見送る根拠

1. **順序保証の喪失**: 上限という有限の天井が消えると、env がどんな fee を積んでも資本厚い agent に
   **oracle 更新を front-run され得る**（価格が出る前に新価格で取引）。「均衡では低い」は「oracle より
   確実に下」を保証しない。防ぐには oracle を専用ブロックで先に mine する等、ADR 0006 の同一ブロック
   mempool 設計の作り直しが要る。
2. **スキル純度の毀損**: 経済 fee + swap 補充は agent に gas トレジャリ管理（tx 数見積り・ETH 残維持・
   枯渇時の WETH/USDC→ETH swap = 追加 tx + slippage + pool 変動）を課す。トレード判断が正しくても
   「ガス補充をしくじって停止」で負けるノイズが入り、大機会では realistic MEV 入札合戦で順位が
   「資本量 × 入札モデル」に相関する。ADR 0007 の「運や β でなく α で順位をつける」と擦れる。
3. **影響範囲**: 既存戦略・互換シム（`directShim`）・examples・self-improve ループは「ガスを気にせず
   取引する」前提。endowment 縮小は naive 戦略をガス切れで黙って止める。上限は非侵襲。

### 3. 再検討の条件（いつ経済化を考えるか）

- **realistic MEV／清算入札そのものを識別軸にしたくなったとき**（gas 管理・入札が「測りたいスキル」に
  昇格する場合）。
- **env の順序保証を上限非依存の別機構へ移せたとき**（例: oracle/keeper を専用先行ブロックで mine する、
  特権レーンを設ける）。
- そのときは本 ADR を Superseded にし、endowment サイズ・swap 補充の slippage 影響・順序機構を設計する。

## Consequences

### Positive

- env の「oracle 更新 → 約定」順序が有限プレミアムで保証され続ける（front-run 不可）。
- 測りたいスキル（α 裁定・リスク管理）が gas 次元から隔離され、ADR 0007 の α 支配と整合。
- 影響範囲ゼロ（既存挙動の追認）。評価の低分散（fee 次元が縮退）も維持。

### Negative

- gas が現実のような実コストにならず、**realistic MEV／gas 入札スキルは測れない**。
  - → それを測りたくなったら §3 の条件で経済化を再検討（本 ADR を Superseded）。
- competent な liquidator 同士は上限に張り付き、清算の取得順が**着順=運**になり得る（ADR 0009 §6）。
  - → 清算のスキルは検知／資本準備／正確性で差をつけ、残る運は N 反復で吸収（ADR 0009）。

### Risks

- 上限が「ガスはタダ同然」という非現実な前提を固定し、現実移行時の戦略乖離を生む。
  - → 本番コンペ（competition-submission-format）は汎用スクリプト提出。gas 前提は env プロファイルとして
    明示し、必要なら経済化プロファイルを別途用意して評価する。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| 清算 tx のみ経済 fee 化するハイブリッド（ADR 0009 選択肢2） | 0009 は当面「fee 上限維持」。入札ゲーム化より検知/資本/正確性で差をつける | competent 同士の運が問題化したとき |
| gas endowment サイズの調整 | 経済化を見送るため現状維持で足りる | 経済化を採用する場合（§3） |
| swap 補充の slippage／pool 影響のモデル化 | 同上 | 経済化を採用する場合（§3） |
| env 順序保証の上限非依存化（専用先行ブロック等） | 現状は有限プレミアムで足りる | 経済化の前提として必要になったとき |

## Notes

### 参考資料

- ADR 0005（statistical evaluation after realtime）— 着順非決定を N 反復 + 統計で吸収
- ADR 0006（separate environment from agent execution）— direct モード・同一ブロック mempool 順序・
  oracle/keeper の最前列固定
- ADR 0007（shift env toward alpha dominance）— α 分離（gas 次元を採点から隔離する動機）
- ADR 0009（market stress events and liquidations）— 清算スキルの定義・fee 上限維持（本 ADR が根拠）
- メモリ: competition-submission-format
- 実装: `src/config.ts`（`maxPriorityFeeWei` / `initialEthWei`）/ `src/postRunCheck.ts`
  （`checkRunFeeViolations`）/ `src/realtime/coordinator.ts:575-576`（env premium ordering）/ `src/pnl.ts`
