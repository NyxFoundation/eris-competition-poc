# GMX V2 完全 E2E: GM deposit → keeper 実行 → openPosition

## Context

現在の GMX 検証(`test/gmx.test.ts`)は `Reader.getMarkets`/`getMarket` の **read-only 整合チェックのみ**で、
他4プロトコルが実 swap/supply まで検証しているのに対し GMX だけ「契約が動く」ことを確認できていない。
GMX V2 の deposit / order は「ユーザがリクエスト登録 → keeper が oracle 価格付きで execute」という
2段階の非同期フローのため、oracle 価格供給と keeper 実行が必要で従来スコープ外としていた。

本変更は、隣接 repo `/Users/tomo/nyx/anvil-oracle-fork/bot` の **trader / keeper / oracle パターン**
(MockOracleProvider 方式・署名不要)を流用し、空の anvil 上で
**GM 流動性 deposit → keeper 実行 → openPosition(MarketIncrease)→ keeper 実行 → ポジション確認**
までの完全 E2E を `test:e2e` に追加する。

## 設計の要点(調査で確定済み)

- **ロール**: fresh anvil の hardhat/localhost ロール設定(`vendor/gmx-src/config/roles.ts`)で
  **deployer(index 0)に CONTROLLER / ORDER_KEEPER 等が全付与**される。さらに RoleStore コンストラクタが
  deployer に ROLE_ADMIN を付与。よって deployer は DataStore セッターを直接呼べ(CONTROLLER)、
  keeper(index 1)へ ORDER_KEEPER を grant でき(ROLE_ADMIN)、execute も可能。**impersonation 不要**。
- **oracle(署名不要)**: `MockOracleProvider`(IOracleProvider 実装)を deploy し、DataStore に
  `isOracleProviderEnabled[mock]=true` と `oracleProviderForToken[Oracle][token]=mock` を登録。
  非アトミックな executeDeposit/executeOrder は provider 一致のみ検証(`Oracle._validatePrices`)。
  価格は `MockOracleProvider.setPrice(token, gmxPrice)` で設定、`getOraclePrice` は `block.timestamp` を返すため鮮度チェック通過。
- **トークン**: GMX テストトークンは `MintableToken`。`mint(account, amount)` を deployer が呼べる。
  executionFee は `ExchangeRouter.sendWnt`(native ETH を msg.value で送り内部 wrap)で供給。
- **アカウント**: 既存 `ACCOUNT_INDEX`(deployer=0, keeper=1, trader=2)が隣接 repo と一致。
  trader が create、keeper が execute。

## 新規 / 変更ファイル

| ファイル | 操作 |
|---|---|
| `contracts/interfaces/IGmxOracle.sol` | 新規。`OracleUtils.ValidatedPrice` + `IOracleProvider`(vendor の `contracts/oracle/{OracleUtils,IOracleProvider}.sol` と構造体/シグネチャ完全一致。隣接 repo からコピー) |
| `contracts/MockOracleProvider.sol` | 新規。`setPrice`/`getOraclePrice`/`shouldAdjustTimestamp(=false)`/`isChainlinkOnChainProvider(=false)`(隣接 repo からコピー) |
| `test/gmx-e2e.ts` | 新規。GMX 用の ABI・DataStore キー導出・`toGmxPrice`・ロール grant・oracle セットアップ・deposit/openPosition ヘルパ・key 取得・ポジション読み取り |
| `test/gmx.test.ts` | 既存の read-only describe に加え、`describe("GMX V2 完全 E2E")` を追加 |

> **再利用**: `src/clients.ts`(`publicClient`/`deployerWallet`/`keeperWallet`/`traderWallet`/`testClient`/`accounts`/`advance`/`impersonate`)、
> `src/util.ts`(`waitTx`/`loadForgeArtifact` で MockOracleProvider の abi+bytecode を `out/` から取得)、
> `test/support.ts`(`gmxDeployment`/`getProto`/`sameAddr`/`ZERO`)。
> DataStore キー文字列は `keccak256(encodeAbiParameters(parseAbiParameters("string"), ["..."]))` で base 定数を作り、
> `("bytes32, address")` / `("bytes32, address, address")` で合成(隣接 `bot/src/config.ts` の `KEYS` と同形)。

## E2E フロー(`test/gmx.test.ts` の追加 describe)

対象マーケット: `markets[]` から `long==tokens.WETH && short==tokens.USDC`(index=WETH)を選択。

**beforeAll(セットアップ)**
1. `loadForgeArtifact("MockOracleProvider","MockOracleProvider")` で MockOracleProvider を deployer から deploy
2. keeper に ORDER_KEEPER を grant(`RoleStore.grantRole`、deployer=ROLE_ADMIN)。既に保有なら skip
3. DataStore 登録(deployer=CONTROLLER): `setBool(isOracleProviderEnabled(mock), true)`、
   各 token(WETH/USDC)に `setAddress(oracleProviderForToken(Oracle, token), mock)`、
   `setUint(MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR, maxUint256)`
4. 価格設定: `mock.setPrice(WETH, toGmxPrice(3000,18))`, `setPrice(USDC, toGmxPrice(1,6))`
5. GMX テストトークンを trader へ mint(deployer 実行): WETH/USDC を deposit/担保用に十分量

**テスト 1: GM 流動性 deposit → keeper 実行で GM トークン発行**
- trader が WETH/USDC を Router approve →
  `ExchangeRouter.multicall([sendWnt(DepositVault, fee), sendTokens(WETH, DepositVault, long), sendTokens(USDC, DepositVault, short), createDeposit(params)])`
  (`simulateContract` で deposit key を取得 → `writeContract`)
- `advance(2)` 後、keeper が `DepositHandler.executeDeposit(key, oracleParams)` 実行
  (`oracleParams = { tokens:[WETH,USDC], providers:[mock,mock], data:["0x","0x"] }`、gas 明示)
- **検証**: `marketToken`(ERC20) の `balanceOf(trader) > 0`(GM 発行)

**テスト 2: openPosition(MarketIncrease long)→ keeper 実行でポジション生成**
- trader が WETH 担保を approve →
  `multicall([sendWnt(OrderVault, fee), sendTokens(WETH, OrderVault, collateral), createOrder(params)])`
  (orderType=2 MarketIncrease, isLong=true, sizeDeltaUsd=$3000*1e30, acceptablePrice=maxUint256,
   initialCollateralDeltaAmount=collateral)。simulate で order key 取得
- `advance(2)` 後、keeper が `OrderHandler.executeOrder(key, oracleParams)` 実行
- **検証**: `Reader.getAccountPositions(DataStore, trader, 0, 50)` に対象 market の long ポジションがあり
  `sizeInUsd > 0`(≈ sizeDeltaUsd)、`collateralAmount > 0`

> GMX の execute はエラー時に tx 内で order を cancel する場合があるため、tx status ではなく
> **deposit 後の GM 残高 / order 後のポジション state** を最終アサーションにする(誤りを確実に検知)。

## CI への影響

- `contracts/` に Solidity が増えるため、`lint` ジョブの `forge fmt --check` 通過用に `forge fmt` を適用、
  `forge build`(lint/deploy 両ジョブ)で MockOracleProvider をコンパイル(solc 0.8.20、pragma ^0.8.20 で整合)。
- `deploy` ジョブは既に forge build → deploy → `npm run test:e2e` の順。追加 describe はこの test:e2e で実行される。
- `tsconfig.json` は test を型チェック対象済み。新ヘルパ/テストも `npm run typecheck` で検査される。

## 検証方法(ローカル)

```bash
forge build                              # MockOracleProvider をコンパイル
forge fmt --check                        # 追加 .sol のフォーマット確認
npm run typecheck                        # test 含む型チェック

npm run anvil &                          # fresh anvil
MANAGE_ANVIL=false npm run deploy -- --keep-fresh
MANAGE_ANVIL=false npm run test:e2e      # GMX 完全 E2E を含む全テストが pass
kill %1
```

最終確認: `test/gmx.test.ts` の「完全 E2E」describe で
deposit 後に GM トークン残高 > 0、openPosition 後にポジション `sizeInUsd > 0` を確認。
ブランチ push → CI `deploy` ジョブ(vitest)が緑。

## リスクと対処

- **ロール/ROLE_ADMIN 前提**: deployer が ROLE_ADMIN でなければ keeper grant が失敗。その場合は
  deployer 自身が ORDER_KEEPER のため **executor を deployer にフォールバック**(ヘルパで保有判定して選択)。
- **構造体ドリフト**: `ValidatedPrice`/各 Params は vendor SHA(028c79a7)の Solidity と一致確認済み。
  実装時に `forge build` + 実行で最終確認。
- **oracle 鮮度/価格**: `advance(2)` で create より後の timestamp を保証。価格は GMX スケール(`toGmxPrice`)。
