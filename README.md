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

## Run

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
npm run sim
```

Outputs are written under `runs/<run_id>/`.
