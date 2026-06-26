[← README](../../README.md)

# プロトコルとアクション

各アダプタ（`src/protocols/<name>.ts`）は parse / validation・calldata 構築・観測・orderflow・PnL を実装する。有効プロトコルは config の `run.protocols`（YAML 配列）か CLI フラグ `--protocols uniswap,balancer,curve,aave,gmx` で run ごとに選ぶ。エージェントの JSON アクション:

| プロトコル | アクション | venue (Arbitrum) |
|---|---|---|
| Uniswap V3 | `swap`, `mintLiquidity`, `removeLiquidity`, `collectFees` | WETH/USDC 0.05% プール |
| Balancer v2 | `balancerSwap` | 33/33/34 WETH/USDC/USDT weighted プール（フォーク時に seed） |
| Curve | `curveSwap` | tricrypto WETH↔USDT |
| Aave v3 | `aaveSupply`, `aaveWithdraw`, `aaveBorrow`, `aaveRepay` | native USDC / WETH リザーブ |
| GMX v2 | `gmxIncrease`, `gmxDecrease` | ETH/USD perp market |

加えてプロトコル非依存の `noop` / `bundle`（複数の bundle 可能な leaf を 1 tx に）/ `rawTx` / `rawBundle` がある。

> アクションは JSON で表現する。`bundle` は bundle 可能な leaf をまとめて 1 tx で送る（GMX は非同期のため単独のみ）。`rawTx` / `rawBundle` で生 calldata も送れる。1 ラウンドあたりの取引量は config の `limits`（`agentWethWei` / `agentUsdcUnits` / `agentBase`）で上限が掛かる。

## ステーブルコイン会計

Arbitrum の深い WETH/stable 流動性は USDC.e / USDT プールにあるため、native USDC・USDC.e・USDT はすべて `$1`・6 桁の **USDC 相当**として残高・PnL を合算する（`src/chain.ts` の `setActiveStables` / `getBalances`）。Uniswap / Aave / GMX は native USDC、Balancer は native USDC（プールをフォーク時に seed）、Curve は USDT を使う。

## オラクル制御（Aave v3 / GMX v2）

モックオラクル（`contracts/MockAggregator.sol` / `contracts/MockOracleProvider.sol`）を setup でフォークにデプロイする。Aave はコーディネータが ACL admin を impersonate して `AaveOracle` をモックに向け、GMX は `ROLE_ADMIN` を impersonate して keeper / controller ロールを付与し `DataStore` にモックプロバイダを登録する。毎ラウンド `updateOracles` が fair price を両モックへ書き込み、貸借のヘルスファクタと perp のマーク価格が動く。

## GMX の非同期実行

GMX は非同期（注文作成 → keeper 実行）。realtime では毎ブロック interval mining で進み、コーディネータは各ブロック後（`afterMine`）に直近ブロックの `OrderCreated` ログを読んで各注文を keeper として執行する。ブロック内順序は anvil の `--order fees`（priority fee 降順）で決まる。GMX のポジション変化はエージェントに約 1 ブロック遅れて見える。GMX アクションは単独のみ（bundle 不可）。
