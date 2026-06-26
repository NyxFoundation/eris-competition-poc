import { defineConfig } from "vitest/config";

// E2E 検証は「起動済み anvil + デプロイ済み deployments.json」を前提に動く。
// 全テストが同一の anvil 状態を共有するため、ファイル並列・テスト並列の双方を無効化して
// 逐次実行する。swap+waitTx や GMX の読み取りに備えて timeout は長めに取る。
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
