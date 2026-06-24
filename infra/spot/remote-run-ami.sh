#!/usr/bin/env bash
# =============================================================================
# eris golden AMI — launch 時に走る run（install/deploy 無し）
# =============================================================================
# golden AMI（toolchain+deps+deployed anvil state を焼済）で起動した box で走る。
# anvil を baked state から load して全 venue を即復元 → poc を run するだけ。
# 受け取る env: RUN_CMD_B64（必須） / ERIS_LLM_MODEL
# =============================================================================
set -uo pipefail

ERIS="$HOME/eris"
STATE_FILE="$ERIS/state/anvil-state.json"
trap 'echo $? > "$ERIS/EXIT_CODE"' EXIT
export PATH="$HOME/.foundry/bin:$PATH"
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

RUN_CMD="$(echo "${RUN_CMD_B64:?RUN_CMD_B64 未設定}" | base64 -d)"
export OLLAMA_API_KEY="$(cat "$ERIS/.ollama_key" 2>/dev/null || true)"
export ERIS_LLM_MODEL="${ERIS_LLM_MODEL:-gpt-oss:120b}"

[ -s "$STATE_FILE" ] || { log "ERROR: baked state が無い: $STATE_FILE（AMI 不正）"; exit 1; }

# ---- 資源サンプラ ------------------------------------------------------------
echo "host: nproc=$(nproc) mem_total_MB=$(free -m | awk '/Mem:/{print $2}')" > "$ERIS/resources.log"
( while true; do
    printf '%s load1=%s ' "$(date -u +%H:%M:%S)" "$(cut -d' ' -f1 /proc/loadavg)"
    free -m | awk '/Mem:/{printf "mem_used_MB=%d (%d%%)\n",$3,$3*100/$2}'
    sleep 3
  done >> "$ERIS/resources.log" 2>&1 ) &

# ---- anvil 起動（baked state を load。全 venue 即復元） ----------------------
log "anvil 起動（--load-state）"
anvil --port 8545 --code-size-limit 50000 --base-fee 0 --gas-limit 3000000000 \
  --accounts 10 --balance 1000000 --load-state "$STATE_FILE" > "$ERIS/anvil.log" 2>&1 &
for i in $(seq 1 60); do
  curl -s -X POST http://127.0.0.1:8545 -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | grep -q result \
    && { log "anvil 応答 OK（state 復元済）"; break; }
  sleep 1
done

# ---- poc run -----------------------------------------------------------------
cd "$ERIS/poc"
rm -f .local-snapshot 2>/dev/null || true
export ERIS_LOCAL_DEPLOY=1
export ERIS_LLM_AUTH=ollama

log "==== RUN 開始 ===="
log "cmd: $RUN_CMD"
bash -lc "$RUN_CMD"
RC=$?
log "==== RUN 終了 rc=$RC ===="
exit $RC
