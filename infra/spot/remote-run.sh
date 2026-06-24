#!/usr/bin/env bash
# =============================================================================
# eris spot runner — box 上で SSH 経由 detached 実行されるブートストラップ
# =============================================================================
# run-spot.sh が ~/eris/ にコードを送り込み、これを `setsid bash remote-run.sh`
# で detached 起動して run.log に流す。S3/SSM は使わず、入力は env と
# ~/eris/.ollama_key のみ。終了時に必ず ~/eris/EXIT_CODE を書く（laptop が
# これを見て回収・terminate に動く）。
#
# 受け取る env: RUN_CMD_B64（必須・base64 の実行コマンド） / ERIS_LLM_MODEL
# =============================================================================
set -uo pipefail

ERIS="$HOME/eris"
trap 'echo $? > "$ERIS/EXIT_CODE"' EXIT
export PATH="$HOME/.foundry/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

RUN_CMD="$(echo "${RUN_CMD_B64:?RUN_CMD_B64 未設定}" | base64 -d)"
export OLLAMA_API_KEY="$(cat "$ERIS/.ollama_key" 2>/dev/null || true)"
export ERIS_LLM_MODEL="${ERIS_LLM_MODEL:-gpt-oss:120b}"

# ---- 資源サンプラ（mem/cpu/load を 3s 毎に記録。run-spot が collect する） ----
# load1 / nproc で CPU 利用率、mem used/total でメモリ消費を時系列で残す。
# box と一緒に死ぬ。RUN フェーズは run.log の "RUN 開始" タイムスタンプと突き合わせる。
echo "host: nproc=$(nproc) mem_total_MB=$(free -m | awk '/Mem:/{print $2}')" > "$ERIS/resources.log"
( while true; do
    printf '%s load1=%s ' "$(date -u +%H:%M:%S)" "$(cut -d' ' -f1 /proc/loadavg)"
    free -m | awk '/Mem:/{printf "mem_used_MB=%d (%d%%)\n",$3,$3*100/$2}'
    sleep 3
  done >> "$ERIS/resources.log" 2>&1 ) &

# ---- 1) ツールチェーン -------------------------------------------------------
log "apt 依存を導入"
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends git curl unzip ca-certificates build-essential

log "Node 23 + yarn を導入"
curl -fsSL https://deb.nodesource.com/setup_23.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g yarn >/dev/null 2>&1

log "Foundry(anvil/forge) を導入"
curl -L https://foundry.paradigm.xyz | bash
"$HOME/.foundry/bin/foundryup"

# ---- 2) npm ci（deployer ルート + poc。aave/gmx は nested vendor も要る） -----
log "npm ci (deployer)"; ( cd "$ERIS/deployer" && npm ci )
log "npm ci (poc)";      ( cd "$ERIS/poc" && npm ci )
# deploy 対象（ERIS_DEPLOY_ONLY 未指定なら全 venue）。aave/gmx は vendor/* の
# hardhat-deploy プロジェクトに依存するので、対象に含む時だけ nested npm ci する。
DEPLOY_ONLY="${ERIS_DEPLOY_ONLY:-uniswap,balancer,curve,aave,gmx}"
case "$DEPLOY_ONLY" in
  *aave*) [ -f "$ERIS/deployer/vendor/aave/package.json" ] && {
    log "npm ci (vendor/aave)"; ( cd "$ERIS/deployer/vendor/aave" && npm ci ) || log "vendor/aave npm ci 失敗"; } ;;
esac
case "$DEPLOY_ONLY" in
  *gmx*) [ -f "$ERIS/deployer/vendor/gmx-src/package.json" ] && {
    log "yarn install (vendor/gmx-src)"; ( cd "$ERIS/deployer/vendor/gmx-src" && yarn install --frozen-lockfile ) || log "vendor/gmx-src yarn install 失敗"; } ;;
esac

# ---- 3) deployer: anvil + protocol デプロイ ---------------------------------
# --keep-fresh で deployments.json を初期化（tarball 同梱の古い json による
# readiness 誤判定を防ぐ）。deploy は成功時 anvil を保持し続ける（src/index.ts）。
DJSON="$ERIS/deployer/deployments/deployments.json"
log "deployer: npm run deploy --keep-fresh --only $DEPLOY_ONLY（anvil 起動＋デプロイ）"
( cd "$ERIS/deployer" && npm run deploy -- --keep-fresh --only "$DEPLOY_ONLY" ) > "$ERIS/deploy.log" 2>&1 &
DEPLOY_PID=$!

# --keep-fresh は deployments.json を開始時に初期化(=即ファイル生成)するため
# 「ファイル存在」では完了判定にならない（全 venue deploy 前に run が走る競合）。
# deploy 完了は index.ts が最後に出す完了マーカーで判定する。
DONE_RE="anvil は起動したまま|deployments.json 出力"
log "deploy 完了待ち（完了マーカー or プロセス死亡）"
for i in $(seq 1 1200); do
  grep -qE "$DONE_RE" "$ERIS/deploy.log" 2>/dev/null && { log "deploy 完了"; break; }
  if ! kill -0 "$DEPLOY_PID" 2>/dev/null; then
    log "ERROR: deploy が完了前に終了（下に deploy.log 末尾）"
    tail -40 "$ERIS/deploy.log"
    exit 1
  fi
  sleep 1
done
grep -qE "$DONE_RE" "$ERIS/deploy.log" 2>/dev/null || { log "ERROR: deploy タイムアウト"; tail -40 "$ERIS/deploy.log"; exit 1; }

# ---- 4) poc: ローカル定数を deployment に同期して run ------------------------
cd "$ERIS/poc"
log "constants.local を deployment に再生成"
DEPLOYMENTS_JSON="$ERIS/deployer/deployments/deployments.json" npm run gen:local-constants \
  || log "gen:local-constants 失敗（コミット済 constants.local を使用）"

export ERIS_LOCAL_DEPLOY=1
export ERIS_LLM_AUTH=ollama

log "==== RUN 開始 ===="
log "cmd: $RUN_CMD"
bash -lc "$RUN_CMD"
RUN_RC=$?
log "==== RUN 終了 rc=$RUN_RC ===="
exit $RUN_RC
