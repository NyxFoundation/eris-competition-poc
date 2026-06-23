import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  http,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { erc20Abi, wethAbi } from "./abis.js";
import { MULTICALL3, TOKENS } from "./constants.js";
import type { BalanceSnapshot } from "./types.js";

export function makeChain(chainId: number) {
  return {
    id: chainId,
    name: "arbitrum-fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
    // viem の batch.multicall（同一 tick の readContract を Multicall3 1 本に自動集約）が参照する
    contracts: { multicall3: { address: MULTICALL3 } },
  } as const;
}

export function makeClients(
  rpcUrl: string,
  chainId: number,
  opts: { batch?: boolean } = {},
) {
  const chain = makeChain(chainId);
  // Arbitrum フォークは GMX Reader / Aave 読み取りが重いため timeout を広げる。
  // batch=true で (1) JSON-RPC array batch（同一 tick の要求を 1 HTTP に）と
  // (2) readContract の Multicall3 自動集約を有効化する。direct モードの agent は
  // 毎ブロック十数本の読取を発行するため、束ねないと anvil の往復回数が律速になる
  // （ADR 0006 Risks「anvil 律速」のレバー 1）。
  const transport = http(rpcUrl, {
    timeout: 120_000,
    retryCount: 2,
    batch: opts.batch ? true : undefined,
  });
  return {
    chain,
    publicClient: createPublicClient({
      chain,
      transport,
      batch: opts.batch ? { multicall: true } : undefined,
    }),
    walletClient: createWalletClient({ chain, transport }),
  };
}

export function accountAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

// ---------------------------------------------------------------------------
// stable 統一会計：usdcUnits は active な stable(native USDC / USDC.e / USDT) の合算。
// すべて 6 桁・$1 とみなす。coordinator が有効 adapter から active 集合を設定する。
// ---------------------------------------------------------------------------
let ACTIVE_STABLES: Address[] = [TOKENS.USDC.address];

export function setActiveStables(addresses: Address[]): void {
  const seen = new Set<string>();
  const list: Address[] = [];
  for (const a of [TOKENS.USDC.address, ...addresses]) {
    const lower = a.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    list.push(a);
  }
  ACTIVE_STABLES = list;
}

export function activeStables(): Address[] {
  return ACTIVE_STABLES;
}

export async function getBalances(
  publicClient: PublicClient,
  address: Address,
): Promise<BalanceSnapshot> {
  const [ethWei, wethWei, ...stableBalances] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({
      address: TOKENS.WETH.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
    ...ACTIVE_STABLES.map((token) =>
      publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
    ),
  ]);
  const stables: Record<string, bigint> = {};
  ACTIVE_STABLES.forEach((token, i) => {
    stables[token.toLowerCase()] = (stableBalances as bigint[])[i];
  });
  const usdcUnits = (stableBalances as bigint[]).reduce(
    (sum, b) => sum + b,
    0n,
  );
  return { ethWei, wethWei, usdcUnits, stables };
}

// 単一 stable の残高（adapter が自分の stable 在庫を確認するため）
export async function tokenBalance(
  publicClient: PublicClient,
  token: Address,
  address: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  }) as Promise<bigint>;
}

// ---------------------------------------------------------------------------
// anvil cheatcodes
// ---------------------------------------------------------------------------

type AnvilRequest = Parameters<PublicClient["request"]>[0];

export async function setEthBalance(
  publicClient: PublicClient,
  address: Address,
  valueWei: bigint,
): Promise<void> {
  await publicClient.request({
    method: "anvil_setBalance",
    params: [address, `0x${valueWei.toString(16)}`],
  } as AnvilRequest);
}

export async function impersonate(
  publicClient: PublicClient,
  address: Address,
): Promise<void> {
  await publicClient.request({
    method: "anvil_impersonateAccount",
    params: [address],
  } as AnvilRequest);
}

export async function stopImpersonate(
  publicClient: PublicClient,
  address: Address,
): Promise<void> {
  await publicClient.request({
    method: "anvil_stopImpersonatingAccount",
    params: [address],
  } as AnvilRequest);
}

export async function increaseTime(
  publicClient: PublicClient,
  seconds: number,
): Promise<void> {
  await publicClient.request({
    method: "evm_increaseTime",
    params: [`0x${seconds.toString(16)}`],
  } as AnvilRequest);
}

export async function mine(
  publicClient: PublicClient,
  blocks = 1,
): Promise<void> {
  await publicClient.request({
    method: "anvil_mine",
    params: [`0x${blocks.toString(16)}`],
  } as AnvilRequest);
}

// 実時間ブロック生成：seconds 秒ごとに mempool をまとめて 1 ブロック mine する。
// setup を高速フラッシュしたあと（no-mining + sendAndMine）、競争フェーズ開始時にこれを呼んで
// 実 N 秒 cadence へ切り替える。--order fees はこの interval mine 時にも mempool を fee 降順整列する。
// seconds=0 は interval mining を停止する（teardown 用）。
export async function setIntervalMining(
  publicClient: PublicClient,
  seconds: number,
): Promise<void> {
  await publicClient.request({
    method: "anvil_setIntervalMining",
    params: [seconds],
  } as AnvilRequest);
}

// automine の有効/無効。true にすると tx ごとに即 mine され、ブロック内の fee 競争が成立しなくなる
// （各 tx が単独ブロック化する）。実時間モードでは false のまま interval mining を使うこと。
export async function setAutomine(
  publicClient: PublicClient,
  enabled: boolean,
): Promise<void> {
  await publicClient.request({
    method: "evm_setAutomine",
    params: [enabled],
  } as AnvilRequest);
}

export type ResetForkOptions = {
  // 上流フォーク RPC（ARB_RPC_URL）。指定時は forking 付き anvil_reset でフォークを
  // 丸ごと作り直し、前 run/seed のローカル変更（Aave ポジション・reserve タイムスタンプ等）を
  // 完全に破棄する。未指定なら anvil_reset [] にフォールバック（状態が残留する点に注意）。
  forkUrl?: string;
  // 再フォーク先ブロック（FORK_BLOCK_NUMBER）。固定すると再実行が完全再現可能。
  forkBlockNumber?: number;
  // ローカル(非fork)デプロイモード。fork し直さず evm_snapshot/evm_revert でリセットする。
  localDeploy?: boolean;
  // ローカルモードの snapshot ID 永続化ファイル。別プロセスの run 間でクリーン断面を共有する。
  localSnapshotFile?: string;
};

// 同一プロセス内で一度捕捉した再フォーク先ブロック。multiSeedRun は 1 プロセスで全 SEED を
// 回すため、ここで固定して全 seed が同一フォークブロック（=同一の DeFi 流動性基準）を共有する。
let capturedForkBlock: number | undefined;

// ローカルデプロイモードの snapshot ID（プロセス内で run 間に revert→再 snapshot する）。
let localSnapshotId: Hex | undefined;

export async function resetFork(
  publicClient: PublicClient,
  options: ResetForkOptions = {},
): Promise<void> {
  const { forkUrl, forkBlockNumber, localDeploy, localSnapshotFile } = options;
  if (localDeploy) {
    // 非fork: 上流が無いため anvil_reset でフォークし直せない。代わりに evm_snapshot/
    // evm_revert で「デプロイ直後のクリーン断面」へ戻す。snapshot は revert 直後に取り直すので
    // 必ずクリーン断面を指す。
    //
    // cross-process: snapshot ID をファイル永続化し、別プロセスの run も前プロセスが残した
    // クリーン snapshot へ revert して始める（逐次起動を想定）。優先順: プロセス内メモリ >
    // 永続ファイル。stale id（anvil 再起動）は evm_revert が false を返すので現状態を base にする
    // (self-healing。前提 = freshly deployed anvil なら現状態はクリーン)。
    let revertTo = localSnapshotId;
    if (!revertTo && localSnapshotFile && existsSync(localSnapshotFile)) {
      const persisted = readFileSync(localSnapshotFile, "utf8").trim();
      if (persisted) revertTo = persisted as Hex;
    }
    if (revertTo) {
      await publicClient
        .request({ method: "evm_revert", params: [revertTo] } as AnvilRequest)
        .catch(() => {
          /* stale id: 現状態を base にする */
        });
    }
    localSnapshotId = (await publicClient.request({
      method: "evm_snapshot",
      params: [],
    } as AnvilRequest)) as Hex;
    if (localSnapshotFile) {
      try {
        writeFileSync(localSnapshotFile, localSnapshotId);
      } catch {
        /* 永続化に失敗してもプロセス内は動く */
      }
    }
    return;
  }
  if (!forkUrl) {
    // 上流 RPC 不明 → soft reset。状態が完全にはクリアされないため、複数 run/seed を
    // 同一 anvil で回す場合は anvil を都度再起動するか forkUrl を設定すること。
    await publicClient.request({
      method: "anvil_reset",
      params: [],
    } as AnvilRequest);
    return;
  }
  // 再現性のためブロックを固定。優先順: 明示指定 > プロセス内で捕捉済み > これから捕捉。
  const blockNumber = forkBlockNumber ?? capturedForkBlock;
  await publicClient.request({
    method: "anvil_reset",
    params: [
      {
        forking:
          blockNumber !== undefined
            ? { jsonRpcUrl: forkUrl, blockNumber }
            : { jsonRpcUrl: forkUrl },
      },
    ],
  } as AnvilRequest);
  if (blockNumber === undefined) {
    // latest を捕捉し、以降の resetFork で再利用（同プロセス内の決定論を確保）。
    capturedForkBlock = Number((await publicClient.getBlock()).number);
  }
}

export async function setStorageAt(
  publicClient: PublicClient,
  token: Address,
  slotKey: Hex,
  value: Hex,
): Promise<void> {
  await publicClient.request({
    method: "anvil_setStorageAt",
    params: [token, slotKey, value],
  } as AnvilRequest);
}

// bigint を 32-byte ストレージワードへエンコード（int256 の負値は two's complement）。
// anvil_setStorageAt 用。env の価格 state-write（ADR 0011 §1）が利用する。
export function bigintToStorageWord(value: bigint): Hex {
  const masked = value < 0n ? (1n << 256n) + value : value;
  return pad32(masked);
}

function balanceSlotKey(holder: Address, mappingSlot: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [holder, BigInt(mappingSlot)],
    ),
  );
}
function pad32(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

// ERC20 残高をストレージ書換で付与。balanceOf の mapping slot を 0..MAX で自動探索する
// （native USDC は slot 9 等。proxy でも balances は proxy 側ストレージにあるため動作）。
const PROBE_SENTINEL = 0x1234567890abcdef1234567890abcdefn;

// balanceOf の mapping slot 候補（よくある順）。proxy(OZ upgradeable) は gap で 51 付近のことが多い。
function candidateSlots(): number[] {
  const priority = [9, 0, 2, 3, 1, 51, 52, 53, 4, 5, 6, 7, 8, 10, 11];
  const seen = new Set(priority);
  const rest: number[] = [];
  for (let s = 0; s <= 200; s++) if (!seen.has(s)) rest.push(s);
  return [...priority, ...rest];
}

export async function dealErc20(
  publicClient: PublicClient,
  token: Address,
  holder: Address,
  amount: bigint,
): Promise<void> {
  for (const slot of candidateSlots()) {
    const key = balanceSlotKey(holder, slot);
    const original = ((await publicClient.getStorageAt({
      address: token,
      slot: key,
    })) ?? `0x${"0".repeat(64)}`) as Hex;
    await setStorageAt(publicClient, token, key, pad32(PROBE_SENTINEL));
    const probed = (await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    })) as bigint;
    if (probed === PROBE_SENTINEL) {
      await setStorageAt(publicClient, token, key, pad32(amount));
      return;
    }
    await setStorageAt(publicClient, token, key, original);
  }
  throw new Error(`could not locate ERC20 balance slot for token ${token}`);
}

// ---------------------------------------------------------------------------
// tx 送信ヘルパ（--no-mining 前提：送信→mine→receipt）
// ---------------------------------------------------------------------------

export async function sendAndMine(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  privateKey: Hex,
  tx: { to: Address; data?: Hex; value?: bigint },
): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hash = await walletClient.sendTransaction({
    account,
    chain,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    maxFeePerGas: baseFee + 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  await mine(publicClient);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// 実時間モード用：tx を mempool に投げるだけ（mine しない・receipt も待たない）。
// priorityFee を指定でき、interval mining 下で次ブロックに --order fees で取り込ませる。
// oracle 更新を agent より前(txIndex 0)に置きたいので、呼び側で agent 上限超の fee を渡す。
// tx.gas を明示すると viem の eth_estimateGas（= EVM 実行）が省かれる。oracle 書込のような
// 毎ブロックの定型 tx は明示し、agent 負荷で anvil の実行キューが詰まっても待たされないようにする。
export async function sendNoMine(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  privateKey: Hex,
  tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint },
  priorityFeeWei: bigint,
): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  return walletClient.sendTransaction({
    account,
    chain,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    gas: tx.gas,
    maxFeePerGas: baseFee + priorityFeeWei,
    maxPriorityFeePerGas: priorityFeeWei,
  });
}

// impersonated アドレスから送信（role-admin / acl-admin など）
export async function sendAsImpersonated(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  from: Address,
  tx: { to: Address; data?: Hex; value?: bigint },
): Promise<Hex> {
  await setEthBalance(publicClient, from, 10n ** 21n);
  await impersonate(publicClient, from);
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hash = await walletClient.sendTransaction({
    account: from,
    chain,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    maxFeePerGas: baseFee + 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  await mine(publicClient);
  await publicClient.waitForTransactionReceipt({ hash });
  await stopImpersonate(publicClient, from);
  return hash;
}

// ---------------------------------------------------------------------------
// 資金調達（Arbitrum）：ETH=setBalance / WETH=deposit / stable=dealErc20
// ---------------------------------------------------------------------------

const GAS_BUFFER_WEI = 5_000_000_000_000_000_000n; // 5 ETH

export async function fundWallet(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  privateKey: Hex,
  ethWei: bigint,
  wethWei: bigint,
  usdcUnits: bigint,
): Promise<void> {
  const address = accountAddress(privateKey);
  await setEthBalance(publicClient, address, ethWei + wethWei + GAS_BUFFER_WEI);
  if (wethWei > 0n) {
    await sendAndMine(publicClient, walletClient, chain, privateKey, {
      to: TOKENS.WETH.address,
      data: encodeFunctionData({
        abi: wethAbi,
        functionName: "deposit",
        args: [],
      }),
      value: wethWei,
    });
  }
  if (usdcUnits > 0n) {
    // active な各 stable に usdcUnits を付与（cross-venue で各 stable 在庫を持たせる）
    for (const token of ACTIVE_STABLES) {
      await dealErc20(publicClient, token, address, usdcUnits);
    }
  }
}

export function snapshotForLog(snapshot: BalanceSnapshot) {
  return {
    eth: formatUnits(snapshot.ethWei, 18),
    weth: formatUnits(snapshot.wethWei, 18),
    usdc: formatUnits(snapshot.usdcUnits, 6),
  };
}
