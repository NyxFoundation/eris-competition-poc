#!/usr/bin/env bash
# =============================================================================
# eris spot runner — 手元から 1 コマンドで spot EC2 に重い run を投げ、SSH で回収
# =============================================================================
# やること（S3 なし・全部 SSH）:
#   1) 現在 IP を security group に許可し、spot インスタンスを起動（watchdog 付き）
#   2) SSH 疎通待ち → poc/deployer の working tree を tar-over-ssh で送る
#   3) remote-run.sh を detached 起動し、run.log を live tail
#   4) 完了(EXIT_CODE) → runs/ を tar-over-ssh で ./runs-<id> へ回収
#   5) terminate（trap で異常・中断時も必ず terminate。--keep で残す）
#
# 前提: 一度だけ infra/spot/setup-once.sh（key pair + SG）を実行済み。
#       OLLAMA_API_KEY を env で渡すこと（box に SSH で送付。AWS には置かない）。
#
# 使い方（設定は CLI フラグ。env は退役。設定 YAML は committed の eris.config.example.yaml が既定）:
#   OLLAMA_API_KEY=ollama-xxxx infra/spot/run-spot.sh --watch -- \
#     'npm run discrimination -- --regimes base,bull --replications 5 --blocks 120 --agents agents.local.json'
#   infra/spot/run-spot.sh --type c7i.2xlarge --keep -- 'npm run evaluate -- --agents <config>'
# =============================================================================
set -euo pipefail

# ---- 設定（env で上書き可） --------------------------------------------------
REGION="${ERIS_SPOT_REGION:-us-west-2}"
# 容量切れに備え複数 type を順に試す（16 vCPU 級。--type / ERIS_SPOT_TYPE で上書き）
INSTANCE_TYPE="${ERIS_SPOT_TYPE:-c7i.4xlarge,m7i.4xlarge,c6i.4xlarge,m6i.4xlarge,c5.4xlarge,m5.4xlarge}"
DISK_GB="${ERIS_SPOT_DISK_GB:-40}"
WATCHDOG_MIN="${ERIS_SPOT_WATCHDOG_MIN:-240}"     # 何があっても N 分後に自動 terminate
KEY_NAME="${ERIS_SPOT_KEY:-eris-spot}"
KEY_PATH="${ERIS_SPOT_KEY_PATH:-$HOME/.ssh/eris-spot}"
SG_NAME="${ERIS_SPOT_SG_NAME:-eris-spot-ssh}"
OLLAMA_MODEL="${ERIS_LLM_MODEL:-gpt-oss:120b}"
DEPLOY_ONLY="${ERIS_DEPLOY_ONLY:-}"   # 空=全 venue。例: uniswap（smoke 高速化）
AMI_OVERRIDE="${ERIS_SPOT_AMI:-}"     # set → golden AMI モード（install/deploy/転送なし。bake-ami.sh で作る）
DEPLOYER_DIR="${ERIS_DEPLOYER_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../eris-app-deployer" 2>/dev/null && pwd || true)}"
export AWS_DEFAULT_REGION="$REGION"
# spot 用 AWS profile。このスクリプト(子プロセス)内だけに効く＝普段のシェルや
# デフォルト profile には影響しない。別 profile を使うなら ERIS_AWS_PROFILE で上書き。
export AWS_PROFILE="${ERIS_AWS_PROFILE:-eris}"

KEEP=0; WATCH=0; RUN_CMD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --watch) WATCH=1; shift ;;
    --keep)  KEEP=1; shift ;;
    --type)  INSTANCE_TYPE="$2"; shift 2 ;;
    --) shift; RUN_CMD="$*"; break ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$RUN_CMD" ] || { echo "ERROR: 実行コマンドを -- の後ろに渡してください" >&2; exit 2; }
[ -n "${OLLAMA_API_KEY:-}" ] || { echo "ERROR: OLLAMA_API_KEY を env で渡してください" >&2; exit 2; }
[ -f "$KEY_PATH" ] || { echo "ERROR: 秘密鍵が無い: $KEY_PATH（先に setup-once.sh）" >&2; exit 1; }
[ -d "$DEPLOYER_DIR" ] || { echo "ERROR: deployer が見つからない: $DEPLOYER_DIR（ERIS_DEPLOYER_DIR で指定）" >&2; exit 1; }

POC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="$(dirname "${BASH_SOURCE[0]}")"
RUN_ID="spot-$(date +%Y%m%d-%H%M%S)"
OUT_DIR="./runs-${RUN_ID}"
SSH_OPTS=(-i "$KEY_PATH" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=30)

echo "== eris spot run (SSH) =="
echo "  run-id   : $RUN_ID"
echo "  region   : $REGION   type: $INSTANCE_TYPE (spot)   disk: ${DISK_GB}GB   watchdog: ${WATCHDOG_MIN}m"
echo "  poc      : $POC_DIR"
echo "  deployer : $DEPLOYER_DIR"
echo "  cmd      : $RUN_CMD"

# ---- SG / IP / AMI -----------------------------------------------------------
SG_ID=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)
[ "$SG_ID" != "None" ] && [ -n "$SG_ID" ] || { echo "ERROR: SG $SG_NAME 無し（先に setup-once.sh）" >&2; exit 1; }
MYIP=$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
  --protocol tcp --port 22 --cidr "${MYIP}/32" >/dev/null 2>&1 || true   # IP 変動に追従
if [ -n "$AMI_OVERRIDE" ]; then
  if [ "$AMI_OVERRIDE" = latest ]; then   # 最新の golden AMI を自動解決
    AMI_OVERRIDE=$(aws ec2 describe-images --region "$REGION" --owners self \
      --filters 'Name=tag:project,Values=eris-spot' 'Name=state,Values=available' \
      --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text 2>/dev/null)
    { [ -n "$AMI_OVERRIDE" ] && [ "$AMI_OVERRIDE" != None ]; } || { echo "ERROR: golden AMI が無い（先に infra/spot/bake-ami.sh）" >&2; exit 1; }
  fi
  AMI="$AMI_OVERRIDE"   # golden AMI
else
  AMI=$(aws ssm get-parameters --region "$REGION" \
    --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
    --query 'Parameters[0].Value' --output text)
fi
echo "  ami      : $AMI ${AMI_OVERRIDE:+(golden)}  sg: $SG_ID   myip: $MYIP"

# ---- watchdog user-data ------------------------------------------------------
USERDATA=$(sed "s|@@WATCHDOG_MIN@@|$WATCHDOG_MIN|g" "$SELF/cloud-init.sh")

# ---- spot 起動（--type はカンマ区切りで複数可。容量切れ時は順にフォールバック） --
# golden AMI モードでは block-device-mappings を上書きしない（AMI の baked サイズを使う。
# 小さい値を指定すると InvalidBlockDeviceMapping になる）。
BDM=()
[ -z "$AMI_OVERRIDE" ] && BDM=(--block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=${DISK_GB},VolumeType=gp3,DeleteOnTermination=true}")
IFS=',' read -ra TRY_TYPES <<< "$INSTANCE_TYPE"
IID=""; PICKED_TYPE=""
for t in "${TRY_TYPES[@]}"; do
  echo "-- spot 起動を試行: $t"
  if IID=$(aws ec2 run-instances --region "$REGION" \
      --image-id "$AMI" --instance-type "$t" \
      --instance-market-options 'MarketType=spot' \
      --key-name "$KEY_NAME" --security-group-ids "$SG_ID" \
      --instance-initiated-shutdown-behavior terminate \
      --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
      ${BDM[@]+"${BDM[@]}"} \
      --user-data "$USERDATA" \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$RUN_ID},{Key=project,Value=eris-spot}]" \
      --query 'Instances[0].InstanceId' --output text 2>/tmp/eris-runerr.$$); then
    PICKED_TYPE="$t"; break
  fi
  echo "   不可: $(tr -d '\n' < /tmp/eris-runerr.$$ | sed 's/.*An error occurred//' | cut -c1-90)"
  IID=""
done
rm -f /tmp/eris-runerr.$$
[ -n "$IID" ] || { echo "ERROR: 全 type で spot 起動失敗（容量/クォータ）"; exit 1; }
echo "  instance : $IID  (type=$PICKED_TYPE)"

terminate() {
  if [ "$KEEP" = 1 ]; then
    echo "[keep] terminate しません。手動: aws ec2 terminate-instances --instance-ids $IID"
  else
    echo "[cleanup] terminate $IID"
    aws ec2 terminate-instances --instance-ids "$IID" >/dev/null 2>&1 || true
  fi
}
trap terminate EXIT

# ---- public IP 取得 + SSH 疎通待ち -------------------------------------------
echo "-- instance running 待ち"
aws ec2 wait instance-running --instance-ids "$IID"
IP=$(aws ec2 describe-instances --instance-ids "$IID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "  public ip: $IP"
echo "-- SSH 疎通待ち"
for i in $(seq 1 60); do
  if ssh "${SSH_OPTS[@]}" -o ConnectTimeout=5 "ubuntu@$IP" true 2>/dev/null; then echo "  SSH OK"; break; fi
  sleep 5
done

# ---- コード送付（rsync） + シークレット送付 --------------------------------
# rsync を使う理由: deployer の vendor は数 GB（gmx-src/aave の node_modules が
# 大量小ファイル）。macOS の bsdtar は除外ディレクトリを「枝刈り」せず全 walk して
# 致命的に遅い。rsync の --exclude は枝刈りするので速い。hardhat 再生成物
# (artifacts/deployments) は box で recompile されるので常に除外。deploy 対象外の
# 重い vendor 丸ごとも除外。
RSH="ssh ${SSH_OPTS[*]}"
if [ -n "$AMI_OVERRIDE" ]; then
  # golden AMI モード: toolchain/deps/deployer/state は焼済。poc の working tree
  # だけ上書き（新しい agent config 等を反映）。constants.local.ts は baked state に
  # 一致するものを残すため除外。deployer 転送・install・deploy は一切無し。
  echo "-- コード送付（rsync: poc のみ。golden AMI）"
  rsync -az --exclude=node_modules --exclude=.git --exclude=runs --exclude=cache \
        --exclude=.DS_Store --exclude=src/constants.local.ts \
        -e "$RSH" "$POC_DIR/" "ubuntu@$IP:~/eris/poc/"
  scp "${SSH_OPTS[@]}" "$SELF/remote-run-ami.sh" "ubuntu@$IP:~/eris/remote-run.sh" >/dev/null
else
  RSX=(--exclude=node_modules --exclude=.git --exclude=runs --exclude=cache --exclude=.DS_Store
       --exclude=vendor/gmx-src/artifacts --exclude=vendor/gmx-src/deployments
       --exclude=vendor/aave/artifacts)
  if [ -n "$DEPLOY_ONLY" ]; then
    case "$DEPLOY_ONLY" in *gmx*) :;; *) RSX+=(--exclude=vendor/gmx-src);; esac
    case "$DEPLOY_ONLY" in *aave*) :;; *) RSX+=(--exclude=vendor/aave);; esac
  fi
  echo "-- コード送付（rsync: poc / deployer）"
  ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "mkdir -p ~/eris/poc ~/eris/deployer; command -v rsync >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq rsync)"
  rsync -az "${RSX[@]}" -e "$RSH" "$POC_DIR/"      "ubuntu@$IP:~/eris/poc/"
  rsync -az "${RSX[@]}" -e "$RSH" "$DEPLOYER_DIR/" "ubuntu@$IP:~/eris/deployer/"
  scp "${SSH_OPTS[@]}" "$SELF/remote-run.sh" "ubuntu@$IP:~/eris/remote-run.sh" >/dev/null
fi
printf '%s' "$OLLAMA_API_KEY" | ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "umask 077; cat > ~/eris/.ollama_key"

# ---- detached 起動 -----------------------------------------------------------
RUN_CMD_B64="$(printf '%s' "$RUN_CMD" | base64 | tr -d '\n')"
echo "-- remote-run を detached 起動"
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" \
  "cd ~/eris && RUN_CMD_B64='$RUN_CMD_B64' ERIS_LLM_MODEL='$OLLAMA_MODEL' ERIS_DEPLOY_ONLY='$DEPLOY_ONLY' \
   setsid bash remote-run.sh > ~/eris/run.log 2>&1 < /dev/null & echo launched"

# ---- live tail + 完了待ち ----------------------------------------------------
echo "-- ログ tail（Ctrl-C で tail のみ抜ける。run は box 上で継続）"
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "tail -F ~/eris/run.log 2>/dev/null" &
TAIL_PID=$!
EC=""
while true; do
  EC=$(ssh "${SSH_OPTS[@]}" -o ConnectTimeout=8 "ubuntu@$IP" "cat ~/eris/EXIT_CODE 2>/dev/null" || true)
  [ -n "$EC" ] && break
  sleep 10
done
kill "$TAIL_PID" 2>/dev/null || true
echo ""
echo "== RUN 完了 exit_code=$EC =="

# ---- 結果回収（runs/ + ログ） -----------------------------------------------
mkdir -p "$OUT_DIR"
echo "-- runs/ を回収 → $OUT_DIR"
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "cd ~/eris/poc && tar czf - runs 2>/dev/null" \
  | tar xzf - -C "$OUT_DIR" 2>/dev/null || echo "   (runs/ 無し)"
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "cat ~/eris/run.log"   > "$OUT_DIR/console.log" 2>/dev/null || true
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "cat ~/eris/deploy.log" > "$OUT_DIR/deploy.log" 2>/dev/null || true
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "cat ~/eris/resources.log" > "$OUT_DIR/resources.log" 2>/dev/null || true

echo "== 回収完了 =="
echo "  結果   : $OUT_DIR/runs/"
echo "  ログ   : $OUT_DIR/console.log, $OUT_DIR/deploy.log"
# trap terminate がこの後 box を落とす（--keep 指定時は残す）
exit "$EC"
