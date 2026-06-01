export class Rng {
  private state: number;
  private spareGaussian: number | null = null;

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

  gaussian(): number {
    if (this.spareGaussian !== null) {
      const z = this.spareGaussian;
      this.spareGaussian = null;
      return z;
    }
    let u: number, v: number, s: number;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    this.spareGaussian = v * factor;
    return u * factor;
  }

  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > L);
    return k - 1;
  }

  lognormal(meanX: number, sigma: number): number {
    const muNormal = Math.log(meanX) - (sigma * sigma) / 2;
    return Math.exp(muNormal + sigma * this.gaussian());
  }

  uniform(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

export function nextFairPrice(current: number, rng: Rng, sigmaPerStep: number): number {
  return current * Math.exp(-(sigmaPerStep * sigmaPerStep) / 2 + sigmaPerStep * rng.gaussian());
}
