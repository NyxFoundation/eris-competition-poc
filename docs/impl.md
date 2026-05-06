 # LP Action と Bundle 実行の追加計画

  ## Summary

  既存の noop / swap 単発 action に加えて、Uniswap V3 WETH/USDC 0.05% pool の LP 操作を追加する。bundle は atomic な1 txではなく、同一ラウンド内に同一エージェントから複
  数 tx を連続 submit し、1ブロックに入れる方式にする。エージェント内の tx 順序は同一ウォレットの nonce で保つ。

  ## Key Changes

  - AgentAction を以下に拡張する。
      - mintLiquidity: 新規 LP NFT 作成
          - tickLower, tickUpper, amountWethDesired, amountUsdcDesired, slippageBps?, maxPriorityFeePerGasWei?
      - removeLiquidity: 既存 LP NFT から指定 liquidity を decreaseLiquidity
          - tokenId, liquidity, amountWethMin?, amountUsdcMin?, maxPriorityFeePerGasWei?
      - collectFees: LP NFT の owed token を全回収
          - tokenId, maxPriorityFeePerGasWei?
      - bundle: 複数 action をまとめて返す
          - actions: swap | mintLiquidity | removeLiquidity | collectFees の配列
          - maxPriorityFeePerGasWei?
  - bundle 制約:
      - ネストした bundle と bundle 内 noop は reject
      - MAX_BUNDLE_ACTIONS を追加し、デフォルトは 5
      - 各 action は別 tx として submit
      - 同一 agent の bundle 内順序は nonce 順で維持
      - bundle 全体の atomicity は保証しない。途中 tx が revert しても他 tx は通常通り receipt 記録する

  ## Implementation Changes

  - Uniswap V3 NonfungiblePositionManager を追加する。
      - mainnet address: 0xC36442b4a4522E871399CD717aBDD847Ab11FE88
      - ABI: mint, decreaseLiquidity, collect, positions, balanceOf, tokenOfOwnerByIndex
      - setup 時に WETH/USDC を SwapRouter だけでなく Position Manager にも approve
  - observation を拡張する。
      - pool.tick, pool.tickSpacing
      - positions: agent が所有する LP NFT の tokenId, ticks, liquidity, owed token, 推定 WETH/USDC 現在価値
      - limits.maxBundleActions, limits.maxLpWethWei, limits.maxLpUsdcUnits, limits.maxOpenPositions
  - validation を拡張する。
      - tick は tickLower < tickUpper かつ tick spacing 10 の倍数のみ許可
      - LP投入額は残高と LP 用上限を超えたら reject
      - removeLiquidity / collectFees は agent 所有 tokenId のみ許可
      - bundle は confirmed state ベースで検証し、同一 bundle 内での swap 出力を後続 LP の資金として使う依存は v1 では許可しない
  - tx 生成を拡張する。
      - swap は既存 SwapRouter
      - mintLiquidity は Position Manager mint
      - removeLiquidity は decreaseLiquidity
      - collectFees は collect with uint128.max
      - mintLiquidity の amount0Min/amount1Min は事前 simulate の返却 amount に slippageBps を適用して算出する
  - ログ/集計を拡張する。
      - SubmittedTx に actionType, bundleId, bundleIndex を追加
      - events.jsonl と blocks.csv に bundle 情報を出す
      - summary に open LP positions、LP現在価値、未回収/owed fee、既存 token balance を合算した finalValueUsdc を出す
      - check:ordering は同一 owner の nonce 制約を考慮し、単純な priority fee 降順チェックだけで誤検知しないよう更新する

  ## PnL / Valuation

  - LP評価は Position Manager.positions と pool state から算出する。
      - 現在 tick と liquidity から position 内の token0/token1 amount を計算
      - tokensOwed0/1 を未回収 fee として含める
      - token0/token1 は WETH/USDC の address order で変換し、USDC建て評価する
  - summary の agent value は以下の合算にする。
      - wallet ETH/WETH/USDC balance
      - open LP position の current token amount
      - position の owed token
      - gas cost は従来通り別指標として出す

  ## Test Plan

  - unit tests:
      - parseAction が LP action と bundle を受け付ける
      - 不正 tick、上限超過、他人 tokenId、bundle nest、bundle action 数超過を reject
      - bundle が複数 TxIntent に展開され、bundleIndex が順序通りになる
      - LP valuation helper が current tick below / inside / above range の3ケースで値を返す
  - integration/smoke:
      - ROUNDS=1 で mintLiquidity sample agent が LP NFT を作れる
      - removeLiquidity + collectFees を bundle で同一ブロック submit できる
      - summary.json に LP position と LP込み PnL が出る
      - blocks.csv に bundle metadata が出る
      - npm run typecheck, npm test, npm run check:ordering -- runs/<run_id> が通る

  ## Assumptions

  - LP対象は既存と同じ mainnet fork の WETH/USDC 0.05% pool のみ。
  - v1 の bundle は「同一ブロック複数 tx」であり、atomic bundle や Flashbots 風の全体採否は実装しない。
  - flow wallet は従来通り単発 swap のままにし、bundle 対応は agent action のみ対象にする。
  - increaseLiquidity と burn は v1 では追加しない。追加入金は新規 mintLiquidity、撤退は removeLiquidity + collectFees bundle で扱う。
