#!/usr/bin/env bash
# =============================================================================
# eris golden AMI — build インスタンス上で走るベイク処理
# =============================================================================
# bake-ami.sh が ~/eris に poc/deployer を送り込み、これを実行する。
#   toolchain 導入 → npm ci(deployer+vendor+poc) → anvil(--state) 起動 →
#   full deploy を成功までリトライ → gen:local-constants → anvil 正常停止で
#   state dump → AMI を軽くするため deployer の重い node_modules を削除。
# 完了マーカー ~/eris/BAKE_OK を書く（bake-ami.sh が待つ）。
# =============================================================================
set -uo pipefail

ERIS="$HOME/eris"
STATE_DIR="$ERIS/state"; STATE_FILE="$STATE_DIR/anvil-state.json"
DJSON="$ERIS/deployer/deployments/deployments.json"
export PATH="$HOME/.foundry/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
rm -f "$ERIS/BAKE_OK"
mkdir -p "$STATE_DIR"

ANVIL_FLAGS=(--port 8545 --code-size-limit 50000 --base-fee 0 --gas-limit 3000000000 --accounts 10 --balance 1000000)
anvil_ready() {
  for i in $(seq 1 60); do
    curl -s -X POST http://127.0.0.1:8545 -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | grep -q result && return 0
    sleep 1
  done; return 1
}

# ---- 1) toolchain -----------------------------------------------------------
log "apt 依存"
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends git curl unzip ca-certificates build-essential rsync
log "Node 23 + yarn"; curl -fsSL https://deb.nodesource.com/setup_23.x | sudo -E bash -; sudo apt-get install -y nodejs; sudo npm install -g yarn >/dev/null 2>&1
log "Foundry"; curl -L https://foundry.paradigm.xyz | bash; "$HOME/.foundry/bin/foundryup"

# ---- 2) npm ci（deployer root + vendor + poc） ------------------------------
log "npm ci deployer";       ( cd "$ERIS/deployer" && npm ci )
[ -f "$ERIS/deployer/vendor/aave/package.json" ]    && { log "npm ci vendor/aave";    ( cd "$ERIS/deployer/vendor/aave" && npm ci ); }
# gmx-src は yarn プロジェクト(yarn.lock のみ・package-lock 無し)。npm ci は失敗するので
# yarn install を使う。ts-node/typescript は devDeps にあり hardhat.config.ts に必須。
[ -f "$ERIS/deployer/vendor/gmx-src/package.json" ] && { log "yarn install vendor/gmx-src"; ( cd "$ERIS/deployer/vendor/gmx-src" && yarn install --frozen-lockfile ); }
log "npm ci poc";           ( cd "$ERIS/poc" && npm ci )

# ---- 3) full deploy（フレッシュ anvil で成功までリトライ） ------------------
DEPLOY_OK=0
for attempt in 1 2 3 4 5; do
  log "=== deploy 試行 $attempt（フレッシュ anvil） ==="
  rm -f "$STATE_FILE"                              # 前回の partial dump を破棄
  anvil "${ANVIL_FLAGS[@]}" --state "$STATE_FILE" > "$ERIS/anvil.log" 2>&1 &
  ANVIL_PID=$!
  if ! anvil_ready; then log "anvil 起動失敗"; kill -9 "$ANVIL_PID" 2>/dev/null; continue; fi
  if ( cd "$ERIS/deployer" && MANAGE_ANVIL=false npm run deploy -- --keep-fresh ) > "$ERIS/deploy.$attempt.log" 2>&1; then
    log "deploy 成功（試行 $attempt）"; DEPLOY_OK=1; break
  fi
  log "deploy 失敗（試行 $attempt）— 末尾:"; tail -15 "$ERIS/deploy.$attempt.log"
  kill -9 "$ANVIL_PID" 2>/dev/null    # SIGKILL=dump させず partial を破棄
  sleep 2
done
[ "$DEPLOY_OK" = 1 ] || { log "ERROR: deploy が全試行で失敗"; exit 1; }

# ---- 4) gen:local-constants（この deploy に一致する constants を生成） -------
log "gen:local-constants"
( cd "$ERIS/poc" && DEPLOYMENTS_JSON="$DJSON" npm run gen:local-constants ) || { log "ERROR: gen 失敗"; exit 1; }

# 注: 検証 run はここでは回さない。poc の run は evm_snapshot/revert で state を
# 変えるため、同じ anvil で回すと取引が dump に焼き込まれてしまう。deploy 直後の
# クリーンな state を dump し、end-to-end 検証は AMI の launch テストで行う。

# ---- 6) anvil 正常停止 → state dump -----------------------------------------
log "anvil 正常停止（state dump）"
kill -INT "$ANVIL_PID" 2>/dev/null
for i in $(seq 1 60); do
  [ -s "$STATE_FILE" ] && { s1=$(stat -c%s "$STATE_FILE"); sleep 2; s2=$(stat -c%s "$STATE_FILE"); [ "$s1" = "$s2" ] && break; }
  sleep 1
done
[ -s "$STATE_FILE" ] || { log "ERROR: state dump されず"; exit 1; }
log "state dump 完了: $(du -h "$STATE_FILE" | cut -f1)"

# ---- 7) AMI を軽量化 + シークレット除去 -------------------------------------
log "deployer の重い node_modules / vendor を削除（launch 時 load-state だけ要る）"
rm -rf "$ERIS/deployer/node_modules" "$ERIS/deployer/vendor"/*/node_modules \
       "$ERIS/deployer/vendor/gmx-src" 2>/dev/null || true
rm -f  "$ERIS/.ollama_key" "$ERIS/poc/.local-snapshot" 2>/dev/null || true
sudo rm -f /root/.ollama_key 2>/dev/null || true

date -u > "$ERIS/BAKED_AT"
echo ok > "$ERIS/BAKE_OK"
log "==== BAKE 完了 ===="
