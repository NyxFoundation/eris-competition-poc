// @aave/deploy-v3 の prebuilt artifact + deploy スクリプトを
// 稼働中の anvil (localhost:8545) へ流し込むための最小 hardhat 設定。
require("hardhat-deploy");
require("@nomiclabs/hardhat-ethers");

const {
  DEFAULT_NAMED_ACCOUNTS,
} = require("@aave/deploy-v3/dist/helpers/constants");

module.exports = {
  solidity: {
    version: "0.8.10",
    settings: { optimizer: { enabled: true, runs: 100000 } },
  },
  networks: {
    // anvil。saveDeployments で deployments/localhost/*.json にアドレスが書き出される。
    localhost: {
      url: process.env.RPC_URL || "http://127.0.0.1:8545",
      chainId: 31337,
      live: false,
      saveDeployments: true,
      // anvil のアンロック済みアカウントを使う (node 側で署名)
    },
  },
  namedAccounts: { ...DEFAULT_NAMED_ACCOUNTS },
  // prebuilt artifact と deploy スクリプトを外部パッケージから読み込む (再コンパイル不要)
  external: {
    contracts: [
      {
        artifacts: "node_modules/@aave/deploy-v3/artifacts",
        deploy: "node_modules/@aave/deploy-v3/dist/deploy",
      },
    ],
  },
  mocha: { timeout: 0 },
};
