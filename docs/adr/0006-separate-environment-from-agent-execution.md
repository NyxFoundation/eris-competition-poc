# ADR 0006: 環境（市場機構）とエージェント実行の分離 — agent の直接チェーンアクセス

## Status

Accepted

## Context

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータである。現行アーキテクチャ（CLAUDE.md / ADR 0001）では coordinator が RPC・fair price・state 読取・tx 提出・flow ウォレットを独占し、agent / flow-bot は stdin/stdout の行 JSON で observation を受け action を返す「RPC に触れないプロセス」として動く。`feat/realtime-blocktime` で競争環境は実時間 2 秒ブロック・非同期フリーランへ移行し（ADR 0003/0005）、ブロック内の tx 順序は **anvil の `--order fees` がネイティブに priority fee 降順で決定する**（実測: 複数 tx ブロック 160 中 145 が完全 fee 降順、例外 15 は全て同一送信者の nonce 制約。oracle は fee 上限+1 で 103/103 ブロック先頭）。

### 解決したい課題

1. **coordinator の観測ループが agent 数に比例し、実時間に追従できない**。フルロスター（44 agent）の実測（2026-06-10, `runs/2026-06-10T19-07-58-755Z`）では、毎ブロックの「5 protocol readState + 44 × (残高 + 全ポジション読取) + 観測 push」が逐次 await で、キャッシュ warm 後でも **~11 秒/ラウンド**（予算 2 秒）。さらに処理遅延中に溜まったブロックの後処理（receipt + keeper × ブロック数）が次ラウンドに乗る**正帰還**があり、終盤は 90.6 秒/ラウンドまで劣化した（チェーン自体は ~1,170 ブロック進む間に観測は 90 ラウンド）。
2. **relay 方式では入札戦略を表現しきれない**。agent は action を返して coordinator に代理提出してもらうため、nonce 自己管理・fee bump（同一 nonce 置換による後出し増額）・キャンセル・mempool 監視ができない。priority fee オークションを競争の中核に据えた設計（ADR 0001/0003）に対し、戦略空間が人工的に狭い。
3. **中央 relay の設計根拠が既に消えている**。agent を RPC から隔離した主因は決定論（中央 ordering 管理）だったが、ADR 0005 で決定論は放棄済み。さらに現実装は `ERIS_RPC_URL` を agent 子プロセスへ渡しており（`src/realtime/agentProcess.ts`）、分離は**規約**であって強制ではない。coordinator が実質独占しているのは秘密鍵と提出経路だけである。

### 検討した選択肢

- **A. 現状維持 + 観測ループ最適化** — 中央 relay のまま、per-agent 読取の並列化・multicall 化・観測間引きで高速化。
- **B. 送信のみ直接化** — agent に秘密鍵を渡し tx は直接送信。observation は従来どおり coordinator が push。
- **C. 完全分離（環境/agent の対称化）** — 環境は**チェーンへの書き込み（oracle・flow・keeper）だけで世界を動かし**、agent は**チェーンの読み書きだけで知覚・行動する**。観測も agent が self-serve。

### 各選択肢の評価

| 観点 | A 最適化 | B 送信のみ直接 | C 完全分離 |
|------|---|---|---|
| 観測ボトルネック（agent 数比例）の解消 | 低（定数倍改善のみ） | 低（読みは中央のまま） | 高（環境ループが agent 数非依存） |
| 入札戦略の表現力（nonce/fee bump/mempool） | 無 | 高 | 高 |
| ルール執行（fee/サイズ上限） | 高（validateAction 事前検査） | 中（事後検出へ） | 中（事後検出へ） |
| 既存 27 戦略の流用 | 高（無改修） | 高（無改修） | 中（lib 互換シムで無改修化） |
| 実装コスト | 中 | 小 | 大 |
| コンペ（信頼できない bundle）対応 | 中（プロセス分離のみ） | 中 | 高（信頼境界が「ウォレット+RPC」に一本化、プロキシを足す土台） |

## Decision

**環境（市場機構）とエージェント実行を分離する。C（環境はチェーン書き込みのみで世界を動かし、agent はチェーン読み書きのみで知覚・行動する）へ直行する — B（送信のみ直接化）経由の段階移行は採らない。** B は課題 2（入札表現力）しか解かず、最大の pain である課題 1（観測ループの agent 数比例）が B 期間中ずっと残り、フルロスター評価が壊れたままになるためである。ブロック内順序は引き続き anvil `--order fees` に委ね、coordinator は「環境デーモン + 採点者」へ縮小する。

実装順序の前提: 本 ADR の実装に先立ち、同期ラウンド方式（`npm run sim`）と `leaderboard` の deprecated 化（realtime 一本化の文書レベル整理）を済ませる。互換シムを含む lib を realtime 一系統で作り、二系統メンテを避けるため。

### 1. 責務分割

```
環境プロセス（coordinator を縮小）            agent プロセス × N（完全独立）
  ・anvil ライフサイクル(fork/setup/mining)     ・env で受領: RPC URL / 自分の秘密鍵 /
  ・fair price 生成(Rng(seed)) →                 上限等の config / runId・ログ出力先
    PriceFeed/oracle 更新 tx を毎ブロック書込    ・自分のペースでブロック購読・state 読取
  ・flow bot 注文の送信(市場を動かす)            ・自分で署名し eth_sendRawTransaction
  ・GMX keeper(注文執行)                        ・runs/<id>/agents/<id>.jsonl へ行動ログ
  ・採点(run 後に歴史ブロックから一括再構成)・ログ
        └──────────── 同じ mempool。順序は anvil --order fees ────────────┘
```

### 2. agent の直接チェーンアクセス

- 環境は agent 子プロセスへ `ERIS_RPC_URL` に加えて**自分の秘密鍵**を env で渡す。切替フラグ（`ERIS_AGENT_DIRECT_TX=1`）は **run 単位で全 agent に一律適用**する（ロールバック用。relay/直接の混在ロスターはレイテンシ・情報速度が非対称になり公平性を歪めるため作らない）。
- agent は newHeads/ポーリングで自走し、必要な state（pool 価格・oracle・自残高・自ポジション）を自分で読む。**読みの遅い agent は古い情報で動くだけ**で、環境は待たない（実市場と同型）。
- 既存 27 戦略は `examples/agents/lib/` に「チェーンから旧 observation 形を再構成する互換シム」を追加して**無改修で移行**する（realtime 化時の既存手法の再利用）。
- **run 境界はプロセス再起動で切る**: 反復評価（regime×N の直列実行。ADR 0005）では run ごとに agent プロセスを起動し直す。自走 agent の nonce キャッシュ・ブロック購読が resetFork の残留状態と相互作用するのを避ける（resetFork が状態を完全に消さない既知問題への防御でもある）。stdin の制御プレーン化（start/stop 通知でプロセスを使い回す案）は、状態リセットの責務が agent 実装へ漏れるため採らない。

### 3. fair price の配布はオンチェーンへ一本化（専用 PriceFeed コントラクト）

現状 observation で配る `fairPriceUsdcPerWeth` は特権情報である。**専用 PriceFeed コントラクトを常設し、環境が毎ブロック fair price を書き込む tx を正式な配布経路とする**（uniswap pool 価格との乖離が裁定シグナル、という構図は不変）。既存 oracle の流用ではなく専用コントラクトにするのは、uniswap-only 構成に読み手の oracle が存在せず、構成ごとに配布経路が分岐するのを避けるため。aave/gmx の oracle 更新はプロトコル機構として従来どおり継続する。stdin push は C 移行と同時に廃止する。

なおオンチェーン配布は push 配布より**情報が 1 ブロック遅れる**（書き込み tx は次ブロックで着弾する）。全 agent に等しく作用するため公平性は保たれるが、意図的な仕様変更としてここに明記する。

### 4. 帰属・採点（評価基盤との接続）

- coordinator は wallet→agent 対応を保持しているため、`logBlock` を **from アドレス引き**へ変更して blocks.csv / revert・included 集計を維持する（`submittedByHash` 方式の置換）。
- per-agent 価値系列（Sharpe / IR。ADR 0005 の evaluate・discrimination が要求）は、**run 終了後に環境が歴史ブロック読取で一括再構成する**。anvil は mine 済みブロックの状態を保持するため、blockNumber 指定の `eth_call`（Multicall3 で 44 agent 分の残高・ポジション読取を束ねる）で各ブロック断面の総価値を遡って読める（**フォーク + フルロスター実 run で検証済み** — `scripts/verifyHistoricalReads.ts`。1 断面 132 読取が warm 9–23 ms。ただし保持深度に有限の上限あり — Risks 参照）。
- run 中に採点読取を持たないことの帰結: (1) 環境の実時間ループから agent 数比例の読取が**完全に消える**（実時間ループは書き込み = oracle・flow・keeper と blocks.csv 記録のみ）、(2) 採点が競争に干渉せず、**スナップショット位相に同期する指標ハックが原理上不可能**、(3) blockNumber 指定読取により**全 agent 同一ブロック断面**が自動的に保証され、IR（benchmark 系列との点対応）が濁らない。
- 再構成の既定粒度は **per-block**。再構成コスト（run 後の追加 wall-clock）が問題になったら固定間隔（M ブロックごと）へ間引く — M は測定品質の制約ではなく**コスト調整ノブ**である。粒度は summary に記録し、`gate` は粒度不一致の run 比較を拒否する。
- **resetFork で歴史が消えるため、次 run の開始前に再構成を終える**（evaluate の直列反復と順序的に整合）。anvil は `--prune-history` を付けない運用に固定する。さらに保持深度（実測 ~1,050 ブロック — Risks 参照）を超えうる長 run では、run 中に K ブロックごとに直近チャンクをまとめて再構成する**チャンク再構成**へ切り替える（クリティカルパス外である性質は変わらない）。
- これにより評価 CLI（`evaluate` / `gate` / `discrimination`）は**変更なしで動く**（価値系列の形・粒度とも現行の per-block と同一のため、ADR 0005 側の変更も不要）。

### 5. ルール執行は「事前検査」から「事後検出」へ

`validateAction` の事前検査（priority fee ≤ 5 gwei、サイズ上限、bundle 上限）は直接送信では素通りになる。代替:

```
Bad:  チェーンで fee 上限を拒否する        ← プロトコル上不可能
Good: blocks.csv に全 tx の fee/サイズが残る
      → run 後に機械的に検査し、違反 agent をフラグ/失格(評価から除外)
      → コンペ段階では eth_* のみ通す whitelist RPC プロキシを前段に置く
```

加えて以下を決定する:

- **市場を歪める違反（fee 上限超など順序に影響するもの）は、違反 agent の失格に加えて当該 run を無効化し再実行する**。失格だけでは違反 tx が動かした市場で他 agent の成績が付く「run 汚染」が統計サンプル（ADR 0005 の N 反復）に混入するため。違反検査は evaluate の run 収集ループに組み込み、検出時は自動で再実行する。
- **入口対策として `/strategy-evolve` のゲートに静的検査を追加する**: 生成・編集された戦略コードに cheatcode 呼び出し（`anvil_*` / `evm_*` 等）が含まれないことを機械検査する。LLM が戦略コードを書く運用では「自作 agent = 信頼前提」が成り立たないため、事後監査（残高・状態の不正変化検査）と対になる入口側の防御として置く。
- **mempool 活動（送信・fee bump 置換・キャンセル）は 2 段で記録する**: まず lib のチェーンクライアントが agent の `runs/<id>/agents/<id>.jsonl` へ自己申告で記録する（strategy-evolve の診断の一次情報。直接送信化で coordinator が submitted を数えられなくなる穴を塞ぐ）。follow-up として環境が anvil の `txpool_content` スナップショットを記録し、自己申告と突合可能にする。

## Consequences

### Positive

- **環境ループが agent 数に依存しなくなり**、2 秒ブロックへの追従がロスター規模と独立になる（44 体で 11→90 秒/ラウンドだった構造問題の解消）。
- nonce 管理・fee bump・mempool 監視が解禁され、**priority fee オークションの戦略空間が実市場に近づく**（ADR 0003 の識別力ハードニングと同方向）。
- 信頼境界が「1 ウォレット + RPC エンドポイント」に一本化され、本番コンペ（zip bundle = 信頼できないコード）のセキュリティ設計（プロキシ挿入）が素直になる。
- 評価基盤（ADR 0005）は価値系列と summary の形・粒度（per-block）が保たれるため無改修。
- 採点が run 後のオフライン後処理になり、実時間中の読取競合・測定干渉（採点位相への戦略の過適合を含む）が構造的に消える。

### Negative

- **ルール執行が事前防止から事後検出に弱まる**。
  - → blocks.csv ベースの機械検査 + 失格運用。コンペ段階で whitelist プロキシを必須化。
- **agent 実装が重くなる**（読み・署名・nonce 管理が自前）。
  - → lib に chain クライアント + 観測互換シムを提供し、戦略コードは従来の `decide(obs)` 形を維持できるようにする。
- 採点系列（run 後再構成）が agent の知覚と非同期になり、観測ベースの行動ログと突合しにくくなる。
  - → 系列はブロック番号付きで再構成される。agent ログ側にも判断時点のブロック番号を残し、ブロック番号でアラインして分析する。

### Risks

- **anvil の cheatcode RPC（`anvil_setBalance` / `evm_mine` / `anvil_impersonateAccount` 等）は無認証**であり、直接アクセスする agent は原理上チートできる。
  - → PoC は事後監査（残高・状態の不正変化検査）+ `/strategy-evolve` ゲートの静的検査（§5）。LLM が戦略コードを書く運用では「信頼前提」が成り立たないため、信頼には頼らない。コンペでは whitelist プロキシを必須とする。
- fee 上限をチェーンで強制できないため、「oracle が常に txIndex 0」の保証が破られうる。
  - → oracle fee を十分高く設定しつつ、上限超過 bid は事後失格 + 当該 run 無効・再実行とする（§5）。
- 全 agent が個別に anvil を叩くことで **anvil 自体が律速**になる可能性（読み負荷の総量は中央集約時と同等以上。ただし採点読取が run 後へ移ることで実時間中の負荷は採点分だけ軽くなる）。
  - → 読み頻度の規約（推奨ポーリング間隔）を置き、フルロスターで実測してから上限を再評価する。判定指標（例: ブロック追従率、RPC レイテンシ p99）は実測前に決めておく。なお規約だけでは暴走 agent（過剰ポーリング）が全員を遅くするのを検出できない — プロキシ導入（コンペ段階）までの既知の穴とする。
- **採点の run 後再構成は anvil の歴史 state 保持に依存し、保持深度は有限**（2026-06-11 実測。`scripts/verifyHistoricalReads.ts` / `runs/2026-06-11T15-27-44-985Z`）。フォーク + 44 agent 実 run の検証では、run 窓の start/mid/end 断面の Multicall3 一括読取（132 読取/断面、cold 696 ms・warm 9–23 ms）、tx 前後の残高変化、aave `getUserAccountData` の歴史読取まですべて成功。ただし**深度 ~1,050 ブロックまでは読めるが ~1,100 以深では `eth_call` が「missing bytecode for code hash」で失敗する**（`eth_getBalance` はより深くても返る = ディスク退避 state に contract bytecode が欠落する anvil の挙動）。フルロスターの長 run はチェーンが ~1,170 ブロック進んだ実績があり、この深度に届きうる。
  - → 再構成は run 終了直後に行うことを必須とし、run のチェーンブロック数が保持深度に近づく構成では**チャンク再構成**（§4）を使う。`--max-persisted-states` の増量で bytecode 欠落が解消するかは未検証（解消すれば単純化できる）。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| whitelist RPC プロキシの実装方式・導入時期 | PoC は事後監査 + 静的検査（§5）で足り、コンペ要件（ADR 0003/0004 の先）が固まっていない | コンペ提出形式の確定時 |
| flow bot 自身も直接送信へ移すか | flow は環境側の市場機構であり、relay 維持でも分離の目的は達成される | 環境デーモン縮小の実装時 |
| 価値系列の再構成を間引くか（per-block 既定で足りるか、間引くなら間隔） | run 後再構成の追加 wall-clock を実測してから判断すべき（warm 9–23 ms/断面の実測からは per-block で足りる見込み） | C 実装後の実測で |
| チャンク再構成の間隔 K | 短 run（チェーン ~1,000 ブロック未満）では単純な run 後一括で足りる。長 run の頻度・保持深度マージンを見たい | C 実装後、長 run 運用時 |
| txpool 監視（mempool 突合）の導入時期 | 自己申告ログ（§5）で PoC は回る。検証可能性が必要になる時点を見たい | コンペ要件の確定時 |
| anvil 律速の判定指標の具体値（ブロック追従率・レイテンシ閾値） | フルロスター実測のデータが要る | C 実装後の実測で |

## Notes

### 参考資料

- ADR 0001: 多エージェント競争プラットフォーム（プロセス分離の出典）
- ADR 0003: 競争環境の識別力ハードニング（realtime 化・fee オークション）
- ADR 0005: 実時間化で決定論を捨てた後の評価基盤（決定論放棄 = 中央 relay の根拠消滅。価値系列の要件）
- 実測データ: `runs/2026-06-10T19-07-58-755Z`（44 agent フルロスター。観測ループ 11→90 秒/ラウンドの劣化カーブ、fee ordering 検証 145/160、oracle 先頭 103/103）
- 実測データ: `runs/2026-06-11T15-27-44-985Z`（歴史ブロック読取の検証 run。§4 前提の検証と保持深度の実測 — Risks 参照）
- 関連コード: `src/realtime/coordinator.ts`（縮小対象の観測ループ）、`src/realtime/agentProcess.ts`（`ERIS_RPC_URL` 受け渡し）、`src/action.ts`（`validateAction` = 事後検出へ移す検査群）、`examples/agents/lib/`（互換シムの置き場所）、`scripts/verifyHistoricalReads.ts`（歴史読取検証スクリプト。再実行可能）
