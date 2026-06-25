// 市場ストレスイベント・オーバーレイ（ADR 0009 §1-3）。
//
// OU 価格パス（base）はそのまま進め、その上に SEED 由来でランダム化した決定論イベント・
// オーバーレイを重ねて effective price を導出する純関数群。窓外では従来通り β≈0 を保ち
// （base を汚さない）、窓内だけ鋭い乖離（spike/crash）が生まれる。effective は PriceFeed・
// Aave WETH オラクル・GMX・採点へ一貫伝播する（base/effective 分離。ADR 0007 を毀損しない）。
//
// 設計（ADR 0009 の中心論点）:
//   - イベントは WETH 倍率（wethMult）で表現する台形（ramp→hold→decay）。瞬間ジャンプは
//     オラクル更新の 1 ブロック遅延と相性が悪いため、全員が等しく 1 ブロック遅れで反応できる
//     余地を残す（公平性）。
//   - config は固定値ではなくレンジを与え、実タイミング/magnitude は SEED から決定論派生する
//     （定数の暗記を防ぎ汎化を測る。ADR 0004）。price 本路・flow と独立した Rng を使い、
//     price RNG の消費列を乱さない（再現性は SEED で維持）。
//   - depeg 用の usdcPx も返せる形にしておく（v1 は常に 1。phase 2 で可変化）。
import { Rng } from "../rng.js";
import type { TokenSymbol } from "../types.js";

export type StressEventType = "spike" | "crash";

// env（ERIS_STRESS_EVENTS）で与えるイベント仕様。値ではなくレンジを与える。
export type StressEventConfig = {
  type: StressEventType;
  // ADR 0013: イベント対象の base（既定 WETH）。WBTC 等に crash/spike を効かせられる。
  base?: TokenSymbol;
  // 価格倍率の乖離幅。spike は +、crash は − に効く。[min,max] から seed が選ぶ。
  magnitudeRange: [number, number];
  // イベント開始位置の run 長に対する割合 [min,max]。seed が選ぶ。
  windowFrac: [number, number];
  // 台形の各区間長（ブロック数。固定）。
  rampBlocks: number;
  holdBlocks: number;
  decayBlocks: number;
};

// seed で確定したイベント（blockIndex は runStart からの 0 起点）。
export type ResolvedStressEvent = {
  type: StressEventType;
  base: string; // 対象 base（既定 WETH）
  magnitude: number;
  startBlock: number;
  rampBlocks: number;
  holdBlocks: number;
  decayBlocks: number;
  endBlock: number; // startBlock + ramp + hold + decay（この値は窓に含まれない）
};

// at(blockIndex) が返すオーバーレイ。effective[base] = baseFair[base] * baseMults[base]。
// wethMult は後方互換（= baseMults["WETH"]）。usdcPx は v1 未使用。
export type OverlayState = {
  wethMult: number;
  usdcPx: number;
  baseMults: Record<string, number>;
};

// price 本路 Rng（seed）・flow Rng（flowSeed）と衝突しない派生 seed のための salt。
const STRESS_SEED_SALT = 0x53_54_52_53; // "STRS"

// 台形エンベロープ e(blockIndex) ∈ [0,1]:
//   ramp:  0 → 1（rampBlocks かけて立ち上がる）
//   hold:  1（holdBlocks）
//   decay: 1 → 0（decayBlocks かけて戻る）
//   窓外:  0
// spike は wethMult = 1 + m·e、crash は 1 − m·e。e=1 のとき乖離は最大 ±m。
function envelope(ev: ResolvedStressEvent, blockIndex: number): number {
  const t = blockIndex - ev.startBlock;
  if (t < 0) return 0;
  const { rampBlocks: r, holdBlocks: h, decayBlocks: d } = ev;
  if (t < r) return r === 0 ? 1 : (t + 1) / r; // 立ち上がり（最初の窓ブロックから効く）
  if (t < r + h) return 1; // hold
  if (t < r + h + d) return d === 0 ? 1 : 1 - (t - (r + h) + 1) / d; // 減衰
  return 0; // 窓外（endBlock 以降）
}

// 純関数の決定論スケジュール（config + seed + runBlocks → at(blockIndex)）。
// ユニットテスト対象。チェーンや I/O には一切触れない。
export class EventSchedule {
  readonly events: ResolvedStressEvent[];

  constructor(configs: StressEventConfig[], seed: number, runBlocks: number) {
    if (configs.length > 0 && runBlocks <= 0) {
      // 窓は run 長の割合で決まるため、ブロック長固定 run（ERIS_RUN_BLOCKS>0）が前提。
      throw new Error(
        "ERIS_STRESS_EVENTS requires a fixed-length run: set ERIS_RUN_BLOCKS > 0 (ADR 0009)",
      );
    }
    // price 本路・flow と独立した Rng。同じ SEED から決定論的に同一スケジュールを得る。
    const rng = new Rng((seed ^ STRESS_SEED_SALT) >>> 0);
    this.events = configs.map((c) => {
      const magnitude = lerp(
        c.magnitudeRange[0],
        c.magnitudeRange[1],
        rng.next(),
      );
      const startFrac = lerp(c.windowFrac[0], c.windowFrac[1], rng.next());
      const span = c.rampBlocks + c.holdBlocks + c.decayBlocks;
      // 窓が run 窓に収まるよう startBlock をクランプ（採点の歴史深度・event 窓⊂run 窓）。
      const maxStart = Math.max(0, runBlocks - span);
      const startBlock = Math.max(
        0,
        Math.min(Math.round(startFrac * runBlocks), maxStart),
      );
      return {
        type: c.type,
        base: c.base ?? "WETH",
        magnitude,
        startBlock,
        rampBlocks: c.rampBlocks,
        holdBlocks: c.holdBlocks,
        decayBlocks: c.decayBlocks,
        endBlock: startBlock + span,
      };
    });
  }

  hasEvents(): boolean {
    return this.events.length > 0;
  }

  // 当該 blockIndex の窓内イベント（複数重なれば最初の 1 件）。可視化/ログ用。
  activeEventAt(blockIndex: number): ResolvedStressEvent | null {
    for (const ev of this.events) {
      if (blockIndex >= ev.startBlock && blockIndex < ev.endBlock) return ev;
    }
    return null;
  }

  // 当該 blockIndex のオーバーレイ。重なるイベントは倍率を乗算合成する
  // （非重複なら各イベントがそのまま現れる）。
  at(blockIndex: number): OverlayState {
    const baseMults: Record<string, number> = {};
    for (const ev of this.events) {
      const e = envelope(ev, blockIndex);
      if (e === 0) continue;
      const sign = ev.type === "crash" ? -1 : 1;
      const cur = baseMults[ev.base] ?? 1;
      baseMults[ev.base] = cur * (1 + sign * ev.magnitude * e);
    }
    const wethMult = baseMults.WETH ?? 1;
    return { wethMult, usdcPx: 1, baseMults };
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ERIS_STRESS_EVENTS（JSON 配列）をパースして検証する。空/未設定なら []。
// 値ではなくレンジを与える仕様を厳格に検査し、誤設定は run 開始前に fail-fast させる。
export function parseStressEvents(
  json: string | undefined,
): StressEventConfig[] {
  if (json === undefined || json.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `ERIS_STRESS_EVENTS must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("ERIS_STRESS_EVENTS must be a JSON array");
  }
  return parsed.map((raw, i) => parseOne(raw, i));
}

function parseOne(raw: unknown, i: number): StressEventConfig {
  const label = `ERIS_STRESS_EVENTS[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  if (o.type !== "spike" && o.type !== "crash") {
    throw new Error(`${label}.type must be "spike" or "crash"`);
  }
  if (o.base !== undefined && typeof o.base !== "string") {
    throw new Error(`${label}.base must be a token symbol string`);
  }
  const magnitudeRange = parseRange(
    o.magnitudeRange,
    `${label}.magnitudeRange`,
    {
      min: 0,
      exclusiveMin: true,
    },
  );
  const windowFrac = parseRange(o.windowFrac, `${label}.windowFrac`, {
    min: 0,
    max: 1,
  });
  const rampBlocks = parseNonNegInt(o.rampBlocks, `${label}.rampBlocks`);
  const holdBlocks = parseNonNegInt(o.holdBlocks, `${label}.holdBlocks`);
  const decayBlocks = parseNonNegInt(o.decayBlocks, `${label}.decayBlocks`);
  if (rampBlocks + holdBlocks + decayBlocks <= 0) {
    throw new Error(
      `${label} must have a positive total window (ramp+hold+decay)`,
    );
  }
  return {
    type: o.type,
    base: typeof o.base === "string" ? o.base : undefined,
    magnitudeRange,
    windowFrac,
    rampBlocks,
    holdBlocks,
    decayBlocks,
  };
}

function parseRange(
  value: unknown,
  label: string,
  bounds: { min?: number; max?: number; exclusiveMin?: boolean },
): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    throw new Error(`${label} must be a [min, max] pair of finite numbers`);
  }
  const [lo, hi] = value as [number, number];
  if (lo > hi) throw new Error(`${label} must have min <= max`);
  if (bounds.min !== undefined) {
    if (bounds.exclusiveMin ? lo <= bounds.min : lo < bounds.min)
      throw new Error(`${label} min must be >= ${bounds.min}`);
  }
  if (bounds.max !== undefined && hi > bounds.max)
    throw new Error(`${label} max must be <= ${bounds.max}`);
  return [lo, hi];
}

function parseNonNegInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}
