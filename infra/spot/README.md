# spot EC2 runner（SSH モデル）

ローカルの CPU/メモリ逼迫を避け、重い run（`discrimination` / `evaluate` など）を
**手元から 1 コマンドで spot EC2 に投げ、結果を SSH で手元へ回収**するツール。

ローカルデプロイモード（`ERIS_LOCAL_DEPLOY=1`）前提で fork RPC 依存が無いため、
spot 上で自己完結して動く。**S3 / SSM / IAM ロールは一切不要**。box は AWS API を叩かない。

## 仕組み

```
手元 (run-spot.sh) が全部ドライブ                 spot EC2 (remote-run.sh)
  現在 IP を SG に許可 → spot 起動(watchdog付)  ─▶  tar 展開 → npm ci → foundry 導入
  SSH 疎通待ち → コードを tar-over-ssh で送付         deployer: npm run deploy(anvil+全protocol)
  remote-run を detached 起動 → run.log を tail      poc: ERIS_LOCAL_DEPLOY=1 で run
  完了(EXIT_CODE) → runs/ を tar-over-ssh で回収      ~/eris/EXIT_CODE を書いて待機
  terminate（trap で異常時も必ず）
                       結果: ./runs-<run-id>/runs/
```

- **S3 を使わない**: コード送付も結果回収も `tar`-over-`ssh`。AWS 側は key pair と SSH 用 SG だけ。
- **git clone でなく working tree**: 未コミット変更をそのまま回せる／box に private repo 認証を置かない。
- **OLLAMA_API_KEY は AWS に置かない**: `run-spot.sh` に env で渡し、SSH で box の `~/eris/.ollama_key` へ送付。
- **必ず terminate**: laptop 側 `trap EXIT` で terminate。さらに box 側 watchdog（既定 240 分後に `shutdown` → terminate）で laptop が落ちても放置課金しない。
- **run は SSH 切断に強い**: box 上で `setsid` detached 実行。tail の SSH が切れても run は死なず、再接続で回収できる。

## 前提

- 手元に AWS CLI 認証 ＋ `ssh` / `tar`。スクリプトは **`eris` profile を自動使用**（`ERIS_AWS_PROFILE` で上書き可）。普段のデフォルト profile には影響しない。`aws --profile eris sts get-caller-identity` が通ること（現状アカウント `075096050160` / `user/eris-simulator`）。この principal に `infra/spot/runner-policy.json` 相当の権限が要る
- poc と deployer が sibling 配置（`../eris-app-deployer`）。違う場所なら `ERIS_DEPLOYER_DIR`
- deployer は `npm run deploy` 単体で anvil 起動＋全 protocol デプロイできる状態

## 一度だけ: key pair + security group

```bash
infra/spot/setup-once.sh
```

手元で ed25519 鍵を生成し公開鍵だけ EC2 へ import（秘密鍵 `~/.ssh/eris-spot` は手元に留まる）。
SSH(22) を「現在の手元 public IP」からのみ許可する SG を作る。IP が変わっても `run-spot.sh` 実行時に追従。

## 毎回: run を投げる

```bash
OLLAMA_API_KEY=ollama-xxxx infra/spot/run-spot.sh --watch -- \
  'REGIMES=base,bull,bear REPLICATIONS=5 ERIS_RUN_BLOCKS=120 \
   ENABLED_PROTOCOLS=uniswap,balancer,curve,aave,gmx \
   AGENTS_CONFIG=agents.local.json npm run discrimination'
```

完了すると結果が手元に揃う:

```
./runs-spot-YYYYmmdd-HHMMSS/runs/      ← 各 run の成果（summary.json / events.jsonl 等）
./runs-spot-YYYYmmdd-HHMMSS/console.log
./runs-spot-YYYYmmdd-HHMMSS/deploy.log
```

- 小さいロスターは安い型で: `--type c7i.2xlarge`
- box を落とさず残してデバッグ: `--keep`（後で手動 `aws ec2 terminate-instances --instance-ids ...`）

## 主な env / フラグ

| env / flag | 既定 | 説明 |
|---|---|---|
| `OLLAMA_API_KEY` | （必須） | box へ SSH 送付。AWS には置かない |
| `ERIS_AWS_PROFILE` | `eris` | spot 実行に使う AWS profile（スクリプト内だけに適用） |
| `--type` / `ERIS_SPOT_TYPE` | 6 type のリスト | **カンマ区切りで複数可**。容量切れ(InsufficientInstanceCapacity)時は順にフォールバック。既定は 16vCPU 級 6 種 |
| `--keep` | off | run 後に terminate しない（デバッグ用） |
| `ERIS_SPOT_REGION` | `us-west-2` | リージョン |
| `ERIS_SPOT_DISK_GB` | `40` | EBS gp3 サイズ |
| `ERIS_SPOT_WATCHDOG_MIN` | `240` | box が自動 terminate するまでの分数（コスト安全網） |
| `ERIS_LLM_MODEL` | `gpt-oss:120b` | ollama cloud モデル |
| `ERIS_DEPLOY_ONLY` | 空=全5venue | deployer の `--only`。例 `uniswap`（aave/gmx の hardhat-deploy を回避＝高速 smoke） |
| `ERIS_SPOT_AMI` | 空 | **golden AMI モード**。set すると install/deploy/3GB転送なしで起動（→ golden AMI 節） |
| `ERIS_DEPLOYER_DIR` | `../eris-app-deployer` | deployer repo パス |
| `ERIS_SPOT_KEY` / `ERIS_SPOT_KEY_PATH` | `eris-spot` / `~/.ssh/eris-spot` | 鍵名・パス |

## golden AMI（高速 launch・推奨）

毎回の install / npm ci / full deploy / 3GB vendor 転送を一掃する。全 protocol を deploy 済みの
anvil state を AMI に焼き、launch 時は `anvil --load-state`（~10 秒で全 5 venue 復元）して run するだけ。

```bash
# 一度だけ: AMI を焼く（~35 分。build instance→deploy→state dump→create-image）
infra/spot/bake-ami.sh                    # 最後に AMI ID を表示

# 以後の run（install/deploy なし。総時間 ~4〜5 分、起動オーバーヘッド ~2.7 分）
ERIS_SPOT_AMI=ami-xxxxxxxx OLLAMA_API_KEY=ollama-... infra/spot/run-spot.sh --watch -- \
  'SEED=1 ERIS_RUN_BLOCKS=80 ENABLED_PROTOCOLS=uniswap,balancer,curve,aave,gmx \
   AGENTS_CONFIG=config/claude-llm.yaml npm run sim:realtime'
```

- **現在の golden AMI: `ami-0e88a9cadfdb6d1a3`**（us-west-2 / eris account。全 5 venue + claude-llm で green 実証済み）。
- AMI モードでは **poc の working tree だけ** launch 時に rsync（新しい agent config / 戦略を反映）。`src/constants.local.ts` は baked state に一致するものを保持するため除外。deployer は焼済みなので送らない。
- poc の依存を増やした／deployer や constants を変えたときは **再 bake**（`bake-ami.sh`）。
- bake は full deploy を**成功までリトライ**するので、fresh box で不安定だった全 venue deploy も AMI 化時に 1 回だけ吸収される（以後の launch は安定）。

## 型の目安 / コスト

- ローカル 8core/16GB で逼迫 → 余裕を見て **c7i.4xlarge (16 vCPU / 32GB)** を既定に。小ロスターは c7i.2xlarge。
- spot は概ね on-demand の 30〜40%。c7i.4xlarge spot は us-west-2 で目安 $0.25〜0.35/h 程度（変動）。
- ブートに foundry/node 導入 + npm ci で 3〜5 分の固定オーバーヘッド。頻繁に回すなら golden AMI 化で短縮可（後日）。

## 検証状況 / アカウント制約（2026-06-25）

- **end-to-end 検証済み**: `eris` profile（account `075096050160`）の **c7i.4xlarge(16vCPU/32GB)** で uniswap-only + **claude-llm(ollama)** run が green（boot→rsync転送→install→deploy→run→回収→terminate）。ollama strategist もフル機能（strategy-v1/v2 改訂を生成）。
- **資源は非常に軽い**: peak load1 **0.77**（16 vCPU 中＝1 コア未満）/ peak mem **1.7GB**（32GB の ~5%）。sim 実行中は load 0.2〜0.6 / mem ~1GB。**ローカル逼迫の主因は旧 fork モード（Alchemy RPC / anvil cold state）で、計算自体は軽い**。4vCPU/8-16GB でも十分（t3.xlarge でも完走）。
- **spot クォータ**: us-west-2 を 32 vCPU へ引き上げ済み（L-34B43A08）。これで c7i.4xlarge(16)〜c7i.8xlarge(32) が起動可。
- **全5venue full-deploy は fresh box で不安定（deployer 側課題）**: `gen:local-constants` が**全 venue 前提**（gmxV2 必須）で部分 deploy だと失敗→コミット済 constants にフォールバック→aave アドレス不一致で `getReserveData` 空。full-deploy は uniswap seedPool が revert（おそらくフラッキー）。gmx は hardhat recompile で数分。→ **golden AMI（既知の良 deploy 済み snapshot を焼く）** で回避するのが本筋。次の一手。

## トレードオフ / 注意

- **手元 public IP が動的だと run 中の SSH が切れうる**: SG は起動時の現在 IP のみ許可。IP が run 中に変わると tail/poll の SSH が時間切れになる（run 自体は detached で継続。今回の smoke も IP ドリフトを跨いで完走した）。固定 IP 回線か、必要なら SG をより広い CIDR で許可しておくと安定。

- **結果回収時に手元が繋がっている必要**がある（SSH 取得のため）。run 自体は detached なので tail が切れても継続するが、回収と terminate は手元の `run-spot.sh` が担う。長時間 run は `tmux`/`screen` 越しに `run-spot.sh` を回すと安心。
- 手元を強制終了（kill -9 等）した場合は `trap` が走らず box が残る → watchdog（既定 240 分）で最終的に terminate。早く消すなら `aws ec2 terminate-instances`。
- 残骸確認: `aws ec2 describe-instances --filters Name=tag:project,Values=eris-spot Name=instance-state-name,Values=running`

## トラブル時

- 結果が来ない / 途中で失敗 → `./runs-<id>/console.log`（remote-run のブート〜run ログ）と `deploy.log`（deployer）を確認。
- SSH 疎通しない → SG の許可 IP がズレている可能性。`setup-once.sh` を再実行するか、現在 IP を 22 番に authorize。
