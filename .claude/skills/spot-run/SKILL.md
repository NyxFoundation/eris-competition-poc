---
name: spot-run
description: |
  重い run（discrimination / evaluate / sim:realtime）を golden AMI の spot EC2 に投げ、結果を SSH で手元に回収する。
  ローカルの CPU/メモリ逼迫を避けるための日常ドライバ。install/deploy なしで起動 ~3 分・全 5 venue + LLM 対応。
  使用: ユーザーが「spot で回して」「EC2 で回して」「リモートで run」「spot run」「クラウドで回して」「重いから spot に投げて」と言ったとき。
allowed-tools:
  - Bash
  - Read
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
---

# spot-run: golden AMI の spot EC2 で run を回す

`infra/spot/run-spot.sh` を **golden AMI モード**（`ERIS_SPOT_AMI=latest`）で叩き、手元から 1 コマンドで
spot に run を流す。詳細仕様は `infra/spot/README.md` と memory `spot-ec2-runner`。

## 0. 前提（最初に確認）

```bash
# OLLAMA_API_KEY は .env にある。run-spot は env から読むので source して渡す。
grep -q OLLAMA_API_KEY .env && echo ".env に OLLAMA あり" || echo "WARN: .env に OLLAMA 無し"
# golden AMI があるか（無ければ /spot-bake を先に促す）
aws --profile eris --region us-west-2 ec2 describe-images --owners self \
  --filters 'Name=tag:project,Values=eris-spot' 'Name=state,Values=available' \
  --query 'sort_by(Images,&CreationDate)[-1].[ImageId,Name]' --output text
```

golden AMI が無ければ「先に `/spot-bake` で AMI を焼く必要がある」と伝えて止まる。

## 1. run コマンドを決める

ユーザーの要望から **`-- ` の後ろに渡す poc コマンド**を組み立てる。指定が無ければ既定を使い、何を回すか一言添える。

- 単発 realtime（既定）:
  `SEED=1 ERIS_RUN_BLOCKS=80 ERIS_RUN_SECONDS=180 ENABLED_PROTOCOLS=uniswap,balancer,curve,aave,gmx AGENTS_CONFIG=<config> npm run sim:realtime`
- 反復評価: `REGIMES=base,bull,bear REPLICATIONS=5 ERIS_RUN_BLOCKS=120 AGENTS_CONFIG=<config> npm run evaluate`
- 識別力: `REGIMES=... REPLICATIONS=... AGENTS_CONFIG=<config> npm run discrimination`

config が不明なら `ls agents.*.json` を見て提案（追跡対象は `agents.all18-mixed.json`＝36体 multi-venue / `agents.claude-llm.json`＝LLM の 2 つ）。
判断に迷う重要点（config / 反復回数 / 時間）だけ AskUserQuestion で 1 回確認、それ以外は既定で進める。

## 2. 起動（必ず background。完了まで数分かかる）

`run_in_background: true` で投げる。`ERIS_SPOT_AMI=latest` で最新 golden AMI を自動解決。

```bash
set -a; source .env 2>/dev/null; set +a
LOG=runs-spot.log   # 任意。scratchpad でも可
ERIS_SPOT_AMI=latest ERIS_SPOT_WATCHDOG_MIN=30 infra/spot/run-spot.sh -- \
  '<§1 で決めた run コマンド>' > "$LOG" 2>&1
echo "rc=$?"
```

- **AMI モードは poc の working tree だけ rsync** するので、編集中の agent config / 戦略がそのまま反映される。
- 大型ロスターや在庫が薄いときは `--type` を増やす（既定は 16vCPU 6 種を順試行）。
- watchdog（既定 240、ここでは 30）で手元が落ちても box は自動 terminate（放置課金なし）。

## 3. 監視 → 結果回収

- ログを tail して `== RUN 完了 exit_code=N ==` を待つ（`anvil --load-state` → `RUN 開始` → 完了の流れ）。
- 完了で結果は **`./runs-spot-<run-id>/`** に揃う:
  - `runs/<ts>/summary.json`（per-agent finalValueUsdc / netPnlUsdc 等）
  - `console.log`（box の run ログ） / `resources.log`（mem/cpu サンプル）
- summary を読んで PnL・順位・違反の有無を要約。資源は `resources.log` の peak load1 / mem を 1 行で報告。
- `exit_code != 0` のときは `console.log` 末尾を見て原因を特定（多くは run コマンド側 or config の問題。spot インフラ自体は安定）。

## 4. 後始末（毎回）

```bash
# 念のため残骸インスタンスを確認（trap + watchdog で通常ゼロ）
aws --profile eris --region us-west-2 ec2 describe-instances \
  --filters Name=tag:project,Values=eris-spot Name=instance-state-name,Values=running,pending \
  --query 'Reservations[].Instances[].[InstanceId,InstanceType]' --output text
```

残っていれば `aws --profile eris --region us-west-2 ec2 terminate-instances --instance-ids <id>`。

## 注意

- 結果回収は SSH 経由なので、完了まで手元（この run-spot プロセス）が動いている必要がある。run 自体は box 上で detached なので tail が切れても継続する。
- 手元の public IP が動的だと run 中に SSH が切れうる。run-spot は起動時に現在 IP を SG 許可するが、中で変わった場合は `infra/spot/setup-once.sh` 相当の再許可が要る（`/spot-ops`）。
- AWS は常に `eris` profile（run-spot が内部で固定。直接 aws を叩くときは `--profile eris`）。
