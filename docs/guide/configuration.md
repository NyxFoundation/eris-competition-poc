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
