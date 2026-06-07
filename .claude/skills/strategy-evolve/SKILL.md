---
name: strategy-evolve
description: |
  トレード戦略を 1 サイクル進化させる: マルチシードでベースライン評価 → run データ + agent 行動ログで最弱 agent を数値診断 →
  1 agent / 1 変更を選定（まず env パラメータ、不足時のみコード編集）→ 実装 → マルチシード再評価（paired ゲート）で過学習を抑制 →
  受理/差し戻し判定 → evolution ログを runs/strategy-iterations/iter-NN.md に保存。次回は前ログを参照し同じ agent を連続で触らない。
  使用: ユーザーが「戦略を進化させて」「strategy-evolve」「agent を強くして」「戦略ループ回して」「最弱 agent を改善して」と言ったとき。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
---

# strategy-evolve: データ駆動のトレード戦略進化ループ

このスキルは eris-competition-poc の**トレード戦略**を 1 サイクル分進化させる。
sim-loop が「シミュレータの仕組み」を直すのに対し、本スキルは「agent の戦略」を直す。
**1 回呼び出し = 1 イテレーション分**。続けたい場合はユーザーが再度呼び出す。

## 0. 前提

- `npm run anvil` が別ターミナルで起動済みであること
- 改善対象は `agents.evolve.json` のロスター（`arb` / `gmx-rev` / `cvbal` / `dn-lp`）。**市場(fair price + flow bot)は各 SEED で決定論的に固定**（同一 SEED の before/after は同一市場）。flow bot の設定は触らず agent だけを変える
- **1 サイクル = 1 agent / 1 変更**。複合変更は原因切り分け不能になるので禁止
- 受理は常に**マルチシード**評価で判定（単一 seed の過学習を**抑制**）。5 seed は完全な排除ではなく sanity check なので過信しない（holdout 再検証は Notes 参照）
- `runs/` は gitignore 対象。git 追跡されるのは `agents.evolve.json` と `examples/agents/*.ts` のみ → revert は `git checkout`

## 1. Baseline（マルチシード評価）

```bash
SEEDS=1,2,3,4,5 ROUNDS=128 AGENTS_CONFIG=agents.evolve.json npm run evaluate --silent 2>err.log | tee /tmp/eval-before.json
```

> **`--silent` 必須**: 付けないと npm が `> eris-competition@… evaluate` バナーを **stdout** に出して JSON を壊す。stdout は evaluate の JSON 専用。検証は `node -e 'JSON.parse(require("fs").readFileSync("/tmp/eval-before.json","utf8"))'` が通ること。

- `evaluate` は各 seed で sim を回し、agent ごとに **median / mean / min(最悪 seed) / stdev / win-rate** の netPnl と median/mean Sharpe を JSON で出す。
- 速度優先なら `SEEDS=1,2,3`（精度は落ちる）。重い場合は `ENABLED_PROTOCOLS=uniswap,balancer,curve,gmx` で aave を外してもよい（ただし baseline と after で同じ条件を厳守）。
- **`FORK_BLOCK_NUMBER` を固定**して anvil を起動すること。未固定だと baseline と after で市場の起点がずれて比較不能になる（`evaluate` 出力の `forkBlock` で確認）。
- 診断対象の run は **`/tmp/eval-before.json` の `perSeedRuns`（seed → `runId`/`runDir` 対応）から選ぶ**。`runs/<latest>` は最後の seed の run でしかなく「代表」ではないので使わない。

## 2. Diagnose（戦略診断 + 行動ログ）

`/tmp/eval-before.json` で **最弱 agent** を選ぶ（median Sharpe → median netPnl の昇順。`evaluate` の sort と逆順の末尾）。
前 `runs/strategy-iterations/iter-*.md` を読み、**直前イテレーションで触った agent は選ばない**。

選んだ agent について、以下を計算して根本原因を 1 つ特定する。
**PnL 帰属は共有モジュール `src/llm/attribution.ts`（`computeAttribution`）を一次の物差しにする**
（live revise の `buildReviseMessage` と同じ指標 = 単一ソース。ADR 0002）。対象 agent の per-round
価値系列・行動から `byAction[].netUsd`（どの行動が稼ぎ/損したか）・`turnover`・`drawdownUsd`・
`topNoopReasons` を出し、「**負の netUsd を出している行動**」か「**機会を逃している noop 理由**」を起点にする。
**診断は worst seed の run を開く**: `perSeedRuns` から、対象 agent の `netPnl.perSeed` が最小だった seed の `runDir` を `<worstRunDir>` とする（中央値挙動も見たいなら median seed の `runDir` も併読）。以降の成果物パスはこの `<worstRunDir>` 配下。
**最重要の一次情報は `<worstRunDir>/agents/<target>.jsonl`（agent 自身の行動ログ）**:

### 行動ログ（<worstRunDir>/agents/<target>.jsonl）
- [ ] **判断理由の分布**: `reason` 別の頻度。「gap too small / spread too small で noop 連発」→ 閾値が保守的すぎ。「stop / reverted 頻発」→ exit param 誤調整。
- [ ] **シグナル vs 行動の乖離**: `signals.gap`/`signals.spread`/`signals.dev` が大きいのに noop → 閾値が機会を取り逃している。`state.phase` が同じ値で停滞 → state machine の詰まり。
- [ ] **サイジング**: `signals.sizeBps`/`signals.sizeUsdc`/`signals.notionalUsd` が小さすぎ/大きすぎ。

### run 成果物
- [ ] **機会捕捉**: `history.json` の gap 合計 vs `blocks.csv`（`ownerId==target & status==success`）の約定数。capture < ~40% は edge 取り逃し。
- [ ] **オークション勝率**: `blocks.csv` の `txIndex`（0=最高 bid）。常に out-bid されていれば fee/`BID_PROFIT_FRACTION` 不足。
- [ ] **revert/gas drag**: `summary.json` の `revertCount/submittedTxCount`、`gasCostEth`。revert 多発は slippage/サイズ過大。gas が netPnl を食う(>30%)なら overtrading。
- [ ] **リスク調整**: per-round 価値系列（events.jsonl）の Sharpe/drawdown。netPnl 正でも Sharpe 低 → oversizing。

失敗項目を **インパクト × 修正コスト** で並べ、トップ 1 を選ぶ。

## 3. Plan（≤30 行）

選んだ 1 agent / 1 変更を書く:
- **問題**: 数値で（例「arb: idle 比率 71%、gap>20bps の機会の 78% を noop で逃している」）
- **根本原因**: 行動ログ / コードの該当箇所
- **修正方針（param-first ラダー）**:
  1. **第1層（既定）**: `agents.evolve.json` の対象 agent の `env` を変える（例 `BID_PROFIT_FRACTION` 0.3→0.5、`ENTRY_BPS` 40→25）。**全 param を env に明示**（既定値と同じでも書く）
  2. **第2層（エスカレーション）**: 既存 env で根本原因に届かない構造的問題のときだけ、対象 agent の `.ts` を 1 ファイルだけ編集。新定数は `process.env.X ?? default` で露出し env 層に戻す
- **成功条件 = 下記の受理ルール**
- **revert 手段**: `git checkout -- agents.evolve.json examples/agents/<target>.ts`

## 4. Implement

**1 agent への 1 変更だけ**。`npm run typecheck` と `npm run test` を通す。

## 5. Re-evaluate（同一 seed 集合）

```bash
SEEDS=1,2,3,4,5 ROUNDS=128 AGENTS_CONFIG=agents.evolve.json npm run evaluate --silent 2>err.log | tee /tmp/eval-after.json
```

## 6. Accept / Revert ゲート（過学習耐性）

対象 agent について `/tmp/eval-before.json` と `/tmp/eval-after.json` を比較し、**全て満たすときのみ受理**:

1. **median netPnl 改善**: `median(after) > median(before)`
2. **どの seed も崩れない（paired）**: 全 seed `i` で `after.netPnl.perSeed[i] ≥ before.netPnl.perSeed[i] − 0.5·|median 改善幅|`。`perSeed` は before/after とも `seeds` と同順なので index で 1:1 対応する。
   ※ 旧「全体 min 比較（`min(after) ≥ min(before) − …`）」は、元から低い別 seed に紛れて特定 seed の急落を見逃すので**使わない**。必ず seed 対応（paired）で見る。
3. **win-rate 非低下**: 正 PnL の seed 数 `after ≥ before`（5 seed では 20% 刻みの粗い補助指標。主判定は 1 の median と 2 の paired）
4. **他 agent への転嫁チェック**: 他 agent の median netPnl 合計の低下が対象の改善を超えない（ほぼゼロサム。gas 入札で 1 体から奪っただけは **flag してログ**、自動却下はしない）
5. `typecheck` / `test` パス

いずれか失敗 → **REVERT**: `git checkout -- agents.evolve.json examples/agents/<target>.ts`。失敗イテレーションとして metric 表ごとログに残す（同じ手を再試行しない）。
median netPnl が ±1% 以内なら median Sharpe をタイブレーク（leaderboard と同じ序列）。

## 7. evolution ログを保存

`runs/strategy-iterations/iter-NN.md`（`mkdir -p` 必要。NN = 既存最大 + 1、ゼロ埋め 2 桁）:

```md
# Strategy Iteration NN — <target>: <一行変更>

**Date**: <ISO date>
**Config**: agents.evolve.json  **Seeds**: 1,2,3,4,5  **Rounds**: 128
**ForkBlock**: <FORK_BLOCK_NUMBER>  **Commit**: <git rev-parse --short HEAD>  **Protocols**: <ENABLED_PROTOCOLS or all>

## Target & Diagnosis
- 対象: <id>（median Sharpe X / median netPnl Y で最弱）
- 根本原因（数値）: <行動ログ/run の根拠>

## Change（param-first）
- Layer: PARAM | CODE
- Before: <env ブロック / 変更前定数>
- After:  <env ブロック / 変更後定数>
- Revert: `git checkout -- agents.evolve.json [examples/agents/<id>.ts]`

## Multi-seed result（target agent）
| metric | before | after | Δ | gate | OK? |
|---|---:|---:|---:|---|:--:|
| median netPnl | … | … | … | rule 1 | ✓/✗ |
| worst paired Δ = min_i(after_i − before_i) | – | – | … | rule 2 | ✓/✗ |
| win-rate | …/5 | …/5 | … | rule 3 | ✓/✗ |
| median Sharpe | … | … | … | tiebreak | – |
| per-seed netPnl | [s1..s5] | [s1..s5] | | overfit check | |

## Decision: ACCEPT | REVERT
typecheck: pass/fail · test: pass/fail · 他 agent 影響: <Σ median Δ>

## Next candidates
- <2-3 個。次サイクルはこの agent を除外>
```

## 8. ユーザーへ報告

短く: 何を直したか / median before→after / 過学習チェック結果(min・win-rate) / 次候補 1-2 個。
「次回まわす？」とは聞かない。

## 9. (ADR 0002) LLM seed の昇格と A↔B 連携

ロスターに `claude-llm`（`ERIS_BASE_STRATEGY=<id>`）の自己改善 agent が含まれる場合、**live(A) が run 中に
生み出した改良版を offline(B) のゲートで選別し、勝者をベース戦略へ恒久昇格**できる（ADR 0002 の A↔B ループ）。

1. **収穫**: 直近 run の `runs/<runDir>/agent-llm-<id>/strategy-v*.{md,params.json,executor.ts}` と
   `claude-calls.jsonl`（`ok:true` の版）から、最終版や PnL 改善の大きい版を候補に集める。
2. **ゲート**: 候補 `executorTs`/`params` を `src/llm/baseStrategies.ts` の当該 `<id>` に**一時差し替え**し、
   `ERIS_FREEZE_STRATEGY=1`（v1 固定・LLM 呼び出し無し・決定論）で §1/§5 と同じ **マルチシード paired 評価**を回す。
   旧ベース vs 候補で §6 の受理ルール（median 改善 + paired 非劣化 + win-rate）を適用。
3. **恒久昇格**: 受理なら候補を `src/llm/baseStrategies.ts` の `<id>` に正式反映して commit（= A が次回 seed する v1 が良くなる）。
   不受理なら差し戻し（`git checkout -- src/llm/baseStrategies.ts`）。
4. **change→result メモリ**: 採用/却下を理由つきで `runs/strategy-iterations/iter-NN.md` に記録（A の `buildReviseMessage`
   が将来このメモリを参照して同じ失敗の反復を避ける）。

> 注意: live(A) は params-only 既定 + sanity ゲートで run 内の劣化を抑えるだけで、**恒久化はしない**。
> 恒久ベース(`baseStrategies.ts`)を書き換えるのは常に B のこのゲートを通す（ADR 0002 の受け渡し点）。

---

## Notes

- 1 サイクル ~30-50 分（128 round × 5 seed × baseline + after）。`SEEDS=1,2,3` で短縮可
- **seed セットへの過学習に注意**: `SEEDS=1,2,3,4,5` を固定で使い続けると、その seed 集合だけに効く変更が蓄積する。数イテレーションごとに **holdout seed（例 `SEEDS=11,12,13`、診断には使わない）** で受理済み変更をまとめて再検証し、holdout で崩れていれば巻き戻す。
- 全 agent が改善余地なし（全 metric グリーン）なら「進化完了」と報告して終了
- 同じ agent で連続失敗（受理不可）3 回でアラートを上げユーザー判断を仰ぐ
- ログ・run は git に commit しない
- **設計の全体像は ADR 0002（LLM 戦略自己改善の2層アーキテクチャ）**。本スキル = offline(B) 層。
  共有コア（`prompts.ts` / `strategy.ts` / `attribution.ts` / `multiSeedRun.ts` / `baseStrategies.ts` / メモリ）を
  live(A) 層と共用する。§9 が A↔B の昇格ループ
