# eris-app-deployer

空の(フォークではない) **anvil** チェーンへ、主要 DeFi プロトコルをゼロからデプロイし、
プール/マーケットと初期流動性まで投入する TypeScript/viem 製オーケストレーター。

| プロトコル | 状態 | デプロイ手法 |
|---|---|---|
| Uniswap V3 | ✅ | `@uniswap/v3-core` / `v3-periphery` の公式 artifact を viem で直接デプロイ |
| Balancer V2 | ✅ | `@balancer-labs/v2-deployments` の bytecode を viem で順次デプロイ |
| Aave V3 | ✅ | `@aave/deploy-v3` (hardhat-deploy) を `vendor/aave` 経由で実行 |
| Curve | ✅ | `stableswap-ng` を Vyper 0.3.10 でビルドした prebuilt bytecode を viem でデプロイ |
| GMX V2 | ✅ | `vendor/gmx-src` (gmx-synthetics, hardhat-deploy) を localhost 対応にパッチして実行 |

## 前提

- Node.js 18+ (動作確認は 23.x)
- Foundry (`anvil`, `forge`) がインストール済み

## セットアップ

```bash
npm install
forge build                 # 共有 mock トークン (WETH9 / MockERC20) をコンパイル
cp .env.example .env
./scripts/setup-vendors.sh  # 外部 repo(GMX) を clone+パッチ、Aave deps を install
```

> **vendor の構成**
> - 外部リポジトリのクローン (`vendor/gmx-src`, `vendor/curve-src`) は **git 管理外**。
>   `scripts/setup-vendors.sh` が固定コミットで clone し、GMX には
>   `vendor/gmx-localhost.patch` を適用する。パッチ内容 = `localhost`(anvil) で
>   hardhat-deploy を通すための変更 (`hardhat`/`localhost` 判定・`chainId`・各 config の
>   `localhost` キー・`setBalance` の anvil 互換化など。詳細は `docs/adr`)。
> - `vendor/curve` は `curvefi/stableswap-ng` を Vyper 0.3.10 (Docker) で
>   ビルドした `{abi, bytecode/blueprintBytecode}` JSON を**コミット済み**。実行時に
>   Vyper は不要。再ビルドする場合のみ `vendor/curve-src` を clone して
>   `docker run --rm -v $PWD:/code vyperlang/vyper:0.3.10 -f <fmt> <file>` を使う。
> - `vendor/aave` は `@aave/deploy-v3` を読み込む最小 hardhat プロジェクト (設定のみコミット)。

## 使い方

deployer は anvil を自前で起動・維持する (`MANAGE_ANVIL=true`)。

```bash
# 全プロトコルを空の anvil へデプロイ (anvil は起動したまま保持される)
npm run deploy -- --keep-fresh
```

主なフラグ:

- `--only uniswap,balancer` — 対象プロトコルを限定 (例: `--only gmx`)
- `--no-seed` — プール作成・流動性投入をスキップ (コア契約のみ)
- `--keep-fresh` — `deployments/deployments.json` を初期化してから開始
- `--exit` — 完了後 anvil を停止して終了 (CI 向け)

### E2E 検証 (vitest)

起動済み anvil + デプロイ済み `deployments.json` に対して、各プロトコルの
定量チェック・往復/ライフサイクル・ネガティブテスト・デプロイ健全性を vitest で検証する。
GMX V2 は `MockOracleProvider`(`contracts/`)を DataStore に登録し、trader が deposit/order を
作成 → keeper が oracle 価格付きで execute する完全 E2E(GM 流動性投入 → openPosition)まで検証する。
デプロイとは別プロセスなので、外部 anvil 接続 (`MANAGE_ANVIL=false`) で実行する:

```bash
npm run anvil &                            # anvil を起動 (--balance 等は npm script に設定済み)
MANAGE_ANVIL=false npm run deploy -- --keep-fresh
MANAGE_ANVIL=false npm run test:e2e        # test/*.test.ts を実行
```

CI (`.github/workflows/ci.yml` の `deploy` ジョブ) もこの順序で全プロトコルを検証する。

> GMX V2 は hardhat-deploy で 150+ コントラクトを展開するため、初回は数分かかる
> (Solidity コンパイルはキャッシュされる)。`--only gmx` で個別実行も可能。

既に別ターミナルで anvil を起動済みなら `.env` の `MANAGE_ANVIL=false` にする。
anvil は大型コントラクト対応のため `--code-size-limit 50000` で起動すること
(`npm run anvil` がこの設定で起動する)。

## 出力

全アドレスは `deployments/deployments.json` に集約される:

```jsonc
{
  "chainId": 31337,
  "tokens": { "WETH": "0x..", "USDC": "0x..", ... },  // 共有 mock トークン
  "protocols": {
    "uniswapV3": { "factory": "0x..", "swapRouter": "0x..", "wethUsdcPool": "0x.." },
    "balancerV2": { "vault": "0x..", "wethUsdcPoolId": "0x.." },
    "aaveV3": { "pool": "0x..", "aaveOracle": "0x..", "tokens": {..}, "aTokens": {..} }
  }
}
```

> Aave は `@aave/deploy-v3` が自前のテストトークン (USDC/WETH/WBTC/DAI...) を
> 生成するため、共有 mock トークンとは別系統。Aave のアドレスは
> `protocols.aaveV3.tokens` を参照。

## アーキテクチャ

```
src/
├── index.ts           オーケストレーター (CLI)
├── anvil.ts           anvil プロセス起動/待機
├── clients.ts         viem clients + アカウント
├── config.ts          チェーン・トークン定義
├── tokens.ts          共有 mock トークンのデプロイ
├── registry.ts        deployments.json 集約
├── erc20.ts           汎用 ERC20 ヘルパー
├── verify.ts          E2E スモークチェック
└── protocols/
    ├── uniswap-v3.ts
    ├── balancer-v2.ts
    ├── aave-v3.ts
    ├── curve.ts
    └── gmx-v2.ts
contracts/             共有 mock トークン (WETH9.sol, MockERC20.sol)
vendor/aave/           @aave/deploy-v3 を流す最小 hardhat プロジェクト
vendor/curve/          Vyper でビルド済みの Curve bytecode (JSON)
vendor/gmx-src/        gmx-synthetics クローン (localhost 対応にパッチ済み)
```
