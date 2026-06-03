# Eris Competition MVP

Local DEX strategy simulation on an Anvil mainnet fork. Agents do not receive RPC access, private keys, pending transactions, or txpool data. The coordinator gives each agent only confirmed-state observations and converts accepted JSON actions into transactions.

## Setup

```bash
npm install
cp .env.example .env.local
cp agents.local.example.json agents.local.json
```

Fill `MAINNET_RPC_URL` and `FORK_BLOCK_NUMBER` in `.env.local`.
Load it before running commands, or export the same variables in your shell.

Recommended local defaults:

```bash
ANVIL_PORT=8545
ANVIL_RPC_URL=http://127.0.0.1:8545
CHAIN_ID=31337
ROUNDS=1
AGENTS_CONFIG=agents.local.json
REPORT_DIR=./runs
```

Private key variables can be left empty for local Anvil runs; the coordinator falls back to Anvil's default dev keys.

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
export ROUNDS=1
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

After the smoke test passes, run the configured longer simulation:

```bash
set -a
source .env.local
set +a
npm run sim
```

## LLM-driven autonomous agent

`examples/agents/claude-llm.ts` is an agent whose strategy is generated and revised by Claude Sonnet 4.6 at runtime. There is no hand-written trading logic — Claude writes both the natural-language plan and a TypeScript executor function that runs each round in a `vm.Script` sandbox.

### Architecture
- **Slow tier (Claude API)**: called once at startup to design an initial strategy, then again every `ERIS_LLM_REVIEW_EVERY` rounds (default 10) or when realized PnL drops below `1 - ERIS_LLM_DRAWDOWN_RATIO` of starting USD (default 5%). Calls run in the background and never block the round response.
- **Fast tier (vm.Script)**: each round, the current executor body is evaluated against the observation with a 200 ms timeout. If the strategy is not yet ready (first ~10 sec while init is in flight) or the executor throws / returns an invalid action, the agent emits `noop` for that round and continues.
- Strategies are written to `runs/<run_id>/agent-<id>/strategy-vN.{md,params.json,executor.ts}` so you can read what Claude is thinking. Per-round decisions and API call telemetry land in `decisions.jsonl` and `claude-calls.jsonl` in the same directory.

### Three backends

`ERIS_LLM_AUTH` selects which Claude transport to use. `auto` (the default) picks the best available, never crashes on missing credentials.

| Mode | Auth | Use when |
|---|---|---|
| `subscription` | Claude Pro/Max OAuth (via Claude Code CLI) | You already have `claude` installed and logged in — zero per-token cost |
| `apikey` | `ANTHROPIC_API_KEY` | CI, parallel sim runs, or when you want exact per-call billing |
| `mock` | none | Offline smoke tests — always returns a noop strategy |
| `auto` *(default)* | tries subscription → apikey → mock | Local dev where Claude Code is installed |

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

### Offline mock

Set `ERIS_LLM_MOCK=1` (or `ERIS_LLM_AUTH=mock`) to skip Claude entirely and use a hard-coded noop strategy. Useful for smoke-testing the harness without spending tokens or having any auth:

```bash
AGENTS_CONFIG=agents.claude-llm.json ERIS_LLM_MOCK=1 npm run sim
```

### Tuning

Environment variables (set in the parent shell — `agentProcess.ts` forwards `ANTHROPIC_API_KEY` and any `ERIS_LLM_*` var to the child):

| Variable | Default | Effect |
|---|---|---|
| `ERIS_LLM_AUTH` | `auto` | `subscription` \| `apikey` \| `mock` \| `auto` — see backend table above |
| `ERIS_LLM_MODEL` | `sonnet` (subscription) / `claude-sonnet-4-6` (apikey) | Claude model alias or id |
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
| `mock` | <1ms | $0 | n/a | n/a |

Subscription mode is best for local dev and ad-hoc runs; switch to `apikey` for unattended / parallel / CI runs that risk hitting Max weekly caps.
