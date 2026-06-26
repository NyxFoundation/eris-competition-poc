import { Command } from "commander";
import { startAnvil, stopAnvil, anvilManagedHere } from "./anvil.js";
import { MANAGE_ANVIL } from "./config.js";
import { reset, flush, getRegistry } from "./registry.js";
import { deployTokens } from "./tokens.js";
import { info, ok } from "./util.js";

// 各プロトコルのデプロイ関数 (順次追加)
import { deployUniswapV3 } from "./protocols/uniswap-v3.js";
import { deployBalancerV2 } from "./protocols/balancer-v2.js";
import { deployAaveV3 } from "./protocols/aave-v3.js";
import { deployCurve } from "./protocols/curve.js";
import { deployGmxV2 } from "./protocols/gmx-v2.js";

type ProtocolName = "uniswap" | "balancer" | "aave" | "gmx" | "curve";

// gmx は hardhat-deploy で数分かかるため ALL の最後に置く
const ALL: ProtocolName[] = ["uniswap", "balancer", "aave", "curve", "gmx"];

const DEPLOYERS: Record<
  ProtocolName,
  (opts: { seed: boolean }) => Promise<void>
> = {
  uniswap: deployUniswapV3,
  balancer: deployBalancerV2,
  aave: deployAaveV3,
  curve: deployCurve,
  gmx: deployGmxV2,
};

async function main() {
  const program = new Command();
  program
    .option("--only <list>", "デプロイ対象を絞る (例: uniswap,balancer)")
    .option("--no-seed", "プール作成・流動性投入をスキップ")
    .option("--keep-fresh", "deployments.json を初期化してから開始")
    .option("--exit", "完了後 anvil を停止してプロセスを終了 (CI 向け)")
    .parse(process.argv);
  const opts = program.opts();

  const targets: ProtocolName[] = opts.only
    ? (String(opts.only)
        .split(",")
        .map((s) => s.trim()) as ProtocolName[])
    : ALL;
  const seed: boolean = opts.seed !== false;

  if (opts.keepFresh) reset();

  if (MANAGE_ANVIL) await startAnvil();

  try {
    await deployTokens();

    for (const name of targets) {
      info(`プロトコル: ${name}`);
      await DEPLOYERS[name]({ seed });
    }

    flush();
    info("完了");
    const reg = getRegistry();
    ok(
      "deployments.json 出力",
      `protocols: ${Object.keys(reg.protocols).join(", ")}`,
    );
  } catch (e) {
    console.error(e);
    if (MANAGE_ANVIL && anvilManagedHere()) stopAnvil();
    process.exit(1);
  }

  if (opts.exit) {
    if (MANAGE_ANVIL && anvilManagedHere()) stopAnvil();
    process.exit(0);
  }

  // 既定では anvil を起動したまま保持 (デプロイ済みチェーンを使い続けられる)
  if (MANAGE_ANVIL && anvilManagedHere()) {
    console.log("\nanvil は起動したままです。停止するには Ctrl-C。");
    await new Promise<never>(() => {}); // プロセスを生かし続ける
  }
}

main().catch((e) => {
  console.error(e);
  stopAnvil();
  process.exit(1);
});
