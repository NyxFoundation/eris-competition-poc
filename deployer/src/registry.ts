import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";
import { ROOT } from "./util.js";
import { CHAIN_ID, RPC_URL } from "./config.js";

const OUT_DIR = resolve(ROOT, "deployments");
const OUT_FILE = resolve(OUT_DIR, "deployments.json");

export type Deployments = {
  chainId: number;
  rpcUrl: string;
  updatedAt: string;
  tokens: Record<string, Address>;
  protocols: Record<string, Record<string, unknown>>;
};

function empty(): Deployments {
  return {
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    updatedAt: new Date().toISOString(),
    tokens: {},
    protocols: {},
  };
}

let state: Deployments = load();

function load(): Deployments {
  if (existsSync(OUT_FILE)) {
    try {
      return JSON.parse(readFileSync(OUT_FILE, "utf8")) as Deployments;
    } catch {
      /* 壊れていれば作り直す */
    }
  }
  return empty();
}

export function getRegistry(): Deployments {
  return state;
}

export function setTokens(tokens: Record<string, Address>) {
  state.tokens = { ...state.tokens, ...tokens };
  flush();
}

export function setProtocol(name: string, data: Record<string, unknown>) {
  state.protocols[name] = { ...(state.protocols[name] ?? {}), ...data };
  flush();
}

export function token(key: string): Address {
  const a = state.tokens[key];
  if (!a) throw new Error(`token not in registry: ${key}`);
  return a;
}

export function flush() {
  mkdirSync(OUT_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(OUT_FILE, JSON.stringify(state, null, 2));
}

/** 全消し (フレッシュデプロイ開始時) */
export function reset() {
  state = empty();
  flush();
}
