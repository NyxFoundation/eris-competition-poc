# strategy-evolve テンプレ化 設計メモ

> ステータス: **設計のみ（未実装）**。`strategy-evolve` を「1 ロスター専用」から「戦略プロファイル駆動の汎用進化エンジン」へ作り替えるための設計。実装着手は本メモ合意後。

## 1. 目的とスコープ

**やりたいこと**: 同じ自己改善ループを、いろんな戦略に当てられるようテンプレ化する。

**スコープ（今回対象）**
- ✅ **eris 内の別ロスター**: `agents.swarm.json` / `agents.new-strategies.json` / `agents.multi.json` など別の agent 集合に同じループを適用。
- ✅ **目的関数が違う戦略族**: PnL 最大化以外（リスク調整=Sharpe/分散最小、gas 効率、MM スプレッド取得 等）も受理ゲートで扱えるように。

**スコープ外（今回やらない）**
- ❌ 別プロジェクト/別シミュレータへの移植（harness 抽象化）。`npm run evaluate` と eris の run 成果物（`summary.json`/`events.jsonl`/`blocks.csv`/`agents/*.jsonl`）は**固定の前提**として使う。

## 2. 設計原則: 「汎用エンジン + 戦略プロファイル」

進化ループの大部分はすでに戦略非依存。**不変の本体（SKILL.md）**と**戦略固有知識（profile）**を分離する。

| 区分 | 中身 | 置き場所 |
|---|---|---|
| **不変エンジン** | 1変更→マルチシード評価→paired ゲート→受理/差戻し→ログ という手続き／行動ログ診断の枠組み | `SKILL.md`（引数駆動に書換） |
| **戦略プロファイル** | どのロスター・調整可能 param・目的関数・診断ヒント・ログ先 | `strategy-profiles/<name>.json`（新規・git 追跡） |

**剥がすべきハードコード（現 SKILL.md）**: `agents.evolve.json` / roster 4 ids（arb/gmx-rev/cvbal/dn-lp）/ `runs/strategy-iterations/` / 「median+min+win-rate 固定ゲート」。

## 3. Strategy Profile スキーマ

`strategy-profiles/<name>.json`（1 ファイル = 1 戦略族）:

```jsonc
{
  "name": "evolve",
  "config": "agents.evolve.json",          // 進化対象ロスター（AGENTS_CONFIG）
  "roster": ["arb", "gmx-rev", "cvbal", "dn-lp"],  // スコープ内 agent id
  "eval": {
    "seeds": [1, 2, 3, 4, 5],              // 探索 seed
    "holdoutSeeds": [11, 12, 13],          // 定期再検証用（診断には使わない）
    "rounds": 128,
    "protocols": "uniswap,balancer,curve,gmx",   // ENABLED_PROTOCOLS
    "forkBlock": 469000000                 // 再現性のため固定（archive RPC 前提）
  },
  "tunables": {                            // 探索空間 = skill が編集する唯一の真実源
    "gmx-rev": {
      "ENTRY_BPS":  { "default": 40, "min": 15, "max": 80, "step": 5 },
      "EXIT_BPS":   { "default": 10, "min": 5,  "max": 30, "step": 5 },
      "STOP_USD":   { "default": 150, "min": 50, "max": 400, "step": 25 },
      "MA_LOOKBACK":{ "default": 12, "min": 4,  "max": 32, "step": 2 },
      "LEVERAGE":   { "default": 2,  "min": 1,  "max": 4,  "step": 1 }  // ← 現状ハードコード。要 env 化
    },
    "arb":   { "BID_PROFIT_FRACTION": { "default": 0.3, "min": 0.1, "max": 0.8, "step": 0.05 } },
    "cvbal": { "SPREAD_BPS":          { "default": 15,  "min": 5,   "max": 40,  "step": 5 } },
    "dn-lp": { "HEDGE_FRACTION":      { "default": 1.0, "min": 0.5, "max": 1.5, "step": 0.1 } }
  },
  "objective": "median_netPnl",           // §4 のレジストリから選ぶ
  "diagnosisHints": [                      // 戦略族固有の失敗モード（任意・診断の補助）
    "gmx-rev: warming up / near MA の noop 比率（機会逃し）と stop-out 頻度",
    "arb: idle 比率と gap>20bps 機会の捕捉率",
    "dn-lp: ヘッジ追従誤差（GMX short と LP デルタの乖離）"
  ],
  "logDir": "runs/strategy-iterations/evolve"
}
```

**ポイント**
- `tunables` に **min/max/step** を持たせる → skill が勝手に範囲外へ振らない＝探索空間が明示され過学習も管理しやすい。
- `holdoutSeeds` を profile に常設 → 「seed セットへの過学習」対策（数イテレーションごとに再検証）。
- `forkBlock` 必須化 → before/after の市場固定（[[強調済みの再現性要件]]）。

## 4. 目的関数とゲートの抽象化（「目的が違う戦略」対応の肝）

**設計**: 受理ゲートを「**①最適化メトリクスは profile で可変**／**②過学習ガードは常に不変**」の 2 層に分ける。これで目的が変わっても過学習耐性は維持される。

```
受理 = (primary 改善) AND (paired ガード崩れない) AND (win-rate 非低下) AND (typecheck/test pass)
        ─ objective で可変 ─    ─────────── 常に不変（安全網）───────────
```

### objective レジストリ（組込み）

| objective | 最適化対象（primary） | 方向 | paired ガード | 必要メトリクス | evaluate 対応 |
|---|---|---|---|---|---|
| `median_netPnl`（既定） | `netPnl.median` | ↑ | netPnl.perRun | netPnl | ✅ 既存 |
| `risk_adjusted` | `sharpe.median` | ↑ | netPnl.perRun（PnL 床） | sharpe, netPnl | ✅ 既存 |
| `min_variance` | `netPnl.stdev` | ↓ | netPnl.median（リターン床） | stdev, netPnl | ✅ 既存 |
| `gas_efficiency` | `netPnl / gasCostEth` | ↑ | netPnl.perRun | **gasCostEth** | ⚠️ 要追加（summary に有り、evaluate 未集計） |
| `spread_capture`（MM） | maker 実現益/出来高 | ↑ | inventory 偏り | **新規メトリクス** | ❌ 要定義+計装。**flow bot は固定なので、MM を進化対象 agent として別途用意する必要** |

### evaluate.ts への変更（最小）
- `gas_efficiency` 用に `gasCostEth`（summary.json に既存）を per-agent 集計して出力に追加。
- `spread_capture` は**メトリクス定義が未確定**（例: maker fill 量・realized spread・在庫分散）。定義 → ログ計装 → evaluate 集計、の順で別タスク化。今回は「定義待ち」とする。
- objective は数値計算なので、**evaluate はメトリクスを出すだけ**。どれを primary にするかは skill が profile を見て判断（評価ロジックを skill 側に置く＝エンジン非依存）。

## 5. パラメータ面の規約（tunables）

- **規約**: 進化対象 agent の全 tunable は `const X = Number(process.env.X ?? "<default>")` で露出する。ハードコード定数は不可（例: `gmx-reversion.ts:22` の `LEVERAGE=2` を env 化）。
- **単一の真実源**: skill は agent の `.ts` を読み回らず、**profile の `tunables` だけ**を探索対象にする。defaults も tunables に書く（`agents.*.json` の env と二重管理になる点は §8 で整理）。
- **第2層（コード編集）**: tunables で根本原因に届かない構造問題のときだけ `.ts` を 1 ファイル編集 → 新 param は env 露出して tunables に登録（既存ラダーを踏襲）。

## 6. SKILL.md の引数駆動化

- 起動: `/strategy-evolve <profile-name>`（`$ARGUMENTS`）。省略時は `evolve`（後方互換）。
- skill 冒頭で `strategy-profiles/<name>.json` を読み、以降の `AGENTS_CONFIG` / `SEEDS` / `ROUNDS` / `ENABLED_PROTOCOLS` / `FORK_BLOCK_NUMBER` / roster / logDir / objective を**全部 profile から**取る。
- §2 診断: roster と `diagnosisHints` を profile から。汎用チェックリスト（理由分布・signal vs action 乖離・capture率・revert/gas・Sharpe）はそのまま。
- §6 ゲート: §4 の「可変 primary + 不変ガード」に置換。
- §7 ログ: `<profile.logDir>/iter-NN.md`。テンプレに `Profile` / `Objective` / `ForkBlock` / `Commit` を明記。
- §0 前提: 「同じ agent を連続で触らない」は **profile スコープ内**で判定。

## 7. Scaffolder（新戦略への適用を楽にする）

> 設計は **defi-skills（Nethermind）の playbook-generator パターン**に倣う（§11）。
> 「**決定論 script が機械組立、LLM subagent が研究/判断、不明点は `_review` フラグで人へ**」の 3 分割。
> 私の初版の「skill 内でインライン生成」より保守・再現性が高い。

**(a) 決定論 script — `scripts/scaffold_profile.ts`**（LLM なし・冪等）
1. `agents.<x>.json` を読んで `roster` = agent id 一覧を埋める。
2. 各 agent の `args` から `.ts` を特定 → `grep -oE 'process\.env\.[A-Z_]+ \?\? "?[^"]*'` で **env 露出済み param と default** を抽出 → `tunables` を雛形生成。
3. 確信を持って埋められない欄は **`_review` フラグ**を付けて出力（min/max/step、objective、diagnosisHints、env 化されていない疑いのある定数）。
4. 出力: `strategy-profiles/<x>.json`（`_review` 付き草案）。

**(b) LLM subagent — `.claude/agents/strategy-profile-generator.md`**（判断担当）
1. (a) を実行 → 生成された `_review` 欄を読む。
2. 各 agent の `.ts` とコメント（env ドキュメント）を読み、**tunables の妥当な min/max/step を提案**、ハードコード定数（例 `LEVERAGE`）を検出して「env 化候補」として報告。
3. ロスターの性格から `objective`（PnL/Sharpe/分散/gas）と `diagnosisHints` を提案。
4. `_review` を解消した最終 profile を提示 → **人が確認して確定**（financial なので autonomous にしない）。

→ フロー: 「新ロスター作成 → `@strategy-profile-generator <x>` → 人がレビュー確定 → `/strategy-evolve <x>`」。

## 8. 移行手順（段階）

1. **P1 — profile 基盤**: `strategy-profiles/` 作成。現行設定を `strategy-profiles/evolve.json` に移植。SKILL.md を引数駆動に書換（既定 `evolve` で挙動不変を確認）。`evaluate` は変更不要。
2. **P2 — ゲート可変化**: §4 の objective レジストリと「可変 primary + 不変ガード」を SKILL.md §6 に実装。`evaluate` に `gasCostEth` 集計を追加。`median_netPnl`/`risk_adjusted`/`min_variance` を有効化。
3. **P3 — scaffolder**: §7 を skill 手順 or 別 skill 化。2 つ目の profile（例 `new-strategies.json`）で実証。
4. **P4 — spread_capture**: MM メトリクスを定義 → ログ計装 → evaluate 集計 → objective 追加（MM 用の進化対象 agent も用意）。

## 9. 要決定 / 未解決

- **defaults の二重管理**: `agents.*.json` の `env` と profile の `tunables.default`。真実源をどちらにするか（案: profile を真実源にし、skill が実行時に env へ流し込む／`agents.*.json` の env は初期値のみ）。
- **spread_capture の定義**: maker realized PnL か、在庫調整後 PnL か、realized spread×volume か。要合意。
- **多目的**: 1 profile で複数 objective を重み付き合成するか、当面は単一 primary + ガードに留めるか（推奨: 当面は単一）。
- **flow bot 固定の制約**: MM 戦略を進化させるなら flow bot とは別に「進化対象の MM agent」を立てる必要（CLAUDE.md の「flow bot は触らない」原則と整合させる）。
- **profile 検証**: 不正な profile（存在しない agent id、範囲矛盾）の早期検出（zod スキーマ）を入れるか。

## 10. 影響範囲

- **新規**: `strategy-profiles/*.json`、本メモ、`scripts/scaffold_profile.ts`、`.claude/agents/strategy-profile-generator.md`（§7）。
- **変更**: `.claude/skills/strategy-evolve/SKILL.md`（引数駆動・ゲート可変）、`scripts/evaluate.ts`（gasCostEth 集計／P2）、`examples/agents/*.ts`（ハードコード定数の env 化／必要分のみ）。
- **後方互換**: 既定 profile=`evolve` で現行挙動を維持。`runs/` は従来どおり gitignore。

## 11. 参考: defi-skills（Nethermind）から借りる/借りないもの

出典: https://github.com/NethermindEth/defi-skills （「NL intent → 未署名 DeFi tx」のデータ駆動 playbook エンジン）。
ドメインは違う（あちらは tx ビルダー、こちらは戦略進化）が、**アーキテクチャのメタパターンが本番リポで成立している実例**として参照する。

**借りる**
- **engine にドメインコードゼロ・知識は全部 JSON**（playbook）→ 我々の「汎用エンジン(SKILL) + 戦略 profile(JSON)」分離の裏付け。profile ≈ playbook。
- **generator subagent + 決定論 script + `_review_notes`**（playbook-generator → §7 に反映済み）。これが最大の収穫。
- **決定論境界の原則**: 「機械処理は script、判断のみ LLM」。我々も diagnosis/1変更選定だけ skill、scoring/ゲートは `evaluate` に寄せる（§4 の方針と一致）。
- **環境固有データの分離**（あちらは `data/chains/<id>/`）→ profile に seed/forkBlock 等の環境設定を混ぜすぎない指針。
- **（将来・スコープ外）plugin 化**: `.claude-plugin/{plugin,marketplace}.json` で配布可能。別リポ展開を始めるときの標準機構。

**借りない（＝自前のまま）**
- defi-skills には**評価も自己改善ループも無い**。我々の本丸 ── マルチシード評価・**過学習ゲート(paired)**・**目的関数の抽象化(§4)** ── は対応物が存在せず、完全に自前設計。
- playbook スキーマ自体（静的 tx 記述）は流用不可。借りるのはメタパターンのみ。
- 実装言語が Python（こちらは TS）。
