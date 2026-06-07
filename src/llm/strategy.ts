import { Script, createContext } from "node:vm";
import { encodeFunctionData, parseUnits, formatUnits } from "viem";
import type { AgentAction, AgentObservation } from "../types.js";
import { parseAction } from "../action.js";

export type Strategy = {
  version: number;
  notes: string;
  params: Record<string, unknown>;
  executorTs: string;
};

export type ExecutorHelpers = {
  parseUnits: typeof parseUnits;
  formatUnits: typeof formatUnits;
  encodeFunctionData: typeof encodeFunctionData;
  ADDRESSES: {
    USDC: `0x${string}`;
    WETH: `0x${string}`;
    UNIV3_POOL_500: `0x${string}`;
    SWAP_ROUTER: `0x${string}`;
    QUOTER_V2: `0x${string}`;
    NFT_POSITION_MANAGER: `0x${string}`;
    AAVE_POOL: `0x${string}`;
  };
  log: (msg: string) => void;
};

export const DEFAULT_ADDRESSES: ExecutorHelpers["ADDRESSES"] = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  UNIV3_POOL_500: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
  SWAP_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  QUOTER_V2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  NFT_POSITION_MANAGER: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  AAVE_POOL: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
};

export type StrategyParseError = { ok: false; reason: string };
export type StrategyParseOk = { ok: true; strategy: Strategy };
export type StrategyParseResult = StrategyParseOk | StrategyParseError;

/**
 * Validate a Claude tool-use payload against the Strategy schema.
 * - notes: non-empty string
 * - params: object (JSON-serializable)
 * - executor_ts: string, must parse as a function body without syntax errors
 */
/**
 * Validate a strategist payload against the Strategy schema.
 *
 * Change-contract / params-only enforcement (ADR 0002): when `prev` is given and
 * the payload's `change_type` is not "executor_logic", the previous executor is
 * kept and the model's executor_ts is ignored. This structurally prevents
 * hallucinated executor rewrites (the model can still tune params). Callers that
 * omit `prev` (e.g. init, unit tests) get the legacy behavior: executor_ts required.
 */
export function parseStrategyFromToolInput(
  input: unknown,
  version: number,
  prev?: Strategy,
): StrategyParseResult {
  if (!input || typeof input !== "object")
    return { ok: false, reason: "tool input must be an object" };
  const obj = input as Record<string, unknown>;
  if (typeof obj.notes !== "string" || obj.notes.trim() === "")
    return { ok: false, reason: "notes must be a non-empty string" };
  if (
    !obj.params ||
    typeof obj.params !== "object" ||
    Array.isArray(obj.params)
  ) {
    return { ok: false, reason: "params must be a plain object" };
  }
  // params must be JSON-serializable
  try {
    JSON.parse(JSON.stringify(obj.params));
  } catch {
    return { ok: false, reason: "params must be JSON-serializable" };
  }

  const changeType: "params_only" | "executor_logic" =
    obj.change_type === "executor_logic" ? "executor_logic" : "params_only";
  const provided = typeof obj.executor_ts === "string" ? obj.executor_ts : "";

  let executorTs: string;
  if (changeType === "params_only" && prev) {
    // params-only: 前版の executor を保持し、モデルの executor_ts は無視する。
    executorTs = prev.executorTs;
  } else {
    if (provided.trim() === "") {
      return { ok: false, reason: "executor_ts must be a non-empty string" };
    }
    const syntaxCheck = checkExecutorSyntax(provided);
    if (!syntaxCheck.ok) return syntaxCheck;
    executorTs = provided;
  }

  return {
    ok: true,
    strategy: {
      version,
      notes: obj.notes,
      params: obj.params as Record<string, unknown>,
      executorTs,
    },
  };
}

/**
 * Verify the executor source compiles. We wrap it in a function and try to construct it.
 * `new Function` throws on syntax errors but does not execute the body.
 */
export function checkExecutorSyntax(
  source: string,
): { ok: true } | StrategyParseError {
  try {
    // Wrap exactly the way runExecutor wraps it so the parser sees the same shape.
    new Function("obs", "params", "helpers", source);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `executor_ts syntax error: ${errorMessage(error)}`,
    };
  }
}

export type ExecutorRunOk = { ok: true; action: AgentAction; logs: string[] };
export type ExecutorRunError = { ok: false; reason: string; logs: string[] };
export type ExecutorRunResult = ExecutorRunOk | ExecutorRunError;

/**
 * Evaluate strategy.executorTs in a sandboxed vm context.
 * - timeout: hard cap on execution time (ms)
 * - The wrapped expression must assign its result to __result.
 * - We pre-validate via parseAction so executor bugs are caught locally before stdout.
 */
export function runExecutor(
  strategy: Strategy,
  obs: AgentObservation,
  helpersBase: Omit<ExecutorHelpers, "log">,
  timeoutMs = 200,
): ExecutorRunResult {
  const logs: string[] = [];
  const helpers: ExecutorHelpers = {
    ...helpersBase,
    log: (msg: string) => {
      if (typeof msg === "string" && logs.length < 32)
        logs.push(msg.slice(0, 500));
    },
  };
  const ctx = createContext({
    obs,
    params: strategy.params,
    helpers,
    __result: undefined,
    console: { log: helpers.log },
  });
  const wrapped = `__result = ((obs, params, helpers) => { ${strategy.executorTs} })(obs, params, helpers);`;
  try {
    new Script(wrapped, {
      filename: `strategy-v${strategy.version}.executor.js`,
    }).runInContext(ctx, {
      timeout: timeoutMs,
      displayErrors: true,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `executor threw: ${errorMessage(error)}`,
      logs,
    };
  }
  if ((ctx as { __result: unknown }).__result === undefined) {
    return {
      ok: false,
      reason: "executor returned undefined (must return AgentAction)",
      logs,
    };
  }
  let action: AgentAction;
  try {
    action = parseAction((ctx as { __result: unknown }).__result);
  } catch (error) {
    return {
      ok: false,
      reason: `invalid AgentAction: ${errorMessage(error)}`,
      logs,
    };
  }
  return { ok: true, action, logs };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
