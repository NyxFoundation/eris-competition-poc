[← README](../../README.md)

# 設定（config/local.yaml）

実時間 run（`sim:realtime`）の設定は、env を散らす代わりに 1 つの YAML（`config/local.yaml`）で管理する。run ノブ（`run` / `funding` / `limits` / `flow` / `stress` のネストセクション）と agent ロスター（`agents`）を 1 ファイルに書ける。解決順は `--config <path>` > `ERIS_CONFIG` > `config/local.yaml` > `config/example.yaml`（committed 雛形 = zero-config 既定）。

```bash
cp config/example.yaml config/local.yaml
npm run sim:realtime                                   # 既定で config/local.yaml を読む
npm run sim:realtime -- --config config/claude-llm.yaml   # 別ファイルを指定
```

- キーは**ネスト lowercase**（`run.protocols` / `funding.wethWei` / `flow.uninformedMaxWethWei` 等）。値は型付き（真偽値・数値・配列・オブジェクト）。未指定キーは既定値。未知キーは警告。
- **秘密情報は YAML に書かない**。RPC URL・秘密鍵・API キーは `.env.local` に置く（`ARB_RPC_URL` / `*_PRIVATE_KEY` / `ANTHROPIC_API_KEY` / `OLLAMA_API_KEY`）。`config/local.yaml` は gitignore 対象、`config/example.yaml` がコミット済みの雛形。
- 一回限りの上書きは CLI フラグ（`--seed` / `--blocks` / `--protocols` / `--agents` 等）。各 agent の `env`（`ERIS_LLM_*` 等）は agent プロセスへ渡す戦略パラメータで `agents[].env` に書く。

`config/` の雛形: `example.yaml`（最小 3 venue ロスター）/ `claude-llm.yaml`（LLM エージェント）/ `all18-mixed.yaml`（混成大規模ロスター）。

## 主なセクション

| セクション | 役割 | 例 |
|---|---|---|
| `run` | run ノブ（SEED・ブロック数・実時間上限・有効 venue・モード） | `protocols: [uniswap, balancer, curve]` |
| `funding` | 初期配布（USDC-only 配布で初期の方向性エクスポージャを排除できる） | `wethWei: "0"` |
| `limits` | agent の per-round 上限 | `agentWethWei: "1000000000000000000"` |
| `flow` | orderflow bot の強度（市場を動かす量） | `uninformedMaxWethWei: "1000000000000000000"` |
| `stress` | 市場ストレスイベント（既定 off） | [stress-events.md](stress-events.md) |
| `agents` | エージェントロスター（旧 `agents.*.json` の置き換え。inline で書ける） | 下記 |

```yaml
agents:
  - id: venue-arb
    command: node
    args: [--import, tsx, examples/agents/venue-arb.ts]
    wallet: AGENT2_PRIVATE_KEY
    description: WETH 専用 cross-venue 裁定
```

> ローカルデプロイのアカウント 0（account0）は deployer のデプロイアカウントと重なり残留残高で価値が歪むため、ロスターは AGENT1 以降（account1+）を使う。

## CLI での一回上書き

YAML を編集せず、run ごとに値を上書きできる（CLI フラグが最優先。`--key value` / `--key=value` 両対応）:

| フラグ | config キー | 例 |
|---|---|---|
| `--config <path>` | （設定ファイル選択） | `--config config/claude-llm.yaml` |
| `--seed` | `run.seed` | `--seed 7` |
| `--blocks` | `run.blocks` | `--blocks 40` |
| `--seconds` | `run.seconds` | `--seconds 120` |
| `--protocols` | `run.protocols` | `--protocols uniswap,balancer,curve` |
| `--agents` | `run.agentsConfig` | `--agents agents.local.json` |
| `--local-deploy` | `run.localDeploy` | `--local-deploy` |
| `--economic-gas` | `run.economicGas` | `--economic-gas` |

## agents[] の項目

| キー | 必須 | 説明 |
|---|---|---|
| `id` | ✓ | agent の識別子（ログ出力先 `runs/<id>/agents/<id>.jsonl` に使う） |
| `command` / `args` | ✓ | spawn するプロセス（例 `command: node` / `args: [--import, tsx, examples/agents/venue-arb.ts]`） |
| `wallet` | ✓ | 秘密鍵を渡す env 変数名（`AGENT1_PRIVATE_KEY` 等。`.env.local` に置く。ローカルは未設定でも Anvil dev キーにフォールバック） |
| `baseline` | | `true` で実力ゼロの基準ライン（noop / random）として扱う |
| `description` | | 人間用の説明 |
| `env` | | agent プロセスへ渡す戦略パラメータ（`ERIS_LLM_*` 等）。sim 設定キーとは別物。詳細は [LLM 駆動の自律エージェント](llm-agents.md) |
