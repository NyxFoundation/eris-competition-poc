# ADR 0006: 環境（市場機構）とエージェント実行の分離 — agent の直接チェーンアクセス

## Status

Proposed

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

**環境（市場機構）とエージェント実行を分離する。最終形は C（環境はチェーン書き込みのみで世界を動かし、agent はチェーン読み書きのみで知覚・行動する）とし、B（送信のみ直接化）を経由して段階移行する。ブロック内順序は引き続き anvil `--order fees` に委ね、coordinator は「環境デーモン + 採点者」へ縮小する。**

### 1. 責務分割

```
環境プロセス（coordinator を縮小）            agent プロセス × N（完全独立）
  ・anvil ライフサイクル(fork/setup/mining)     ・env で受領: RPC URL / 自分の秘密鍵 /
  ・fair price 生成(Rng(seed)) →                 上限等の config / runId・ログ出力先
    oracle 更新 tx として毎ブロック書き込み      ・自分のペースでブロック購読・state 読取
  ・flow bot 注文の送信(市場を動かす)            ・自分で署名し eth_sendRawTransaction
  ・GMX keeper(注文執行)                        ・runs/<id>/agents/<id>.jsonl へ行動ログ
  ・採点・ログ(読み取り専用、非クリティカル)
        └──────────── 同じ mempool。順序は anvil --order fees ────────────┘
```

### 2. agent の直接チェーンアクセス

- 環境は agent 子プロセスへ `ERIS_RPC_URL` に加えて**自分の秘密鍵**を env で渡す（フラグ `ERIS_AGENT_DIRECT_TX=1` で段階導入）。
- agent は newHeads/ポーリングで自走し、必要な state（pool 価格・oracle・自残高・自ポジション）を自分で読む。**読みの遅い agent は古い情報で動くだけ**で、環境は待たない（実市場と同型）。
- 既存 27 戦略は `examples/agents/lib/` に「チェーンから旧 observation 形を再構成する互換シム」を追加して**無改修で移行**する（realtime 化時の既存手法の再利用）。

### 3. fair price の配布はオンチェーンへ一本化

現状 observation で配る `fairPriceUsdcPerWeth` は特権情報である。環境は既に毎ブロック aave/gmx oracle を mempool 経由で更新しているため、**oracle 更新 tx を fair price の正式な配布経路とする**（uniswap pool 価格との乖離が裁定シグナル、という構図は不変）。移行期は stdin push を併用する。

### 4. 帰属・採点（評価基盤との接続）

- coordinator は wallet→agent 対応を保持しているため、`logBlock` を **from アドレス引き**へ変更して blocks.csv / revert・included 集計を維持する（`submittedByHash` 方式の置換）。
- per-agent 価値系列（Sharpe / IR。ADR 0005 の evaluate・discrimination が要求）は、環境が**読み取り専用の非同期スナップショット**として毎ブロック記録する。観測 push と違い agent 実行をゲートしないため、遅延しても競争を歪めない。
- これにより評価 CLI（`evaluate` / `gate` / `discrimination`）は**変更なしで動く**。

### 5. ルール執行は「事前検査」から「事後検出」へ

`validateAction` の事前検査（priority fee ≤ 5 gwei、サイズ上限、bundle 上限）は直接送信では素通りになる。代替:

```
Bad:  チェーンで fee 上限を拒否する        ← プロトコル上不可能
Good: blocks.csv に全 tx の fee/サイズが残る
      → run 後に機械的に検査し、違反 agent をフラグ/失格(評価から除外)
      → コンペ段階では eth_* のみ通す whitelist RPC プロキシを前段に置く
```

## Consequences

### Positive

- **環境ループが agent 数に依存しなくなり**、2 秒ブロックへの追従がロスター規模と独立になる（44 体で 11→90 秒/ラウンドだった構造問題の解消）。
- nonce 管理・fee bump・mempool 監視が解禁され、**priority fee オークションの戦略空間が実市場に近づく**（ADR 0003 の識別力ハードニングと同方向）。
- 信頼境界が「1 ウォレット + RPC エンドポイント」に一本化され、本番コンペ（zip bundle = 信頼できないコード）のセキュリティ設計（プロキシ挿入）が素直になる。
- 評価基盤（ADR 0005）は価値系列と summary の形が保たれるため無改修。

### Negative

- **ルール執行が事前防止から事後検出に弱まる**。
  - → blocks.csv ベースの機械検査 + 失格運用。コンペ段階で whitelist プロキシを必須化。
- **agent 実装が重くなる**（読み・署名・nonce 管理が自前）。
  - → lib に chain クライアント + 観測互換シムを提供し、戦略コードは従来の `decide(obs)` 形を維持できるようにする。
- 採点スナップショットが agent の知覚と非同期になり、観測ベースの行動ログと突合しにくくなる。
  - → スナップショットにブロック番号を必ず付与し、ブロック番号でアラインして分析する。

### Risks

- **anvil の cheatcode RPC（`anvil_setBalance` / `evm_mine` / `anvil_impersonateAccount` 等）は無認証**であり、直接アクセスする agent は原理上チートできる。
  - → PoC（自作 agent）は信頼前提 + 事後監査（残高・状態の不正変化検査）。コンペでは whitelist プロキシを必須とする。
- fee 上限をチェーンで強制できないため、「oracle が常に txIndex 0」の保証が破られうる。
  - → oracle fee を十分高く設定しつつ、上限超過 bid は事後失格とする。
- 全 agent が個別に anvil を叩くことで **anvil 自体が律速**になる可能性（読み負荷の総量は中央集約時と同等以上）。
  - → 読み頻度の規約（推奨ポーリング間隔）を置き、フルロスターで実測してから上限を再評価する。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| whitelist RPC プロキシの実装方式・導入時期 | PoC では信頼前提で足り、コンペ要件（ADR 0003/0004 の先）が固まっていない | コンペ提出形式の確定時 |
| fair price のオンチェーン配布の形（既存 oracle 流用 / 専用 price feed コントラクト） | uniswap-only 構成での読み手がいない等、構成ごとの要件を見たい | B→C 移行の実装時 |
| flow bot 自身も直接送信へ移すか | flow は環境側の市場機構であり、relay 維持でも分離の目的は達成される | 環境デーモン縮小の実装時 |
| B→C の切替条件 | B（送信のみ直接）の実測で観測ボトルネックの残存度を見てから | B 運用後の実測で |
| 同期ラウンド方式（`npm run sim`）・`leaderboard` の扱い | realtime 一本化（ADR 0005）の文書レベル整理と同時に判断すべき | realtime 一本化の完了後 |

## Notes

### 参考資料

- ADR 0001: 多エージェント競争プラットフォーム（プロセス分離の出典）
- ADR 0003: 競争環境の識別力ハードニング（realtime 化・fee オークション）
- ADR 0005: 実時間化で決定論を捨てた後の評価基盤（決定論放棄 = 中央 relay の根拠消滅。価値系列の要件）
- 実測データ: `runs/2026-06-10T19-07-58-755Z`（44 agent フルロスター。観測ループ 11→90 秒/ラウンドの劣化カーブ、fee ordering 検証 145/160、oracle 先頭 103/103）
- 関連コード: `src/realtime/coordinator.ts`（縮小対象の観測ループ）、`src/realtime/agentProcess.ts`（`ERIS_RPC_URL` 受け渡し）、`src/action.ts`（`validateAction` = 事後検出へ移す検査群）、`examples/agents/lib/`（互換シムの置き場所）
