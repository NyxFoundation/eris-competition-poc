import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { keccak256, stringToBytes, type Hex } from "viem";
import {
  CHAIN_ID,
  DEFAULT_ANVIL_PRIVATE_KEYS,
  MAX_BUNDLE_ACTIONS,
} from "./constants.js";
import type { AgentSpec, AgentsFile, ProtocolId } from "./types.js";
import { baseTokens } from "./markets.js";
import {
  parseStressEvents,
  type StressEventConfig,
} from "./realtime/events.js";

const ALL_PROTOCOLS: ProtocolId[] = [
  "uniswap",
  "balancer",
  "curve",
  "gmx",
  "aave",
];

const NAMED_AGENT_WALLETS = [
  "AGENT0_PRIVATE_KEY",
  "AGENT1_PRIVATE_KEY",
  "AGENT2_PRIVATE_KEY",
  "AGENT3_PRIVATE_KEY",
  "AGENT4_PRIVATE_KEY",
  "AGENT5_PRIVATE_KEY",
  "AGENT6_PRIVATE_KEY",
] as const;
const SUPPORTED_AGENT_WALLETS = [...NAMED_AGENT_WALLETS, "AUTO"] as const;

export type SimConfig = {
  rpcUrl: string;
  chainId: number;
  // フォーク元の上流 RPC（ARB_RPC_URL）。設定時は resetFork が anvil_reset を
  // forking 設定付きで呼び、フォーク状態を毎回クリーンに再構築する（run/seed 間で
  // Aave 等のポジションが残留する anvil_reset [] の問題を回避）。未設定なら従来の
  // anvil_reset [] にフォールバック。
  forkUrl?: string;
  // 再フォーク先ブロック（FORK_BLOCK_NUMBER）。固定すると再実行が完全再現可能になる。
  // 未設定なら最初の resetFork で latest を捕捉し、以降のリセットで再利用する。
  forkBlockNumber?: number;
  // 清算デモ(GitHub #1)。ERIS_LIQUIDATION_DEMO=1 のとき、coordinator が victim ウォレットに
  // 過剰レバレッジの Aave ポジションを開かせ、shockRound 以降に Aave WETH オラクルを引き下げて
  // HF<1 にし、liquidator agent が清算できる状況を作る。既定 off(既存 run/テストは不変)。
  liquidationDemo: boolean;
  liquidationShockBps: number; // WETH オラクル引き下げ幅(bps, 既定 1500=15%)
  liquidationShockRound: number; // 引き下げを始めるラウンド(既定 3)
  liquidationVictimSupplyWethWei: bigint; // victim が supply する WETH(既定 5)
  // 市場ストレスイベント(ADR 0009)。OU の base price に重ねる決定論オーバーレイ。
  // ERIS_STRESS_EVENTS の JSON 配列(レンジ指定)で spike/crash を与える。空(既定)なら従来 run と一致。
  stressEvents: StressEventConfig[];
  // 清算を成立させる seed 由来 victim 群(WETH supply + USDC borrow, HF≈H0)。採点対象外。
  // count=0(既定)で無効。>0 のときは aave 有効 + full re-fork(ARB_RPC_URL 必須)が前提(ADR 0009 §4)。
  stressVictimCount: number; // ERIS_STRESS_VICTIM_COUNT
  stressVictimHf0: number; // ERIS_STRESS_VICTIM_HF0(目標初期 HF。既定 1.10。LT/(0.97·LTV)≈1.08 超が必要)
  stressVictimSupplyWethWei: bigint; // ERIS_STRESS_VICTIM_WETH_WEI(victim 1 体あたり supply。既定 5)
  // フラッシュ arb デモ(GitHub #3)。ERIS_FLASH_ARB=1 で coordinator が FlashArb コントラクトを
  // デプロイし、flash-arb agent が利用できるようにする。uniswap+balancer+aave 有効が前提。既定 off。
  flashArbDemo: boolean;
  rounds: number;
  roundTimeSeconds: number;
  // 実時間モード（src/realtime/coordinator.ts）。interval mining のブロック間隔（秒）と
  // 実行の終了条件（実時間 or ブロック数）。同期ラウンド方式では未使用。
  blockTimeSec: number;
  runSeconds: number;
  runBlocks: number;
  // 環境とエージェント実行の分離（ADR 0006）。true なら agent は秘密鍵を受け取り
  // チェーンを直接読み書きする（観測 push / 代理提出なし）。既定 on。
  // ERIS_AGENT_DIRECT_TX=0 で旧 relay 方式へロールバック（run 単位で全 agent 一律）。
  agentDirectTx: boolean;
  // run 開始時の resetFork をスキップする（既定 false）。anvil の fork フェッチキャッシュを
  // 前 run から温存し、cold フェッチ由来のレイテンシ（mine 中の上流取得）を切り分ける診断用。
  // 状態は前 run から残留するため評価には使わない（ERIS_SKIP_RESET=1）。
  skipReset: boolean;
  // ローカル(非fork)デプロイ済み anvil を使うモード（ERIS_LOCAL_DEPLOY=1）。fork が無いため
  // run 間リセットは anvil_reset でなく evm_snapshot/evm_revert を使う。アドレスは
  // constants.local.ts（gen:local-constants 生成）を overlay。fork 上流が無いので
  // FORK_BLOCK_NUMBER 固定・whale 等は不要。
  localDeploy: boolean;
  // ローカルモードの snapshot ID 永続化ファイル（cross-process でクリーン断面を共有）。
  localSnapshotFile: string;
  // 競争開始前に flow bot だけで N block の市場ループを回し、protocol の working set を
  // 温める（ADR 0006 Risks の anvil cold フェッチ対策）。競争フェーズの mine が上流フェッチを
  // 踏まなくなる。0 で無効（ERIS_PREWARM_BLOCKS）。
  prewarmBlocks: number;
  seed: number;
  runDirRoot: string;
  agentTimeoutMs: number;
  agentsConfigPath: string;
  initialEthWei: bigint;
  flowEthWei: bigint;
  initialWethWei: bigint;
  // ADR 0013: base シンボル -> 初期配布量（token units）。WETH は initialWethWei と同値で
  // 互換維持。追加 base は INITIAL_<SYM>_<UNIT>（例 INITIAL_WBTC_SATS）で読み、未指定は 0
  // （USDC-only 方針 = 追加 base は既定で配らない）。fork 既定（WETH のみ）では {WETH:...} の 1 件。
  initialBaseAmounts: Record<string, bigint>;
  initialUsdcUnits: bigint;
  defaultPriorityFeeWei: bigint;
  maxPriorityFeeWei: bigint;
  // gas 経済コスト化（ADR 0011。ADR 0010 を Supersede）。true で priority-fee 上限執行を退役し、
  // env の価格確定を mempool tx（cap+premium ordering）から PriceFeed/Aave オラクルの storage 直書き
  // （cheatcode）へ移して上限非依存にする。agent は機会評価に応じ自由に priority fee を積み、高く
  // 評価した者が先に約定する（realistic priority gas auction）。既定 false で ADR 0010 プロファイルを
  // 完全再現する（ロールバック先）。run 単位スイッチ（ERIS_ECONOMIC_GAS）。
  economicGas: boolean;
  maxAgentWethInWei: bigint;
  maxAgentUsdcInUnits: bigint;
  // ADR 0013: base シンボル -> per-round swap 上限（token units）。WETH は maxAgentWethInWei と
  // 同値で互換維持。追加 base は MAX_AGENT_<SYM>_<UNIT>（例 MAX_AGENT_WBTC_IN_SATS）。未指定は
  // 0（= 当該 base の per-round 上限を課さない。limits 整備は Phase 8 範囲外）。
  maxAgentBaseIn: Record<string, bigint>;
  maxBundleActions: number;
  maxLpWethWei: bigint;
  maxLpUsdcUnits: bigint;
  // ADR 0013: base シンボル -> LP mint 上限。WETH は maxLpWethWei と同値で互換維持。
  // 追加 base は MAX_LP_<SYM>_<UNIT>（例 MAX_LP_WBTC_SATS）。未指定は 0。
  maxLpBase: Record<string, bigint>;
  maxOpenPositions: number;
  uninformedFlowMaxWethWei: bigint;
  informedFlowMaxWethWei: bigint;
  enabledProtocols: ProtocolId[];
  maxGmxSizeUsd: bigint;
  maxAaveSupplyWethWei: bigint;
  // ADR 0013: base シンボル -> Aave supply 上限。WETH は maxAaveSupplyWethWei と同値で互換維持。
  // 追加 base は MAX_AAVE_SUPPLY_<SYM>_<UNIT>（例 MAX_AAVE_SUPPLY_WBTC_SATS）。未指定は 0。
  maxAaveSupplyBase: Record<string, bigint>;
  maxAaveBorrowUsdcUnits: bigint;
  balancerFlowMaxWethWei: bigint;
  curveFlowMaxWethWei: bigint;
  gmxFlowMaxSizeUsd: bigint;
  aaveFlowMaxWethWei: bigint;
  // delta-neutral cross-venue スプレッド注入の 1 leg あたり最大 WETH 相当（既定 0 = 無効）。
  // 毎ブロック 2 venue を対称に押し開いて「2-leg 裁定(α)だけが取れる」機会を構造的に作る。
  // 方向 β を注入せず α を増やすレバー（env を α 支配へ寄せる。discrimination-needs-delta-neutral）。
  crossVenueSpreadFlowMaxWethWei: bigint;
  // ADR 0013: WETH 以外の base の AMM flow 1 leg 上限（base units）。既定空/0 = WBTC flow off。
  baseFlowMax: Record<string, bigint>;
  // orderflow bot（独立プロセス）の起動コマンドと決定論シード。
  flowBotCommand: string;
  flowBotArgs: string[];
  flowSeed: number;
  privateKeys: {
    agent0: Hex;
    agent1: Hex;
    agent2: Hex;
    agent3: Hex;
    agent4: Hex;
    agent5: Hex;
    agent6: Hex;
    uninformedFlow: Hex;
    informedFlow: Hex;
    setup: Hex;
    admin: Hex;
    keeper: Hex;
  };
};

export function loadConfig(env = process.env): SimConfig {
  const anvilPort = env.ANVIL_PORT ?? "8545";
  // 経済化（ADR 0011）では endowment を絞って gas を実コスト化する。INITIAL_ETH_WEI 未指定なら
  // 控えめな placeholder（3 ETH）を既定にする（gas を機会価値に対し意味あるコストにしつつ、
  // directShim gas マネージャ + 下限検証で gas 切れを防ぐ）。最終値は較正実測で決める
  // （ADR「決めていないこと」）。既定 0010 プロファイル（economicGas=false）は 100 ETH のまま不変。
  const economicGas = env.ERIS_ECONOMIC_GAS === "1";
  const initialEthWeiDefault = economicGas
    ? 3_000_000_000_000_000_000n
    : 100_000_000_000_000_000_000n;
  // WETH の既存 env 値（互換のためここで一度だけ読み、per-base マップの WETH エントリにも流用する）。
  const initialWethWei = bigintEnv(
    env.INITIAL_WETH_WEI,
    10_000_000_000_000_000_000n,
  );
  const maxAgentWethInWei = bigintEnv(
    env.MAX_AGENT_WETH_IN_WEI,
    1_000_000_000_000_000_000n,
  );
  const maxLpWethWei = bigintEnv(
    env.MAX_LP_WETH_WEI,
    1_000_000_000_000_000_000n,
  );
  const maxAaveSupplyWethWei = bigintEnv(
    env.MAX_AAVE_SUPPLY_WETH_WEI,
    5_000_000_000_000_000_000n,
  );
  return {
    rpcUrl: env.ANVIL_RPC_URL ?? `http://127.0.0.1:${anvilPort}`,
    chainId: intEnv(env.CHAIN_ID, CHAIN_ID),
    forkUrl:
      env.ARB_RPC_URL && env.ARB_RPC_URL.trim() !== ""
        ? env.ARB_RPC_URL.trim()
        : undefined,
    forkBlockNumber:
      env.FORK_BLOCK_NUMBER && env.FORK_BLOCK_NUMBER.trim() !== ""
        ? intEnv(env.FORK_BLOCK_NUMBER, 0)
        : undefined,
    liquidationDemo: env.ERIS_LIQUIDATION_DEMO === "1",
    liquidationShockBps: intEnv(env.ERIS_LIQUIDATION_SHOCK_BPS, 1500),
    liquidationShockRound: intEnv(env.ERIS_LIQUIDATION_SHOCK_ROUND, 3),
    liquidationVictimSupplyWethWei: bigintEnv(
      env.ERIS_LIQUIDATION_VICTIM_WETH_WEI,
      5_000_000_000_000_000_000n,
    ),
    stressEvents: parseStressEvents(env.ERIS_STRESS_EVENTS),
    stressVictimCount: intEnv(env.ERIS_STRESS_VICTIM_COUNT, 0),
    stressVictimHf0: floatEnv(env.ERIS_STRESS_VICTIM_HF0, 1.1),
    stressVictimSupplyWethWei: bigintEnv(
      env.ERIS_STRESS_VICTIM_WETH_WEI,
      5_000_000_000_000_000_000n,
    ),
    flashArbDemo: env.ERIS_FLASH_ARB === "1",
    rounds: intEnv(env.ROUNDS, 50),
    // 1 ラウンドあたりに進める EVM 時間（秒）。Aave 変動金利の累積や GMX funding
    // を現実的なスケールで発生させるためにラウンドループで evm_increaseTime に渡す。
    roundTimeSeconds: intEnv(env.ROUND_TIME_SECONDS, 3600),
    // 実時間モード（realtime）の設定。
    blockTimeSec: intEnv(env.ERIS_BLOCK_TIME_SEC, 2),
    runSeconds: intEnv(env.ERIS_RUN_SECONDS, 20),
    runBlocks: intEnv(env.ERIS_RUN_BLOCKS, 0),
    agentDirectTx: env.ERIS_AGENT_DIRECT_TX !== "0",
    skipReset: env.ERIS_SKIP_RESET === "1",
    localDeploy: env.ERIS_LOCAL_DEPLOY === "1",
    localSnapshotFile: env.ERIS_LOCAL_SNAPSHOT_FILE ?? ".local-snapshot",
    prewarmBlocks: intEnv(env.ERIS_PREWARM_BLOCKS, 0),
    seed: intEnv(env.SEED, 1),
    runDirRoot: env.REPORT_DIR ?? "./runs",
    agentTimeoutMs: intEnv(env.AGENT_TIMEOUT_MS, 5000),
    agentsConfigPath: env.AGENTS_CONFIG ?? "config/example.yaml",
    initialEthWei: bigintEnv(env.INITIAL_ETH_WEI, initialEthWeiDefault),
    // Background orderflow is environment machinery, not a competitor. Give it
    // ample gas so long runs do not silently lose market flow as wallets run dry.
    flowEthWei: bigintEnv(
      env.ERIS_FLOW_ETH_WEI,
      1_000_000_000_000_000_000_000n,
    ),
    initialWethWei,
    initialBaseAmounts: readBaseAmounts(env, "INITIAL", {
      WETH: initialWethWei,
    }),
    initialUsdcUnits: bigintEnv(env.INITIAL_USDC_UNITS, 25_000_000_000n),
    defaultPriorityFeeWei: bigintEnv(
      env.DEFAULT_PRIORITY_FEE_WEI,
      100_000_000n,
    ),
    maxPriorityFeeWei: bigintEnv(env.MAX_PRIORITY_FEE_WEI, 5_000_000_000n),
    economicGas,
    maxAgentWethInWei,
    maxAgentUsdcInUnits: bigintEnv(env.MAX_AGENT_USDC_IN_UNITS, 5_000_000_000n),
    // 追加 base の per-round swap 上限は MAX_AGENT_<SYM>_IN_<UNIT>（WETH は WEI 既存値を流用）。
    maxAgentBaseIn: readBaseAmounts(
      env,
      "MAX_AGENT",
      { WETH: maxAgentWethInWei },
      "IN",
    ),
    maxBundleActions: intEnv(env.MAX_BUNDLE_ACTIONS, MAX_BUNDLE_ACTIONS),
    maxLpWethWei,
    maxLpUsdcUnits: bigintEnv(env.MAX_LP_USDC_UNITS, 5_000_000_000n),
    maxLpBase: readBaseAmounts(env, "MAX_LP", { WETH: maxLpWethWei }),
    maxOpenPositions: intEnv(env.MAX_OPEN_POSITIONS, 10),
    uninformedFlowMaxWethWei: bigintEnv(
      env.UNINFORMED_FLOW_MAX_WETH_WEI,
      1_000_000_000_000_000_000n,
    ),
    informedFlowMaxWethWei: bigintEnv(
      env.INFORMED_FLOW_MAX_WETH_WEI,
      2_000_000_000_000_000_000n,
    ),
    enabledProtocols: parseEnabledProtocols(env.ENABLED_PROTOCOLS),
    maxGmxSizeUsd: bigintEnv(env.MAX_GMX_SIZE_USD, 50_000n * 10n ** 30n),
    maxAaveSupplyWethWei,
    maxAaveSupplyBase: readBaseAmounts(env, "MAX_AAVE_SUPPLY", {
      WETH: maxAaveSupplyWethWei,
    }),
    maxAaveBorrowUsdcUnits: bigintEnv(
      env.MAX_AAVE_BORROW_USDC_UNITS,
      5_000_000_000n,
    ),
    balancerFlowMaxWethWei: bigintEnv(
      env.BALANCER_FLOW_MAX_WETH_WEI,
      1_000_000_000_000_000_000n,
    ),
    curveFlowMaxWethWei: bigintEnv(
      env.CURVE_FLOW_MAX_WETH_WEI,
      1_000_000_000_000_000_000n,
    ),
    gmxFlowMaxSizeUsd: bigintEnv(
      env.GMX_FLOW_MAX_SIZE_USD,
      20_000n * 10n ** 30n,
    ),
    aaveFlowMaxWethWei: bigintEnv(
      env.AAVE_FLOW_MAX_WETH_WEI,
      2_000_000_000_000_000_000n,
    ),
    // 既定 0 = 無効（既存 run の flow と byte 互換を保つ）。α 支配 env プロファイルで > 0 にする。
    crossVenueSpreadFlowMaxWethWei: bigintEnv(
      env.CROSS_VENUE_SPREAD_FLOW_MAX_WETH_WEI,
      0n,
    ),
    // ADR 0013: WETH 以外の base の AMM flow 1 leg 上限（base units）。env FLOW_MAX_<SYM>_<UNIT>
    // （例 FLOW_MAX_WBTC_SATS）。既定 0 = WBTC 等の flow off → extraBases が RNG 非消費 = byte 互換。
    // WETH flow は uninformed/balancer/curve FlowMaxWethWei を使い続ける（ここには載せない）。
    baseFlowMax: readBaseAmounts(env, "FLOW_MAX", { WETH: 0n }),
    flowBotCommand: env.FLOW_BOT_COMMAND ?? "node",
    flowBotArgs:
      env.FLOW_BOT_ARGS && env.FLOW_BOT_ARGS.trim() !== ""
        ? env.FLOW_BOT_ARGS.trim().split(/\s+/)
        : ["--import", "tsx", "examples/flow/market-maker.ts"],
    // flow bot のシード。未指定なら SEED と同じにして単一 SEED が run 全体を決定する。
    flowSeed: intEnv(env.FLOW_SEED, intEnv(env.SEED, 1)),
    privateKeys: {
      agent0: hexEnv(env.AGENT0_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[0]),
      agent1: hexEnv(env.AGENT1_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[1]),
      agent2: hexEnv(env.AGENT2_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[2]),
      agent3: hexEnv(env.AGENT3_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[3]),
      agent4: hexEnv(env.AGENT4_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[4]),
      agent5: hexEnv(env.AGENT5_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[5]),
      agent6: hexEnv(env.AGENT6_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[6]),
      uninformedFlow: hexEnv(
        env.FLOW_UNINFORMED_PRIVATE_KEY,
        DEFAULT_ANVIL_PRIVATE_KEYS[7],
      ),
      informedFlow: hexEnv(
        env.FLOW_INFORMED_PRIVATE_KEY,
        DEFAULT_ANVIL_PRIVATE_KEYS[8],
      ),
      setup: hexEnv(env.SETUP_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[9]),
      admin: hexEnv(env.ADMIN_PRIVATE_KEY, deriveRoleKey("admin")),
      keeper: hexEnv(env.KEEPER_PRIVATE_KEY, deriveRoleKey("keeper")),
    },
  };
}

function parseEnabledProtocols(value: string | undefined): ProtocolId[] {
  if (!value || value.trim() === "") return [...ALL_PROTOCOLS];
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ProtocolId[];
  const invalid = ids.filter((id) => !ALL_PROTOCOLS.includes(id));
  if (invalid.length > 0)
    throw new Error(
      `unknown protocol in ENABLED_PROTOCOLS: ${invalid.join(", ")}`,
    );
  return ids;
}

function deriveRoleKey(role: string): Hex {
  return keccak256(stringToBytes(`eris-role:${role}`));
}

export function loadAgents(path: string): AgentSpec[] {
  if (!existsSync(path)) return defaultAgents();
  const text = readFileSync(path, "utf8");
  // ADR 0013: ロスターは JSON / YAML どちらも可（拡張子で判定）。
  const parsed =
    path.endsWith(".yaml") || path.endsWith(".yml")
      ? parseYaml(text)
      : JSON.parse(text);
  return validateAgentsFile(parsed, path);
}

export function privateKeyForWalletName(
  config: SimConfig,
  wallet: string,
  agentId: string,
): Hex {
  switch (wallet) {
    case "AGENT0_PRIVATE_KEY":
      return config.privateKeys.agent0;
    case "AGENT1_PRIVATE_KEY":
      return config.privateKeys.agent1;
    case "AGENT2_PRIVATE_KEY":
      return config.privateKeys.agent2;
    case "AGENT3_PRIVATE_KEY":
      return config.privateKeys.agent3;
    case "AGENT4_PRIVATE_KEY":
      return config.privateKeys.agent4;
    case "AGENT5_PRIVATE_KEY":
      return config.privateKeys.agent5;
    case "AGENT6_PRIVATE_KEY":
      return config.privateKeys.agent6;
    case "AUTO":
      return deriveAutoPrivateKey(config.seed, agentId);
    default:
      throw new Error(`Unsupported wallet binding: ${wallet}`);
  }
}

function deriveAutoPrivateKey(seed: number, agentId: string): Hex {
  return keccak256(stringToBytes(`auto-wallet:${seed}:${agentId}`));
}

function defaultAgents(): AgentSpec[] {
  return validateAgentsFile(
    {
      agents: [
        {
          id: "noop",
          command: "node",
          args: ["--import", "tsx", "examples/agents/noop.ts"],
          wallet: "AGENT0_PRIVATE_KEY",
        },
        {
          id: "random",
          command: "node",
          args: ["--import", "tsx", "examples/agents/random.ts"],
          wallet: "AGENT1_PRIVATE_KEY",
        },
        {
          id: "simple",
          command: "node",
          args: ["--import", "tsx", "examples/agents/simple-rule.ts"],
          wallet: "AGENT2_PRIVATE_KEY",
        },
      ],
    },
    "default agents",
  );
}

export function validateAgentsFile(parsed: unknown, path: string): AgentSpec[] {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${path} must be a JSON object`);
  }
  const file = parsed as AgentsFile;
  if (!Array.isArray(file.agents) || file.agents.length === 0) {
    throw new Error(`${path} must contain a non-empty "agents" array`);
  }
  const seenIds = new Set<string>();
  const seenNamedWallets = new Set<string>();
  return file.agents.map((agent, index) => {
    const label = `${path} agents[${index}]`;
    if (!agent || typeof agent !== "object")
      throw new Error(`${label} must be an object`);
    if (typeof agent.id !== "string" || agent.id.trim() === "")
      throw new Error(`${label}.id must be a non-empty string`);
    if (seenIds.has(agent.id))
      throw new Error(`${path} contains duplicate agent id: ${agent.id}`);
    seenIds.add(agent.id);
    if (typeof agent.command !== "string" || agent.command.trim() === "")
      throw new Error(`${label}.command must be a non-empty string`);
    if (
      agent.args !== undefined &&
      (!Array.isArray(agent.args) ||
        !agent.args.every((arg) => typeof arg === "string"))
    ) {
      throw new Error(`${label}.args must be an array of strings`);
    }
    if (!isSupportedAgentWallet(agent.wallet)) {
      throw new Error(
        `${label}.wallet must be one of ${SUPPORTED_AGENT_WALLETS.join(", ")}`,
      );
    }
    if (agent.wallet !== "AUTO") {
      if (seenNamedWallets.has(agent.wallet)) {
        throw new Error(
          `${path} reuses named wallet ${agent.wallet}; use "AUTO" for additional agents`,
        );
      }
      seenNamedWallets.add(agent.wallet);
    }
    if (
      agent.description !== undefined &&
      typeof agent.description !== "string"
    ) {
      throw new Error(`${label}.description must be a string when present`);
    }
    if (agent.baseline !== undefined && typeof agent.baseline !== "boolean") {
      throw new Error(`${label}.baseline must be a boolean when present`);
    }
    if (agent.env !== undefined) {
      if (
        !agent.env ||
        typeof agent.env !== "object" ||
        Array.isArray(agent.env)
      ) {
        throw new Error(`${label}.env must be an object of string key/values`);
      }
      for (const [k, v] of Object.entries(agent.env)) {
        if (typeof k !== "string" || typeof v !== "string") {
          throw new Error(
            `${label}.env must contain only string keys and string values (offending key: ${k})`,
          );
        }
      }
    }
    return {
      id: agent.id,
      command: agent.command,
      args: agent.args,
      wallet: agent.wallet,
      description: agent.description,
      env: agent.env,
      baseline: agent.baseline,
    };
  });
}

function isSupportedAgentWallet(
  wallet: unknown,
): wallet is (typeof SUPPORTED_AGENT_WALLETS)[number] {
  return (
    typeof wallet === "string" &&
    SUPPORTED_AGENT_WALLETS.includes(
      wallet as (typeof SUPPORTED_AGENT_WALLETS)[number],
    )
  );
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed))
    throw new Error(`Expected integer env value, got ${value}`);
  return parsed;
}

function floatEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`Expected numeric env value, got ${value}`);
  return parsed;
}

function bigintEnv(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || value === "") return fallback;
  return BigInt(value);
}

// ADR 0013: base シンボルの「金額 env」の単位サフィックス（decimals 由来）。
// WETH(18)=WEI / WBTC(8)=SATS / それ以外=UNITS。新トークンは桁数で自動的に決まる。
export function unitSuffixFor(decimals: number): string {
  if (decimals === 18) return "WEI";
  if (decimals === 8) return "SATS";
  return "UNITS";
}

// ADR 0013: base シンボル -> 金額の Record を env から組む（per-base 配布量 / per-base limits 用）。
// WETH は wethSeed の値をそのまま使い env を読まない（既存 WETH env は呼び出し側で 1 度だけ
// 読み済み = byte 互換を保つ）。追加 base は env キー
//   <prefix>[_<SYM>]<_INFIX?>_<UNIT>   例 INITIAL_WBTC_SATS / MAX_AGENT_WBTC_IN_SATS
// を読み、未指定は 0n（USDC-only 方針 = 追加 base は既定で配らない / 上限を課さない）。
// fork 既定（WETH のみ）では {WETH: wethSeed.WETH} の 1 件のみで従来と完全一致。
function readBaseAmounts(
  env: NodeJS.ProcessEnv,
  prefix: string,
  wethSeed: Record<string, bigint>,
  infix?: string,
): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const t of baseTokens()) {
    if (t.symbol === "WETH") {
      out.WETH = wethSeed.WETH ?? 0n;
      continue;
    }
    const unit = unitSuffixFor(t.decimals);
    const key = [prefix, t.symbol, infix, unit].filter(Boolean).join("_");
    out[t.symbol] = bigintEnv(env[key], 0n);
  }
  return out;
}

function hexEnv(value: string | undefined, fallback: string): Hex {
  const result = value && value.length > 0 ? value : fallback;
  if (!/^0x[0-9a-fA-F]{64}$/.test(result))
    throw new Error("Private key must be a 0x-prefixed 32-byte hex string");
  return result as Hex;
}
