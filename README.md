# Eris Competition MVP

Local multi-protocol DeFi strategy simulation on an Anvil **Arbitrum One** fork. Agents do not receive RPC access, private keys, pending transactions, or txpool data. The coordinator gives each agent only confirmed-state observations and converts accepted JSON actions into transactions.

Supported protocols are pluggable via a protocol adapter registry (`src/protocols/`): **Uniswap V3, Balancer v2, Curve, Aave v3, and GMX v2**. Select active protocols per run with `ENABLED_PROTOCOLS` (comma-separated, e.g. `ENABLED_PROTOCOLS=uniswap,balancer,curve,aave,gmx`). Aave v3 and GMX v2 prices are driven by controllable mock oracles that the coordinator updates each round to track an exogenous fair price.

## Protocols & actions

Each adapter (`src/protocols/<name>.ts`) implements parsing/validation, calldata building, observation, orderflow, and PnL. Agent JSON actions:

| Protocol | Actions | Venue (Arbitrum) |
|---|---|---|
| Uniswap V3 | `swap`, `mintLiquidity`, `removeLiquidity`, `collectFees` | WETH/USDC 0.05% pool |
| Balancer v2 | `balancerSwap` | 33/33/34 WETH/USDC/USDT weighted pool (seeded on fork) |
| Curve | `curveSwap` | tricrypto WETH↔USDT |
| Aave v3 | `aaveSupply`, `aaveWithdraw`, `aaveBorrow`, `aaveRepay` | native USDC / WETH reserves |
| GMX v2 | `gmxIncrease`, `gmxDecrease` | ETH/USD perp market |

Plus protocol-agnostic `noop`, `bundle` (multiple bundleable leaf actions in one tx), `rawTx`, and `rawBundle`.

### Stablecoin accounting

Deep WETH/stable liquidity on Arbitrum lives in USDC.e / USDT pools, so native USDC, USDC.e, and USDT are all treated as `$1`, 6-decimal **USDC-equivalent** in balances and PnL (`src/chain.ts` `setActiveStables`/`getBalances`). Uniswap/Aave/GMX use native USDC; Balancer uses native USDC (its pool is seeded on the fork); Curve uses USDT.

### Oracle control (Aave v3 / GMX v2)

Mock oracle contracts (`contracts/MockAggregator.sol`, `contracts/MockOracleProvider.sol`) are deployed to the fork during setup. For Aave the coordinator impersonates the ACL admin to point `AaveOracle` at the mock aggregator; for GMX it impersonates `ROLE_ADMIN` to grant keeper/controller roles and registers the mock provider in the `DataStore`. Each round, `updateOracles` writes the fair price into both mocks so lending health factors and perp mark prices move.

### GMX round structure

GMX is asynchronous (create order → keeper executes). Each round runs three sub-blocks: (1) an **oracle block** updating mock prices, (2) the **competitive block** where agent/flow orders compete by priority fee (`--order fees`), and (3) a **keeper block** where the coordinator reads `OrderCreated` logs from the competitive block and executes each order. GMX position changes become visible to agents one round later. GMX actions are standalone only (not bundleable).

## Setup

```bash
npm install
cp .env.example .env.local
cp agents.local.example.json agents.local.json
```

Fill `ARB_RPC_URL` (an Arbitrum One RPC endpoint) in `.env.local`. `FORK_BLOCK_NUMBER` is optional (defaults to the RPC's latest block).
Load it before running commands, or export the same variables in your shell.

Recommended local defaults:

```bash
ANVIL_PORT=8545
ANVIL_RPC_URL=http://127.0.0.1:8545
CHAIN_ID=42161
ROUNDS=1
ENABLED_PROTOCOLS=uniswap
AGENTS_CONFIG=agents.local.json
REPORT_DIR=./runs
```

Build the mock oracle contracts (required when Aave v3 / GMX v2 are enabled; needs Foundry). `npm run sim` runs this automatically via the `presim` hook:

```bash
npm run build:contracts
```

Private key variables can be left empty for local Anvil runs; the coordinator falls back to Anvil's default dev keys. The coordinator also derives dedicated `admin` (deploys mocks, holds GMX `CONTROLLER` / Aave `POOL_ADMIN`) and `keeper` (GMX order keeper) accounts; override with `ADMIN_PRIVATE_KEY` / `KEEPER_PRIVATE_KEY`.

## Smoke Test

In one terminal:

```bash
set -a
source .env.local
set +a
npm run anvil
```

In another terminal:

```bash
set -a
source .env.local
set +a
export ROUNDS=1 ENABLED_PROTOCOLS=uniswap
npm run sim
```

Outputs are written under `runs/<run_id>/`.

Expected smoke-test coverage:

- Wallet setup completes for all agents and flow wallets.
- WETH deposit, token approvals, and the initial WETH -> USDC swap complete.
- One round submits flow transactions and any valid agent transactions.
- `anvil_mine` produces receipts for submitted transactions.
- `events.jsonl`, `blocks.csv`, `summary.json`, and `history.json` are written under the run directory.

## Output Checks

Review `summary.json` for each agent's final balances, net PnL, gas usage, revert count, and submitted/included transaction counts.

Review `blocks.csv` to confirm Anvil's fee ordering:

```bash
npm run check:ordering -- runs/<run_id>
```

Review `events.jsonl` for `tx_submit_failed`, `tx_receipt_failed`, `action_rejected`, `revert`, or `timeout` events. Transaction-level submit and receipt failures are logged and skipped so one bad transaction does not stop the full run.

## Full Run

After the smoke test passes, run a multi-protocol simulation. `agents.multi.json` ships agents across venues (cross-venue arb, Aave leverage, GMX long, Uniswap fee bidder):

```bash
set -a
source .env.local
set +a
export ROUNDS=20 ENABLED_PROTOCOLS=uniswap,balancer,curve,aave,gmx AGENTS_CONFIG=agents.multi.json
npm run sim
```

`summary.json` reports per-agent `protocolValuesUsdc` (Uniswap LP value, GMX position equity, Aave net collateral−debt) plus the base wallet value, summed into `finalValueUsdc` / `netPnlUsdc`. Note that GMX/Aave runs use ~3 blocks per round; only the competitive block carries the fee-ordered agent/flow swaps that `check:ordering` validates.

Example single-protocol configs: `agents.aave-test.json`, `agents.gmx-test.json`.

## ローカルリアルタイムシミュレーション（非fork）

Arbitrum を fork せず、隣接 repo `eris-app-deployer` がローカル anvil 上に全 protocol を deploy したものに poc が接続して realtime run を回すモード。fork backend への cold state RPC 往復（fork RPC レイテンシ）を避けられ、マルチアセット（WETH/WBTC）も動く。`sim:realtime`（ADR 0005 の実時間 run）を fork 無しで実行する。

### 前提

- 隣接 repo `../eris-app-deployer`（branch `feat/shared-tokens-gmx-aave`）が必要。
- poc 側は anvil を起動しない（deployer が anvil を所有する）。`ERIS_LOCAL_DEPLOY=1` のとき `npm run anvil` は fail-fast する。

### 手順

1. **deployer で anvil 起動 + 全 venue deploy**（別ターミナル推奨）:

   ```bash
   cd ../eris-app-deployer
   npm run deploy -- --keep-fresh
   ```

   - `--keep-fresh` は `deployments.json` を初期化してから deploy する。
   - `--exit` を**付けない**こと。付けると deploy 後に anvil を停止してしまう。付けなければ anvil は起動したまま `127.0.0.1:8545` で待機する。
   - 全 5 venue（Uniswap V3 / Balancer V2 / Aave V3 / Curve / GMX V2）＋共有トークン（WETH/USDC/USDT/DAI/WBTC）＋ Multicall3 を deploy する。完了まで数分（GMX が最も重い）。
   - 完了すると `../eris-app-deployer/deployments/deployments.json` が出力され、「anvil は起動したままです」と表示される。

2. **poc で `constants.local` を生成**（deploy アドレスを poc に取り込む）:

   ```bash
   npm run gen:local-constants
   ```

   `../eris-app-deployer/deployments/deployments.json` を読んで `src/constants.local.ts` を生成する（`DEPLOYMENTS_JSON` env でパス上書き可）。deploy は決定論アドレスなので、再生成しても差分は出ないことが多い。

3. **リアルタイム run を実行**（`ERIS_LOCAL_DEPLOY=1` で `127.0.0.1:8545` のローカルデプロイに接続）:

   ```bash
   ERIS_LOCAL_DEPLOY=1 \
   AGENTS_CONFIG=agents.local.json \
   SEED=1 \
   ERIS_RUN_BLOCKS=24 \
   ERIS_RUN_SECONDS=70 \
   ENABLED_PROTOCOLS=uniswap,balancer,curve \
   INITIAL_WETH_WEI=0 \
   npm run sim:realtime
   ```

### 主要な env

| 変数 | 説明 |
|---|---|
| `ERIS_LOCAL_DEPLOY=1` | ローカルデプロイ（非fork）モードを有効化。**必須** |
| `AGENTS_CONFIG` | エージェントロスター JSON。`agents.local.json`（noop / random / simple の 3 体）や `agents.multi-asset.json`（noop / venue-arb / multi-arb） |
| `SEED` | 市場条件のラベル（価格パス再現用） |
| `ERIS_RUN_BLOCKS` | run 長（ブロック数） |
| `ERIS_RUN_SECONDS` | 実時間の上限（非stress run はこれで終了する。24 ブロック ≒ 48 秒なので 70 程度を確保） |
| `ENABLED_PROTOCOLS` | 有効 venue（カンマ区切り。例 `uniswap,balancer,curve`） |
| `INITIAL_WETH_WEI=0` | USDC-only 配布（初期 β を消すユーザー方針） |
| `FLOW_MAX_WBTC_SATS=50000000` | マルチアセット（WBTC）を取引させる場合に指定。WBTC の AMM flow を有効化して WBTC の価格乖離＝裁定機会を作る（既定 0 で WBTC flow off） |

> **注**: ローカルデプロイのアカウント 0（account0）は deployer のデプロイアカウントと重なり、残留残高で価値が歪む。ロスターは AGENT1 以降（account1+）を使うこと（`agents.local.json` / `agents.multi-asset.json` はそうなっている）。

### 出力

run ごとに `runs/<timestamp>/` が生成される:

- `summary.json` — agent ごとの initial/final value・netPnl・includedTxCount・revertCount、`valueSeries.failedReads`、`violations`。
- `agents/<id>.jsonl` — 各 agent の自己申告ログ（direct モードでは mempool 活動 `kind:"mempool"`: submitted / submit_failed / rejected。WBTC 等の market 取引は `base` フィールドで判別できる）。
- `events.jsonl` / `blocks.csv` — イベント列とブロックごとの tx 記録。

### 検証例

`agents.multi-asset.json` ＋ `FLOW_MAX_WBTC_SATS=50000000` の 24 ブロック run で、base 非依存の `multi-arb` が WBTC を 20 件 on-chain 約定（revert 0）、`failedReads: 0`・`violations: []`。WETH 専用の `venue-arb` は WBTC 機会を取れず 0 取引。

### トラブルシュート

- **接続できない**: deployer の `npm run deploy -- --keep-fresh` が起動中か（`--exit` を付けていないか）確認する。
- **アドレス不一致 / コントラクトが無い**: deploy 後に `npm run gen:local-constants` を再実行したか確認する。
- **run が価格窓に到達せず早期終了する**: `ERIS_RUN_SECONDS` を十分大きくする。

## LLM-driven autonomous agent

`examples/agents/claude-llm.ts` is an agent whose strategy is generated and revised by an LLM at runtime. There is no hand-written trading logic — the model writes both the natural-language plan and a TypeScript executor function that runs each round in a `vm.Script` sandbox.

### Architecture
- **Slow tier (LLM API/CLI)**: called once at startup to design an initial strategy, then again every `ERIS_LLM_REVIEW_EVERY` rounds (default 10) or when realized PnL drops below `1 - ERIS_LLM_DRAWDOWN_RATIO` of starting USD (default 5%). Calls run in the background and never block the round response.
- **Fast tier (vm.Script)**: each round, the current executor body is evaluated against the observation with a 200 ms timeout. If the strategy is not yet ready (first ~10 sec while init is in flight) or the executor throws / returns an invalid action, the agent emits `noop` for that round and continues.
- Strategies are written to `runs/<run_id>/agent-<id>/strategy-vN.{md,params.json,executor.ts}` so you can read what Claude is thinking. Per-round decisions and API call telemetry land in `decisions.jsonl` and `claude-calls.jsonl` in the same directory.

### Backends

`ERIS_LLM_AUTH` selects which transport to use. `auto` (the default) picks the best available, never crashes on missing credentials.

| Mode | Auth | Use when |
|---|---|---|
| `cli` | Claude Pro/Max OAuth via `claude -p` | Local subscription runs with the most reliable Claude Code path |
| `codex` | Codex CLI auth via `codex exec` | Parallel self-improvement on a separate API pool |
| `ollama` | `OLLAMA_API_KEY` or `ERIS_OLLAMA_API_KEY` | Direct Ollama Cloud API calls to `https://ollama.com/api/chat` |
| `subscription` | Claude Pro/Max OAuth (via Claude Code CLI) | You already have `claude` installed and logged in — zero per-token cost |
| `apikey` | `ANTHROPIC_API_KEY` | CI, parallel sim runs, or when you want exact per-call billing |
| `mock` | none | Offline smoke tests — always returns a noop strategy |
| `auto` *(default)* | tries `cli` → `apikey` → `ollama` → `mock` | Local dev where available credentials vary |

### Run it (subscription, no API key)

```bash
# Make sure you've logged in once: `claude auth login` (uses your Pro/Max plan)
set -a
source .env.local
set +a
AGENTS_CONFIG=agents.claude-llm.json npm run sim
```

`auto` will detect the `claude` binary on PATH and route through the Claude Agent SDK. You'll see `[claude-llm] strategist=subscription (auto-detected Claude Code OAuth)` on stderr.

### Run it (API key)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
AGENTS_CONFIG=agents.claude-llm.json ERIS_LLM_AUTH=apikey npm run sim
```

`AGENT_TIMEOUT_MS` only matters if you want headroom — the LLM call is async and never holds up `requestAction`, so the default 5000 ms is fine in practice.

### Run it (Ollama Cloud API)

Use Ollama's direct Cloud API endpoint, not a local `localhost:11434` server. Direct Cloud API model names are the normal model ids, for example `gpt-oss:120b` rather than a local `-cloud` alias.

```bash
export OLLAMA_API_KEY=ollama-...
AGENTS_CONFIG=agents.claude-llm.json \
  ERIS_LLM_AUTH=ollama \
  ERIS_LLM_MODEL=gpt-oss:120b \
  npm run sim
```

Optional overrides:

```bash
export ERIS_OLLAMA_BASE_URL=https://ollama.com/api
export ERIS_OLLAMA_MODEL=gpt-oss:120b
export ERIS_OLLAMA_MAX_RETRIES=3
```

### Offline mock

Set `ERIS_LLM_MOCK=1` (or `ERIS_LLM_AUTH=mock`) to skip Claude entirely and use a hard-coded noop strategy. Useful for smoke-testing the harness without spending tokens or having any auth:

```bash
AGENTS_CONFIG=agents.claude-llm.json ERIS_LLM_MOCK=1 npm run sim
```

### Tuning

Environment variables (set in the parent shell — `agentProcess.ts` forwards `ANTHROPIC_API_KEY` and any `ERIS_LLM_*` var to the child):

| Variable | Default | Effect |
|---|---|---|
| `ERIS_LLM_AUTH` | `auto` | `cli` \| `codex` \| `ollama` \| `subscription` \| `apikey` \| `mock` \| `auto` — see backend table above |
| `ERIS_LLM_MODEL` | backend-specific | Model alias or id. Ollama default is `gpt-oss:120b` |
| `OLLAMA_API_KEY` / `ERIS_OLLAMA_API_KEY` | unset | Bearer token for `ERIS_LLM_AUTH=ollama` |
| `ERIS_OLLAMA_BASE_URL` | `https://ollama.com/api` | Direct Ollama Cloud API base URL |
| `ERIS_OLLAMA_MAX_RETRIES` | `3` | Retries for Ollama `429` and transient `5xx` responses |
| `ERIS_LLM_REVIEW_EVERY` | `10` | Scheduled revision cadence in rounds |
| `ERIS_LLM_DRAWDOWN_RATIO` | `0.05` | Fractional PnL drop that triggers an off-schedule revision |
| `ERIS_LLM_HISTORY_CAPACITY` | `30` | How many recent rounds to keep in the revision prompt |
| `ERIS_LLM_EXECUTOR_TIMEOUT_MS` | `200` | Hard cap on per-round executor execution |
| `ERIS_LLM_MOCK` | unset | If `1`, force the offline mock strategy (alias for `ERIS_LLM_AUTH=mock`) |

Cost / latency comparison per call:

| Backend | Wall time | Per-call cost | Cache | Rate limit |
|---|---|---|---|---|
| `apikey` | ~1–2s | ~$0.05 per 128-round run | ephemeral on `SIM_RULES` block | API tier |
| `subscription` | ~4–8s (CLI cold start + harness prompt) | $0 — subscription absorbs | per-process; long-lived `query` not yet wired | Max weekly / 5h caps |
| `ollama` | model/API dependent | Ollama Cloud account billing | none | Ollama Cloud limits |
| `mock` | <1ms | $0 | n/a | n/a |

Subscription mode is best for local dev and ad-hoc runs; switch to `apikey` for unattended / parallel / CI runs that risk hitting Max weekly caps.
