export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  int(minInclusive: number, maxExclusive: number): number {
    return Math.floor(this.next() * (maxExclusive - minInclusive)) + minInclusive;
  }

  bool(): boolean {
    return this.next() >= 0.5;
  }
}

export function nextFairPrice(current: number, rng: Rng): number {
  const drift = 0.00005;
  const volatility = 0.004;
  const shock = (rng.next() - 0.5) * 2 * volatility;
  return Math.max(100, current * (1 + drift + shock));
}
