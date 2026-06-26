[← README](../../README.md)

# LLM 駆動の自律エージェント

`examples/agents/claude-llm.ts` は、戦略を実行時に LLM が生成・改訂するエージェント。手書きのトレードロジックは無く、モデルが自然言語のプランと、毎ラウンド `vm.Script` サンドボックスで動く TypeScript の executor 関数の両方を書く。

## アーキテクチャ

- **遅い層（LLM API/CLI）**: 起動時に 1 度呼んで初期戦略を設計し、その後 `ERIS_LLM_REVIEW_EVERY` ラウンドごと（既定 10）、または実現 PnL が開始時 USD の `1 - ERIS_LLM_DRAWDOWN_RATIO`（既定 5%）を下回ったときに再度呼ぶ。呼び出しはバックグラウンドで走り、ラウンド応答をブロックしない。
- **速い層（vm.Script）**: 毎ラウンド、現在の executor 本体を観測に対して 200ms タイムアウトで評価する。戦略が未準備や executor が throw / 無効アクションを返した場合、そのラウンドは `noop` を出して継続する。
- 戦略は `runs/<run_id>/agent-<id>/strategy-vN.{md,params.json,executor.ts}` に書き出され、モデルの判断を読める。テレメトリは同ディレクトリの `decisions.jsonl` / `claude-calls.jsonl` に残る。

## バックエンド

`ERIS_LLM_AUTH` で利用するトランスポートを選ぶ。`auto`（既定）は利用可能な最良を選び、認証情報が無くてもクラッシュしない。

| モード | 認証 | 使う場面 |
|---|---|---|
| `cli` | Claude Pro/Max OAuth（`claude -p`） | ローカルのサブスクリプション run |
| `codex` | Codex CLI 認証（`codex exec`） | 別 API プールでの並列実行 |
| `ollama` | `OLLAMA_API_KEY` または `ERIS_OLLAMA_API_KEY` | Ollama Cloud API（`https://ollama.com/api/chat`）を直接呼ぶ |
| `subscription` | Claude Pro/Max OAuth（Claude Code CLI 経由） | `claude` をインストール済み・ログイン済み |
| `apikey` | `ANTHROPIC_API_KEY` | CI / 並列 sim run / 課金を明示したいとき |
| `mock` | なし | オフラインのスモークテスト（常に noop 戦略を返す） |
| `auto` *(既定)* | `cli` → `apikey` → `ollama` → `mock` を順に試す | 利用可能な認証が状況で変わるローカル開発 |

## 実行

バックエンド（`ERIS_LLM_AUTH`）とモデルは **config の agent `env` ブロックで設定する**。`config/claude-llm.yaml` は既定で Ollama Cloud（`ERIS_LLM_AUTH: ollama` / `ERIS_LLM_MODEL: gpt-oss:120b`）。秘密の API キーだけは `.env.local`（親シェル）に置く:

```bash
set -a; source .env.local; set +a   # OLLAMA_API_KEY 等の秘密のみ
npm run sim:realtime -- --config config/claude-llm.yaml
```

別バックエンドへの切替は **config の agent `env` で `ERIS_LLM_AUTH` を変える**（`agentProcess` は agent の `env` をシェル env より後勝ちで適用する）。認証もトークン消費も無しでハーネスだけスモークするには mock:

```bash
ERIS_LLM_MOCK=1 npm run sim:realtime -- --config config/claude-llm.yaml
```

## チューニング

LLM agent の調整は **config の `agents[].env` ブロック**に書く（sim 設定キーとは別）。秘密の API キー（`OLLAMA_API_KEY` / `ANTHROPIC_API_KEY`）だけは `.env.local` に置く。例:

```yaml
agents:
  - id: claude-llm
    command: node
    args: [--import, tsx, examples/agents/claude-llm.ts]
    wallet: AGENT1_PRIVATE_KEY
    env:
      ERIS_LLM_AUTH: ollama          # cli | codex | ollama | subscription | apikey | mock | auto
      ERIS_LLM_MODEL: gpt-oss:120b   # モデルのエイリアス / id（Ollama 既定 gpt-oss:120b）
      ERIS_OLLAMA_BASE_URL: https://ollama.com/api
      ERIS_LLM_REVIEW_EVERY: "10"    # 定期改訂の間隔（ラウンド数）
      ERIS_LLM_DRAWDOWN_RATIO: "0.05" # 臨時改訂をトリガーする PnL 下落率
      ERIS_LLM_HISTORY_CAPACITY: "30" # 改訂プロンプトに含める直近ラウンド数
      ERIS_LLM_EXECUTOR_TIMEOUT_MS: "200" # ラウンドあたり executor 実行のハードキャップ
```

`config/claude-llm.yaml` がこの形の雛形。
