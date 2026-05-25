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
