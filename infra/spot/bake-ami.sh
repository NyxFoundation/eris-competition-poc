#!/usr/bin/env bash
# =============================================================================
# eris golden AMI — ベイク（1 回実行）
# =============================================================================
# build インスタンスを立て、poc/deployer を送り、remote-bake.sh で
# toolchain+deps 導入 → full deploy → anvil state dump まで作り、AMI 化する。
# 完成した AMI ID を表示。以後 run-spot.sh に ERIS_SPOT_AMI=<id> を渡せば、
# install/npm ci/deploy/3GB 転送なしで起動が数分→1 分弱になる。
#
# 前提: setup-once.sh 済み（鍵 + SG）。bake は SSH 疎通だけ使う（OLLAMA 不要）。
# 使い方: infra/spot/bake-ami.sh
# =============================================================================
set -euo pipefail

REGION="${ERIS_SPOT_REGION:-us-west-2}"
INSTANCE_TYPE="${ERIS_SPOT_TYPE:-c7i.4xlarge,m7i.4xlarge,c6i.4xlarge,m6i.4xlarge,c5.4xlarge,m5.4xlarge}"
DISK_GB="${ERIS_BAKE_DISK_GB:-50}"
WATCHDOG_MIN="${ERIS_BAKE_WATCHDOG_MIN:-120}"
KEY_NAME="${ERIS_SPOT_KEY:-eris-spot}"
KEY_PATH="${ERIS_SPOT_KEY_PATH:-$HOME/.ssh/eris-spot}"
SG_NAME="${ERIS_SPOT_SG_NAME:-eris-spot-ssh}"
DEPLOYER_DIR="${ERIS_DEPLOYER_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../deployer" 2>/dev/null && pwd || true)}"
AMI_NAME="${ERIS_AMI_NAME:-eris-golden-$(date +%Y%m%d-%H%M%S)}"
export AWS_DEFAULT_REGION="$REGION"
export AWS_PROFILE="${ERIS_AWS_PROFILE:-eris}"

POC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="$(dirname "${BASH_SOURCE[0]}")"
SSH_OPTS=(-i "$KEY_PATH" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=30)
[ -f "$KEY_PATH" ] || { echo "ERROR: 鍵が無い: $KEY_PATH（先に setup-once.sh）" >&2; exit 1; }
[ -d "$DEPLOYER_DIR" ] || { echo "ERROR: deployer が無い: $DEPLOYER_DIR" >&2; exit 1; }

echo "== eris golden AMI bake =="
echo "  ami-name : $AMI_NAME"
echo "  region   : $REGION   types: $INSTANCE_TYPE (spot)   disk: ${DISK_GB}GB"
echo "  deployer : $DEPLOYER_DIR"

SG_ID=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$SG_NAME" --query 'SecurityGroups[0].GroupId' --output text)
MYIP=$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 22 --cidr "${MYIP}/32" >/dev/null 2>&1 || true
AMI_BASE=$(aws ssm get-parameters --region "$REGION" \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text)
USERDATA=$(sed "s|@@WATCHDOG_MIN@@|$WATCHDOG_MIN|g" "$SELF/cloud-init.sh")

# ---- build インスタンス起動（spot + type フォールバック） -------------------
IFS=',' read -ra TRY_TYPES <<< "$INSTANCE_TYPE"
IID=""; PICKED=""
for t in "${TRY_TYPES[@]}"; do
  echo "-- build 起動を試行: $t"
  if IID=$(aws ec2 run-instances --region "$REGION" --image-id "$AMI_BASE" --instance-type "$t" \
      --instance-market-options 'MarketType=spot' --key-name "$KEY_NAME" --security-group-ids "$SG_ID" \
      --instance-initiated-shutdown-behavior terminate \
      --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
      --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=${DISK_GB},VolumeType=gp3,DeleteOnTermination=true}" \
      --user-data "$USERDATA" \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$AMI_NAME},{Key=project,Value=eris-spot}]" \
      --query 'Instances[0].InstanceId' --output text 2>/dev/null); then PICKED="$t"; break; fi
  IID=""
done
[ -n "$IID" ] || { echo "ERROR: build 起動失敗（容量/クォータ）" >&2; exit 1; }
echo "  build instance : $IID ($PICKED)"

cleanup() { echo "[cleanup] terminate build $IID"; aws ec2 terminate-instances --instance-ids "$IID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

aws ec2 wait instance-running --instance-ids "$IID"
IP=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "  public ip : $IP"
echo "-- SSH 疎通待ち"
for i in $(seq 1 60); do ssh "${SSH_OPTS[@]}" -o ConnectTimeout=5 "ubuntu@$IP" true 2>/dev/null && break; sleep 5; done

# ---- コード送付（rsync） + remote-bake 起動（detached） ---------------------
RSX=(--exclude=node_modules --exclude=.git --exclude=runs --exclude=cache --exclude=.DS_Store
     --exclude=vendor/gmx-src/artifacts --exclude=vendor/gmx-src/deployments --exclude=vendor/aave/artifacts)
echo "-- コード送付（rsync: poc / deployer）"
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "mkdir -p ~/eris/poc ~/eris/deployer; command -v rsync >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq rsync)"
RSH="ssh ${SSH_OPTS[*]}"
rsync -az "${RSX[@]}" -e "$RSH" "$POC_DIR/"      "ubuntu@$IP:~/eris/poc/"
rsync -az "${RSX[@]}" -e "$RSH" "$DEPLOYER_DIR/" "ubuntu@$IP:~/eris/deployer/"
scp "${SSH_OPTS[@]}" "$SELF/remote-bake.sh" "ubuntu@$IP:~/eris/remote-bake.sh" >/dev/null

echo "-- remote-bake を detached 起動（toolchain→deploy→state dump。10〜30 分）"
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "cd ~/eris && setsid bash remote-bake.sh > ~/eris/bake.log 2>&1 < /dev/null & echo launched"

# ---- BAKE_OK 待ち（ログ tail） ----------------------------------------------
echo "-- bake 進行待ち..."
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "tail -F ~/eris/bake.log 2>/dev/null" &
TAIL_PID=$!
BAKE_RESULT=""
while true; do
  if ssh "${SSH_OPTS[@]}" -o ConnectTimeout=8 "ubuntu@$IP" "test -f ~/eris/BAKE_OK" 2>/dev/null; then BAKE_RESULT=ok; break; fi
  # remote-bake 死亡（setsid プロセス消滅）かつ BAKE_OK 無し → 失敗
  if ! ssh "${SSH_OPTS[@]}" -o ConnectTimeout=8 "ubuntu@$IP" "pgrep -f remote-bake.sh >/dev/null" 2>/dev/null; then
    ssh "${SSH_OPTS[@]}" -o ConnectTimeout=8 "ubuntu@$IP" "test -f ~/eris/BAKE_OK" 2>/dev/null && { BAKE_RESULT=ok; break; }
    BAKE_RESULT=fail; break
  fi
  sleep 15
done
kill "$TAIL_PID" 2>/dev/null || true
[ "$BAKE_RESULT" = ok ] || { echo "ERROR: bake 失敗。ログ: ssh ... 'tail -80 ~/eris/bake.log'"; exit 1; }
echo "== bake 完了 =="

# ---- AMI 作成（create-image → available 待ち） ------------------------------
echo "-- create-image $AMI_NAME"
AMI_ID=$(aws ec2 create-image --instance-id "$IID" --name "$AMI_NAME" \
  --description "eris golden AMI (toolchain+deps+deployed anvil state)" \
  --tag-specifications "ResourceType=image,Tags=[{Key=project,Value=eris-spot}]" \
  --query 'ImageId' --output text)
echo "  AMI: $AMI_ID — available 待ち（スナップショット作成。最大 30 分）"
# aws ec2 wait は既定 ~10 分で諦めるため自前ポーリング（snapshot は終了まで進む）。
for i in $(seq 1 120); do
  st=$(aws ec2 describe-images --image-ids "$AMI_ID" --query 'Images[0].State' --output text 2>/dev/null || true)
  [ "$st" = available ] && break
  [ "$st" = failed ] && { echo "ERROR: AMI $AMI_ID が failed"; exit 1; }
  sleep 15
done
echo "$AMI_ID $AMI_NAME $(date -u +%FT%TZ)" >> "$SELF/.current-ami"   # 人間用の記録（最新が末尾）
echo ""
echo "================================================================"
echo " golden AMI 完成: $AMI_ID"
echo " 以後の run はこれだけ:"
echo "   ERIS_SPOT_AMI=$AMI_ID OLLAMA_API_KEY=... infra/spot/run-spot.sh --watch -- \\"
echo "     'npm run sim:realtime -- --seed 1 --blocks 80 --protocols uniswap,balancer,curve,aave,gmx --agents agents.local.json'"
echo "================================================================"
# trap cleanup が build インスタンスを terminate する
