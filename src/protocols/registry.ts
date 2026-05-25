import type { LeafAction, ProtocolId } from "../types.js";
import type { ProtocolAdapter } from "./types.js";
import { uniswapAdapter } from "./uniswap.js";
import { balancerAdapter } from "./balancer.js";
import { curveAdapter } from "./curve.js";

// 全 adapter（実装済みのみ登録）。フェーズ進行に伴い追加する。
const ALL_ADAPTERS: ProtocolAdapter[] = [
  uniswapAdapter,
  balancerAdapter,
  curveAdapter,
];

const ALL_BY_ID = new Map<ProtocolId, ProtocolAdapter>(
  ALL_ADAPTERS.map((a) => [a.id, a]),
);

export const ALL_PROTOCOL_IDS: ProtocolId[] = [
  "uniswap",
  "balancer",
  "curve",
  "gmx",
  "aave",
];

// coordinator が起動時に設定。未設定時は実装済み全 adapter を有効とみなす。
let enabledIds: ProtocolId[] = ALL_ADAPTERS.map((a) => a.id);

export function setEnabledProtocols(ids: ProtocolId[]): void {
  const filtered = ids.filter((id) => ALL_BY_ID.has(id));
  enabledIds = filtered.length > 0 ? filtered : ALL_ADAPTERS.map((a) => a.id);
}

export function enabledAdapters(): ProtocolAdapter[] {
  return enabledIds.map((id) => ALL_BY_ID.get(id)!).filter(Boolean);
}

export function getAdapter(id: ProtocolId): ProtocolAdapter {
  const adapter = ALL_BY_ID.get(id);
  if (!adapter) throw new Error(`adapter not implemented: ${id}`);
  return adapter;
}

export function hasAdapter(id: ProtocolId): boolean {
  return ALL_BY_ID.has(id);
}

// leaf アクションの type からそれを所有する adapter / protocol を解決する。
// 各 adapter の parse を試し、最初に非 null を返したものを採用。
export function adapterForAction(action: LeafAction): ProtocolAdapter {
  for (const adapter of enabledAdapters()) {
    const parsed = adapter.parse({ ...action });
    if (parsed) return adapter;
  }
  throw new Error(
    `no adapter owns action type: ${(action as { type: string }).type}`,
  );
}

export function protocolForAction(action: LeafAction): ProtocolId {
  return adapterForAction(action).id;
}
