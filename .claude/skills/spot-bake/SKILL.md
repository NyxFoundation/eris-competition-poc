---
name: spot-bake
description: |
  新しい golden AMI を焼く（全 protocol を deploy 済みの anvil state を AMI 化）。以後の spot run が install/deploy なしで高速・安定になる。
  poc の依存追加 / deployer・constants の変更 / 最初の 1 回に使う。~35 分（build 起動→deploy リトライ→state dump→create-image）。
  使用: ユーザーが「AMI を焼いて」「AMI 焼き直し」「rebake」「spot bake」「新しい AMI 作って」「deployer 変えたから焼き直し」と言ったとき。
allowed-tools:
  - Bash
  - Read
  - Edit
  - Grep
---

# spot-bake: golden AMI を焼く / 焼き直す

`infra/spot/bake-ami.sh` を回して新しい golden AMI を作る。仕組みは `infra/spot/README.md`（golden AMI 節）と
memory `spot-ec2-runner`。bake は **full deploy を成功までリトライ**するので、fresh box で不安定な全 venue deploy も
ここで 1 回だけ吸収される。

## 0. いつ焼くか / 前提

- **焼くべきとき**: 初回 / poc の npm 依存を増やした / deployer のコントラクト・デプロイ手順を変えた / `constants.local.ts` を変えた。
  （agent config や戦略コードだけの変更なら **再 bake 不要**。`/spot-run` が poc を毎回 rsync するので反映される。）
- 前提: `infra/spot/setup-once.sh` 済み（鍵 + SG。未なら `/spot-ops`）。deployer は `../eris-app-deployer`（`ERIS_DEPLOYER_DIR` で変更可）。

```bash
aws --profile eris sts get-caller-identity --query Arn --output text   # eris アカウントか確認
```

## 1. bake を起動（必ず background。~35 分）

`run_in_background: true`。

```bash
LOG=bake.log
infra/spot/bake-ami.sh > "$LOG" 2>&1; echo "bake rc=$?"
```

進行は box の `~/eris/bake.log` を SSH で覗ける（IP は laptop ログに出る）。主なフェーズ:
toolchain → npm ci(deployer/aave) + **yarn install(gmx-src)** → deploy 試行（gmx の hardhat recompile で数分）→
`state dump 完了` → `create-image` → AMI available 待ち（最大 30 分の自前ポーリング）。

## 2. 完了処理（AMI ID の記録）

成功すると laptop ログ末尾に `golden AMI 完成: ami-xxxx` が出て、`infra/spot/.current-ami` に追記される。

```bash
tail -3 infra/spot/.current-ami          # 最新が末尾
```

- README `infra/spot/README.md` の「現在の golden AMI: `ami-...`」行を新しい ID に **Edit で更新**。
- memory `spot-ec2-runner.md` の AMI ID も更新（古い ID を新しいものに）。
- `/spot-run` は `ERIS_SPOT_AMI=latest` で**最新 AMI を自動解決**するので、日常 run 側のコマンドは変更不要。

## 3. 軽い検証（推奨）

新 AMI で短い run を 1 本流して green を確認（`/spot-run` を呼ぶか、直接）:

```bash
set -a; source .env 2>/dev/null; set +a
ERIS_SPOT_AMI=latest ERIS_SPOT_WATCHDOG_MIN=25 infra/spot/run-spot.sh -- \
  'npm run sim:realtime -- --seed 1 --blocks 40 --seconds 90 --protocols uniswap,balancer,curve,aave,gmx --agents agents.all18-mixed.json'
```

`exit_code=0` を確認。失敗したら `./runs-spot-*/console.log` で原因切り分け。

## 4. 古い AMI の掃除（任意・コスト削減）

複数 bake すると AMI + スナップショットが溜まる。最新だけ残して古いものを deregister + snapshot 削除するのは `/spot-ops` の掃除手順で。

## bake で過去に踏んだ罠（既に修正済。再発時の参照）

- gmx-src は **yarn プロジェクト**（yarn.lock のみ、ts-node は devDeps）→ `npm ci` は失敗。`remote-bake.sh` は `yarn install` 済み。
- `aws ec2 wait image-available` は ~10 分上限 → 自前 30 分ポーリング済み。
- create-image 開始後はスナップショットが build インスタンス terminate 後も独立に完走する。
