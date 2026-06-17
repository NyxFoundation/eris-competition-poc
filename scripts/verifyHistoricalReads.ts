// ADR 0006 §4 の前提検証: run 終了後に anvil の歴史ブロック読取で
// per-agent 価値系列を再構成できるか（フォークモード + フルロスター実 run 条件）。
//
// 検証項目:
//  1) run のブロック窓 [start, mid, end] それぞれで、全 agent の WETH/USDC/ETH を
//     Multicall3 1 回の eth_call（blockNumber 指定）で読めるか + レイテンシ計測
//  2) 正しさ: 成功した agent tx のブロック前後（b-1 → b）で送信者の残高が変化するか
//  3) protocol コントラクト読取: aave getUserAccountData を歴史ブロックで呼べるか
//  4) 保持深度: anvil_mine で +EXTRA_BLOCKS 積んだ後も start ブロックの読取値が一致するか
//
// usage: tsx scripts/verifyHistoricalReads.ts [runDir]
//   env: ANVIL_RPC_URL (default http://127.0.0.1:8545), EXTRA_BLOCKS (default 1200)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, erc20Abi, http, parseAbi } from "viem";
import { latestRunDir } from "../src/perRoundValues.js";

const RPC = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const EXTRA_BLOCKS = Number(process.env.EXTRA_BLOCKS ?? 1200);
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as const;
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as const;

const multicall3Abi = parseAbi([
  "function getEthBalance(address addr) view returns (uint256)",
]);
const aavePoolAbi = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

type Snapshot = string[]; // [agent0 WETH, agent0 USDC, agent0 ETH, agent1 WETH, ...] を文字列化

async function main(): Promise<void> {
  const runDir = process.argv[2] ?? latestRunDir("./runs", true);
  console.log(`run dir: ${runDir}`);

  const summary = JSON.parse(
    readFileSync(join(runDir, "summary.json"), "utf8"),
  ) as { agents: Array<{ id: string; address: `0x${string}` }> };
  const agents = summary.agents;
  console.log(`agents: ${agents.length}`);

  // blocks.csv から run のブロック窓と「成功した agent tx」を 1 つ拾う
  const rows = readFileSync(join(runDir, "blocks.csv"), "utf8")
    .split("\n")
    .slice(1)
    .filter((l) => l.length > 0)
    .map((l) => l.split(","));
  if (rows.length === 0) throw new Error("blocks.csv is empty");
  const blockNums = rows.map((r) => Number(r[1]));
  const startBlock = BigInt(Math.min(...blockNums));
  const endBlock = BigInt(Math.max(...blockNums));
  const midBlock = (startBlock + endBlock) / 2n;
  console.log(
    `block window: ${startBlock} .. ${endBlock} (${endBlock - startBlock + 1n} blocks)`,
  );
  const agentTx = rows.find((r) => r[8] === "agent" && r[6] === "success");

  const client = createPublicClient({ transport: http(RPC) });

  // --- 1) 歴史ブロック断面の一括読取（Multicall3 1 call）+ レイテンシ ---
  const sweep = async (blockNumber: bigint): Promise<Snapshot> => {
    const contracts = agents.flatMap((a) => [
      {
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [a.address],
      } as const,
      {
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [a.address],
      } as const,
      {
        address: MULTICALL3,
        abi: multicall3Abi,
        functionName: "getEthBalance",
        args: [a.address],
      } as const,
    ]);
    const results = await client.multicall({
      contracts,
      blockNumber,
      multicallAddress: MULTICALL3,
      allowFailure: false,
    });
    return results.map((v) => String(v));
  };

  const snapshots = new Map<bigint, Snapshot>();
  for (const bn of [startBlock, midBlock, endBlock]) {
    const t0 = performance.now();
    snapshots.set(bn, await sweep(bn));
    const ms = Math.round(performance.now() - t0);
    console.log(
      `sweep @ block ${bn}: OK (${agents.length} agents x WETH/USDC/ETH = ${agents.length * 3} reads, ${ms} ms)`,
    );
  }

  // 値が「全部ゼロ」でないことの確認（読めているフリの検出）
  const startSnap = snapshots.get(startBlock)!;
  const nonZero = startSnap.filter((v) => v !== "0").length;
  console.log(
    `non-zero values @ start block: ${nonZero}/${startSnap.length} (期待: 大半が非ゼロ = 初期資金)`,
  );

  // --- 2) 正しさ: agent tx の前後で送信者残高が変化するか ---
  if (agentTx) {
    const [, blockStr, , hash, from] = agentTx;
    const b = BigInt(Number(blockStr));
    const ethBefore = await client.getBalance({
      address: from as `0x${string}`,
      blockNumber: b - 1n,
    });
    const ethAfter = await client.getBalance({
      address: from as `0x${string}`,
      blockNumber: b,
    });
    const changed = ethBefore !== ethAfter;
    console.log(
      `tx-boundary check: agent tx ${hash.slice(0, 14)}… @ block ${b} (${agentTx[7]}/${agentTx[9]}) — sender ETH ${ethBefore} -> ${ethAfter}: ${changed ? "CHANGED (OK)" : "UNCHANGED (NG)"}`,
    );
    if (!changed) process.exitCode = 1;
  } else {
    console.log("tx-boundary check: skipped (no successful agent tx found)");
  }

  // --- 3) protocol コントラクト読取（aave）を歴史ブロックで ---
  try {
    const data = await client.readContract({
      address: AAVE_POOL,
      abi: aavePoolAbi,
      functionName: "getUserAccountData",
      args: [agents[0].address],
      blockNumber: endBlock,
    });
    console.log(
      `aave getUserAccountData @ block ${endBlock}: OK (collateralBase=${data[0]}, debtBase=${data[1]})`,
    );
  } catch (error) {
    console.log(
      `aave getUserAccountData @ block ${endBlock}: FAILED — ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
    process.exitCode = 1;
  }

  // --- 4) 保持深度: +EXTRA_BLOCKS 積んでから start ブロックを再読取し一致を確認 ---
  await client.request({
    // biome-ignore lint/suspicious/noExplicitAny: anvil 独自メソッド
    method: "anvil_mine" as any,
    params: [`0x${EXTRA_BLOCKS.toString(16)}`] as any,
  });
  const latest = await client.getBlockNumber();
  console.log(`mined +${EXTRA_BLOCKS} empty blocks (latest=${latest})`);

  const t0 = performance.now();
  const reread = await sweep(startBlock);
  const ms = Math.round(performance.now() - t0);
  const identical =
    reread.length === startSnap.length &&
    reread.every((v, i) => v === startSnap[i]);
  console.log(
    `re-sweep @ block ${startBlock} (now ${latest - startBlock} blocks deep): ${identical ? "IDENTICAL (OK)" : "MISMATCH (NG)"} (${ms} ms)`,
  );
  if (!identical) process.exitCode = 1;

  console.log(process.exitCode === 1 ? "RESULT: FAIL" : "RESULT: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
