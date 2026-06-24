---
name: spot-ops
description: |
  spot EC2 runner の運用ヘルパー: 初回セットアップ（鍵 + SG + IAM ポリシー）、状態確認（稼働インスタンス / golden AMI 一覧 / コスト）、掃除（残骸インスタンス terminate / 古い AMI とスナップショット削除 / SG の IP 再許可）。
  使用: ユーザーが「spot のセットアップ」「spot 掃除して」「稼働インスタンス確認」「AMI 一覧」「古い AMI 消して」「orphan 落として」「IP 許可し直して」と言ったとき。
allowed-tools:
  - Bash
  - Read
  - Edit
---

# spot-ops: spot runner の setup / status / cleanup

AWS は全て **`eris` profile / `us-west-2`**。スクリプトは `infra/spot/`、詳細は `infra/spot/README.md`。
やることを 1 つに絞り、実行前に「何をするか・コスト/破壊性」を 1 行で伝える。terminate / deregister など
**取り消せない操作は対象を describe で見せてから**実行する。

## A. 初回セットアップ

```bash
# 鍵(~/.ssh/eris-spot)生成 + 公開鍵 import + SSH(22) を現在 IP のみ許可する SG 作成
infra/spot/setup-once.sh
```

IAM が要る場合（`run-spot` が UnauthorizedOperation で落ちる等）は、`eris-simulator` に最小ポリシーを付与:

```bash
aws --profile eris iam create-policy --policy-name eris-spot-runner \
  --policy-document file://infra/spot/runner-policy.json
aws --profile eris iam attach-user-policy --user-name eris-simulator \
  --policy-arn arn:aws:iam::075096050160:policy/eris-spot-runner
```

（権限が無ければ管理者に `infra/spot/runner-policy.json` を渡して付けてもらう。）

## B. 状態確認（status）

```bash
export AWS_PROFILE=eris AWS_DEFAULT_REGION=us-west-2
echo "=== 稼働中の eris-spot インスタンス ==="
aws ec2 describe-instances \
  --filters Name=tag:project,Values=eris-spot Name=instance-state-name,Values=running,pending \
  --query 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name,LaunchTime]' --output text
echo "=== golden AMI 一覧（新しい順） ==="
aws ec2 describe-images --owners self --filters 'Name=tag:project,Values=eris-spot' \
  --query 'reverse(sort_by(Images,&CreationDate))[].[ImageId,Name,State,CreationDate]' --output text
echo "=== 現在 latest として解決される AMI ==="
aws ec2 describe-images --owners self \
  --filters 'Name=tag:project,Values=eris-spot' 'Name=state,Values=available' \
  --query 'sort_by(Images,&CreationDate)[-1].[ImageId,Name]' --output text
```

コスト概算は `aws-cost-analysis` skill が使える。spot/EBS スナップショットの料金が主。

## C. 掃除（cleanup）

**残骸インスタンス**（trap + watchdog で通常ゼロだが、手元 kill -9 等で残ることがある）:

```bash
# まず一覧（B）で確認 → 不要なものだけ
aws --profile eris --region us-west-2 ec2 terminate-instances --instance-ids <id...>
```

**古い golden AMI + スナップショット**（最新だけ残す。B の一覧から最新 1 個を除いて）:

```bash
# 各古い AMI について: deregister → 紐づく snapshot を削除
AMI=<古いAMI>
SNAP=$(aws --profile eris --region us-west-2 ec2 describe-images --image-ids "$AMI" \
  --query 'Images[0].BlockDeviceMappings[0].Ebs.SnapshotId' --output text)
aws --profile eris --region us-west-2 ec2 deregister-image --image-id "$AMI"
aws --profile eris --region us-west-2 ec2 delete-snapshot --snapshot-id "$SNAP"
```

deregister/delete は取り消せないので、**残す最新 AMI を取り違えない**こと（B で確認。`/spot-run` が使う `latest` = 一番新しい available）。

## D. 手元 IP が変わって SSH が通らないとき

run-spot は起動時に現在 IP を SG 許可するが、run 中に変わると切れる。現在 IP を再許可:

```bash
SG=$(aws --profile eris --region us-west-2 ec2 describe-security-groups \
  --filters Name=group-name,Values=eris-spot-ssh --query 'SecurityGroups[0].GroupId' --output text)
MYIP=$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')
aws --profile eris --region us-west-2 ec2 authorize-security-group-ingress \
  --group-id "$SG" --protocol tcp --port 22 --cidr "${MYIP}/32" || echo "既存"
```

長時間 run は固定 IP 回線 or `tmux` 越しに `/spot-run` を回すと安定。
