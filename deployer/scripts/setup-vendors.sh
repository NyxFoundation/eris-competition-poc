#!/usr/bin/env bash
# vendor の外部リポジトリ(GMX)をクローンし、localhost 対応パッチを適用するブートストラップ。
# Curve は vendor/curve に prebuilt bytecode を同梱済みのため再ビルド不要。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GMX_REPO="https://github.com/gmx-io/gmx-synthetics.git"
GMX_SHA="028c79a7264fd458e2fc27c809750d919831c74b" # パッチ作成時の上流コミット
GMX_DIR="vendor/gmx-src"
PATCH="vendor/gmx-localhost.patch"

echo "==> GMX (gmx-synthetics) をセットアップ"
if [ ! -d "$GMX_DIR/.git" ]; then
  echo "  clone $GMX_REPO"
  git clone "$GMX_REPO" "$GMX_DIR"
fi
git -C "$GMX_DIR" fetch --depth 1 origin "$GMX_SHA" 2>/dev/null || git -C "$GMX_DIR" fetch origin
git -C "$GMX_DIR" checkout -q "$GMX_SHA"
echo "  apply $PATCH"
# 既に適用済みなら何もしない
if git -C "$GMX_DIR" apply --reverse --check "../../$PATCH" 2>/dev/null; then
  echo "  (パッチは適用済み)"
else
  git -C "$GMX_DIR" apply "../../$PATCH"
  echo "  パッチ適用完了"
fi
echo "  yarn install (時間がかかります)"
(cd "$GMX_DIR" && yarn install)

echo "==> Aave (hardhat サブプロジェクト) をセットアップ"
(cd vendor/aave && npm install)

echo "==> 完了。Curve(stableswap-ng / twocrypto-ng) は vendor/curve に bytecode 同梱済みのため追加作業不要。"
echo "    再ビルド手順 (Docker vyper 0.3.10):"
echo "      stableswap-ng: curvefi/stableswap-ng → vendor/curve/CurveStableSwapNG*.json"
echo "      twocrypto-ng : curvefi/twocrypto-ng tag lite-0.3.10 → vendor/curve/CurveTwocrypto*.json"
echo "        docker run --rm -v \$PWD:/code -w /code vyperlang/vyper:0.3.10 -f bytecode <contract>.vy"
echo "        (AMM=CurveTwocryptoOptimized は -f blueprint_bytecode)"
