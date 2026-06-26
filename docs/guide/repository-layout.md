[← README](../../README.md)

# リポジトリ構成

```
src/
  cli/              CLI エントリ（anvil / sim-realtime / checkOrdering）
  realtime/         環境デーモン: coordinator / priceFeed / events / reconstruct / agentProcess / flowProcess
  protocols/        プロトコルアダプタ（uniswap / balancer / curve / aave / gmx + registry / deploy / oracles）
  flow/             orderflow bot のロジック（純粋関数。決定論的な市場機構）
  llm/              LLM バックエンド（cli / codex / ollama / subscription / apikey）+ 戦略・履歴・帰属
  runConfig.ts      YAML 設定スキーマ（ネスト lowercase → 内部キー）
  postRunCheck.ts   事後ルール検査（fee 上限超過 → violations）
  constants*.ts     venue アドレス（fork: constants.ts / local: constants.local.ts）
contracts/          PriceFeed + モックオラクル（MockAggregator / MockOracleProvider）+ FlashArb（Foundry）
deployer/           同梱の deploy オーケストレータ（空の anvil へ全 5 venue を deploy する自己完結サブパッケージ）
examples/agents/    サンプル戦略（arb / lp / aave / gmx …）+ LLM エージェント（claude-llm.ts）
examples/flow/      flow bot（market-maker）
config/             YAML 設定（example / claude-llm / all18-mixed）
docs/guide/         利用ガイド（本ディレクトリ）
docs/adr/           アーキテクチャ意思決定記録（ADR 0001–0013）
scripts/            constants 生成（gen:local-constants）/ 戦略静的検査（check:strategy）
runs/               run 出力（summary.json / events.jsonl / blocks.csv / agents/<id>.jsonl）
```
