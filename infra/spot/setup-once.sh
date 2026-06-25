#!/usr/bin/env bash
# =============================================================================
# eris spot runner — 一度だけ実行する準備（SSH モデル / 冪等）
# =============================================================================
# 作るもの（S3/SSM/IAM は不要）:
#   - EC2 key pair      : 手元で生成し公開鍵だけ import（秘密鍵は laptop に留まる）
#   - security group    : SSH(22) を「現在の手元 public IP」からのみ許可
#
# OLLAMA_API_KEY は AWS には置かない。run-spot.sh 実行時に env で渡し、
# SSH 経由で box の ~/eris/.ollama_key へ送る。
# =============================================================================
set -euo pipefail

REGION="${ERIS_SPOT_REGION:-us-west-2}"
KEY_NAME="${ERIS_SPOT_KEY:-eris-spot}"
KEY_PATH="${ERIS_SPOT_KEY_PATH:-$HOME/.ssh/eris-spot}"
SG_NAME="${ERIS_SPOT_SG_NAME:-eris-spot-ssh}"
export AWS_DEFAULT_REGION="$REGION"
# spot 用 AWS profile。このスクリプト(子プロセス)内だけに効く＝普段のシェルや
# デフォルト profile には影響しない。別 profile を使うなら ERIS_AWS_PROFILE で上書き。
export AWS_PROFILE="${ERIS_AWS_PROFILE:-eris}"

echo "region=$REGION key=$KEY_NAME sg=$SG_NAME"

# ---- 1) key pair -------------------------------------------------------------
if [ ! -f "$KEY_PATH" ]; then
  echo "[create] 秘密鍵を生成: $KEY_PATH"
  mkdir -p "$(dirname "$KEY_PATH")"
  ssh-keygen -t ed25519 -f "$KEY_PATH" -N '' -C "eris-spot" >/dev/null
fi
if aws ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
  echo "[skip] key pair 既存(EC2): $KEY_NAME"
else
  echo "[import] 公開鍵を EC2 へ: $KEY_NAME"
  aws ec2 import-key-pair --key-name "$KEY_NAME" \
    --public-key-material "fileb://${KEY_PATH}.pub" >/dev/null
fi

# ---- 2) security group（SSH を現在の IP からのみ） --------------------------
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
SG_ID=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  echo "[create] security group $SG_NAME (vpc=$VPC_ID)"
  SG_ID=$(aws ec2 create-security-group --group-name "$SG_NAME" \
    --description "eris spot SSH" --vpc-id "$VPC_ID" --query GroupId --output text)
fi
MYIP=$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')
echo "[authorize] ssh 22 from ${MYIP}/32 (既存なら skip)"
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
  --protocol tcp --port 22 --cidr "${MYIP}/32" >/dev/null 2>&1 \
  || echo "   (既存ルール)"

echo "== setup 完了 =="
echo "  key   : $KEY_PATH(.pub) / EC2 key-name=$KEY_NAME"
echo "  sg    : $SG_ID ($SG_NAME)"
echo "  次: OLLAMA_API_KEY=ollama-xxxx infra/spot/run-spot.sh --watch -- '<run cmd>'"
