# ADR: 空のanvilへの5大DeFiプロトコル一括デプロイヤー

## Context

空の(フォークではない)anvilチェーン上に **Uniswap V3 / Balancer V2 / Aave V3 / Curve / GMX V2** をゼロからデプロイし、プール/マーケットと初期流動性まで投入してE2Eで動く状態を作る deployer を実装する。

現状 `eris-app-deployer` は空のスキャフォルド。隣接の `/Users/tomo/nyx/anvil-oracle-fork` は **メインネットフォーク前提**(既存アドレス参照)で全く別物だが、viem+anvil の操作パターン・GMX/Aaveのロール設定・MockOracle・トレード実行ロジックは**そのまま流用できる資産**なので積極的に再利用する。

5プロトコルはデプロイ手法が完全に異種(Uniswap=公式CLI、Balancer=artifact、Aave/GMX=hardhat-deploy、Curve=Vyper bytecode)であるため、本deployerは「異種ツールチェーンのオーケストレーション層」として設計する。

### 決定事項(ユーザー確認済み)
- **アーキテクチャ**: TypeScript/viem オーケストレーター。各公式ツールを子プロセスで叩き、prebuilt artifact は viem で直接デプロイ。最終的に統一 `deployments.json` を出力。
- **到達点**: コア契約 + プール/マーケット作成 + 初期流動性投入まで(swap/supply/openPosition がE2Eで通る)。
- **ソース取得**: 公式リポジトリ/artifact を vendor(npm依存 or git submodule)し公式デプロイ経路を再利用。
- **進め方**: 段階的。Phase1 = 共通基盤 + Uniswap V3 / Balancer V2 / Aave V3。Phase2 = GMX V2 / Curve。
- **Curve**: prebuilt blueprint bytecode を vendor(Vyperコンパイラ不要)。脆弱な vyper 0.2.15/0.2.16/0.3.0 は使わない。

## リポジトリ構成

```
eris-app-deployer/
├── package.json            # ルート。viem, tsx, typescript, commander(CLI)
├── tsconfig.json           # anvil-oracle-fork/bot/tsconfig.json を踏襲(ES2022/ESNext/strict)
├── foundry.toml            # solc 0.8.20, optimizer 200(mockトークン用)
├── .env.example            # RPC_URL=http://127.0.0.1:8545, MNEMONIC(anvil既定)
├── contracts/              # 共有mockトークン(WETH9, MockERC20)
├── vendor/
│   ├── balancer/           # @balancer-labs/v2-deployments の task artifact(bytecode+abi)
│   ├── aave/               # @aave/deploy-v3 を読み込む最小hardhatサブプロジェクト
│   ├── gmx-synthetics/     # git submodule(hardhat-deploy) ※Phase2
│   └── curve/              # prebuilt blueprint bytecode JSON ※Phase2
├── src/
│   ├── index.ts            # オーケストレーター。CLI(--only, --no-seed)
│   ├── anvil.ts            # anvilプロセス起動/待機/snapshot
│   ├── clients.ts          # viem clients + アカウント(anvil既定mnemonic)
│   ├── tokens.ts           # 共有mock ERC20デプロイ(WETH9/USDC/WBTC/DAI)+mint
│   ├── registry.ts         # 全アドレス集約 → deployments/deployments.json
│   ├── abis.ts             # 各プロトコルABI
│   ├── util.ts             # 価格スケール等(anvil-oracle-fork/util.ts流用)
│   └── protocols/
│       ├── uniswap-v3.ts
│       ├── balancer-v2.ts
│       ├── aave-v3.ts
│       ├── gmx-v2.ts       # ※Phase2
│       └── curve.ts        # ※Phase2
└── deployments/deployments.json   # 出力(全アドレス+トークンマップ)
```

## 共通基盤(Phase 1 の最初)

- **`anvil.ts`**: `anvil --code-size-limit 50000 --base-fee 0 --port 8545` で起動(Uniswap V3はコード上限緩和必須、Aaveは8545固定)。RPC readiness をポーリング。spawn管理。
- **`clients.ts`**: anvil既定mnemonic `"test test test ... junk"`。account0=deployer。`anvil-oracle-fork/bot/src/clients.ts` を流用。
- **`tokens.ts`**: WETH9(canonical) と MockERC20(USDC=6dec / WBTC=8dec / DAI=18dec)を forge artifact からデプロイし deployer に mint。Uniswap/Balancer/Curve/GMX が共有(Aaveは後述の理由で自前トークンを使う)。
- **`registry.ts`**: `{ chainId, tokens, protocols: { uniswapV3: {...}, ... } }` を蓄積し JSON 出力。

## 各プロトコルのデプロイ方針

### Uniswap V3(易)
- `@uniswap/deploy-v3` を子プロセス実行(`-pk` deployer / `-j` RPC / `-w9` WETH9 / `-ncl ETH` / `-o` owner / `-c 0`)。出力 `state.json` を registry へ取込み(Factory, NFTPositionManager, SwapRouter02, QuoterV2, TickLens 等)。
- **seed**: WETH/USDC プールを `Factory.createPool` → `initialize(sqrtPriceX96)` → `NonfungiblePositionManager.mint` で流動性投入。ABIは `@uniswap/v3-core`/`v3-periphery` の artifact から。

### Balancer V2(中)
- `@balancer-labs/v2-deployments` の task artifact(bytecode+abi)を viem `deployContract` で順次デプロイ: Authorizer → Vault(authorizer, WETH, pauseWindow, bufferPeriod) → WeightedPoolFactory(vault)。ProtocolFeesCollector は Vault が生成。
- **seed**: WeightedPoolFactory.create(80/20 WETH/USDC) → `Vault.joinPool` を INIT userData で初回流動性投入。

### Aave V3(中)
- `vendor/aave/` に最小hardhatプロジェクトを置き `hardhat.config` の `external` で `@aave/deploy-v3` の artifacts/deploy を読み込む。
- オーケストレーターが `MARKET_NAME=Aave npx hardhat --network localhost deploy` を子プロセス実行(稼働中anvil:8545へ)。フルマーケット(PoolAddressesProvider, Pool, PoolConfigurator, ACLManager, AaveOracle, テストトークン, faucet, aToken/debtToken)を生成。
- hardhat-deploy の `deployments/localhost/*.json` からアドレスを registry へ取込み。
- **注**: Aaveは**自前のテストトークン**(USDC/WETH/WBTC)とmockアグリゲーターを併せてデプロイする。AaveのE2Eはその自前トークンで行う(共有mockに揃えるのは追加工数のためPhase1では分離)。
- **seed**: viem で supply → borrow を1往復実行し動作確認。

### GMX V2(難・Phase2)
- `gmx-synthetics` を git submodule で vendor(hardhat-deploy)。`config/tokens.ts`・`config/markets.ts` に**ローカルネットワーク用エントリ**を追加し、共有mockトークンと mock price feed/oracle provider を指す設定にする。
- mock oracle は `anvil-oracle-fork/contracts/MockOracleProvider.sol` のパターンを流用。
- `npx hardhat deploy --network localhost` で RoleStore/DataStore/Reader/ExchangeRouter/OrderHandler 等を生成。
- **post-deploy**: ロール付与(CONTROLLER/ORDER_KEEPER/LIQUIDATION_KEEPER 等)を `anvil-oracle-fork/bot/src/setup.ts` のパターンで実行。WETH/USDC マーケット作成 → GMトークンへ流動性 deposit。
- **seed E2E**: `anvil-oracle-fork/bot/src/trader.ts` / `keeper.ts` / `reader.ts` / `oracle.ts` を流用し、mock価格設定→deposit→openPosition→keeper executeOrder まで通す。

### Curve(難・Phase2)
- `vendor/curve/` に stableswap-ng の**コンパイル済 blueprint bytecode**(factory=CurveStableSwapFactoryNG, math impl, views impl, plain pool impl, 任意でgauge)を `{abi, bytecode}` JSON で commit。
- viem で blueprint群デプロイ → factory デプロイ → `set_math_implementation`/`set_views_implementation`/pool implementation セット → `deploy_plain_pool`(mock安定ペア USDC/DAI 等)。
- **seed**: `add_liquidity` で初期流動性 → `exchange` で swap 動作確認。

## オーケストレーター(`src/index.ts`)

フロー: anvil起動 → 共有トークンデプロイ → 依存順にプロトコル実行(Uniswap → Balancer → Aave →〔Phase2〕GMX → Curve)→ registry書出し → seed/E2Eスモーク → anvil維持(or snapshot)。
CLIフラグ: `--only <list>` で個別実行、`--no-seed` で流動性投入スキップ。

## 流用元(`/Users/tomo/nyx/anvil-oracle-fork/`)

| 流用先 | 流用元 |
|---|---|
| clients.ts / アカウント導出 | `bot/src/clients.ts` |
| 価格スケール・assert・format | `bot/src/util.ts` |
| GMXロール設定・DataStore設定 | `bot/src/setup.ts`, `bot/src/config.ts` |
| GMXトレード/keeper/reader/oracle | `bot/src/{trader,keeper,reader,oracle}.ts` |
| mockオラクル契約 | `contracts/MockOracleProvider.sol`, `contracts/MockAggregator.sol` |
| 資金供給(setBalance/wrap/mint) | `bot/src/funding.ts` |
| foundry設定 | `foundry.toml`(solc 0.8.20) |

## Verification

各プロトコルのスモークチェックを `npm run verify` に集約し、空のanvilへ全デプロイ後に以下を assert:
- **共通基盤**: anvil起動・WETH9/mockトークンに残高がある。
- **Uniswap V3**: QuoterV2 で見積り取得 → SwapRouter で WETH→USDC swap が成功。
- **Balancer V2**: Vault経由で WETH→USDC swap が成功(プール残高変化を確認)。
- **Aave V3**: supply → borrow が成功し aToken/debtToken 残高が増える。
- **Curve**(Phase2): plain pool に add_liquidity 後 exchange が成功。
- **GMX V2**(Phase2): mock価格設定 → deposit流動性 → openPosition → keeper executeOrder でポジションがReaderから読める。

最終的に `deployments/deployments.json` に全アドレスが揃い、`anvil` 単体起動 + `npm run deploy` で再現できることを確認する。

## Phase区切り(段階納品)

- **Phase 1**: リポジトリ初期化 / anvil・共有トークン・registry / Uniswap V3 / Balancer V2 / Aave V3 + 各seed + verify。
- **Phase 2**: GMX V2(submodule・config・ロール・seed)/ Curve(blueprint bytecode・factory・seed)+ verify 追加。

---

## 実装結果(2026-05-24)

5プロトコルすべてを空の anvil へデプロイし E2E 検証まで通した。実装時に当初計画から変えた点:

- **Uniswap V3**: `@uniswap/deploy-v3` は npm 未公開のため、`@uniswap/v3-core`/`v3-periphery` の
  公式 npm artifact を viem で直接デプロイ(ライブラリリンク含む)。外部 CLI 不要で再現性が高い。
- **Curve**: `curvefi/stableswap-ng` を `git clone` し、**Vyper 0.3.10 (Docker `vyperlang/vyper:0.3.10`)**
  で factory/math/views をコンパイル、pool は `-f blueprint_bytecode`。生成物を `vendor/curve/*.json`
  ({abi, bytecode|blueprintBytecode}) としてコミット。実行時は viem でデプロイするだけ(Vyper 不要)。
  `deploy_plain_pool` の `_symbol` は `String[10]` 制約に注意(11文字でデコード revert)。
- **GMX V2**: `gmx-io/gmx-synthetics` を `git clone` し `vendor/gmx-src` に配置。`localhost` ネットワーク
  (=anvil) で hardhat-deploy を通すため以下をパッチ:
  1. 環境変数 `SKIP_AUTO_HANDLER_REDEPLOYMENT=true`(deploy タスクが必須化している)。
  2. `hardhat.config.ts` の `localhost` ネットワークに `chainId: 31337`(合成トークンアドレス計算で必須)。
  3. `config/*.ts` の per-network マップに `localhost` キーを追加(oracle に `chainlinkPaymentToken`、
     tokens に `ESGMX`、vaultV1/layerZero/feeDistributor に `localhost: {}`)。
  4. `network.name ===/!=/==/!== "hardhat"` 判定と `[..., "hardhat"]` 配列に `localhost` を追加
     (deploy/utils/config/scripts 全体を node スクリプトで機械置換)。`roles.ts` は `|| roles.hardhat`、
     `configureRoles.ts` は `|| []` でフォールバック。
  5. `setBalance`(@nomicfoundation/hardhat-network-helpers)は anvil で拒否されるため、
     `utils/setBalanceCompat.ts` を作り `hardhat_setBalance` 生 RPC に置換。
  結果、152 コントラクト + 4 マーケットを anvil に展開。`Reader.getMarkets` で検証。

### 検証 (`npm run deploy -- --keep-fresh --verify --exit`)
- Uniswap: WETH→USDC swap / Balancer: Vault swap / Aave: supply→borrow /
  Curve: USDC→DAI exchange / GMX: `Reader.getMarkets` で 4 マーケット取得、すべて成功。

### 既知の残作業
- GMX の seed は「マーケット作成 + Reader 読み取り」まで。GM 流動性 deposit と keeper 実行による
  openPosition の完全 E2E は `anvil-oracle-fork/bot` の trader/keeper/oracle パターンを流用して追加可能。
