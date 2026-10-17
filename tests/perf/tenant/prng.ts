/**
 * Seeded, dependency-free randomness for the synthetic tenant (tests/perf/tenant/generate.ts): the same seed always
 * builds the same tenant, so perf budgets compare like with like. `hash32` derives a value from an index alone (lazy
 * collections such as sign-ins generate item N without generating items 0…N-1).
 */

/** mulberry32: small, fast, good enough for test data (not for anything security-related). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit hash of (seed, index…): the lazy collections' randomness. */
export function hash32(seed: number, ...parts: number[]): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const p of parts) {
    h = Math.imul(h ^ (p >>> 0), 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
  }
  return h >>> 0;
}

/** hash32 as a float in [0, 1). */
export const unit = (seed: number, ...parts: number[]) => hash32(seed, ...parts) / 4294967296;

export class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)]!;
  }
  /** Picks by weight: `[[value, weight], …]`. */
  weighted<T>(choices: ReadonlyArray<readonly [T, number]>): T {
    const total = choices.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of choices) {
      r -= w;
      if (r < 0) return v;
    }
    return choices[choices.length - 1]![0];
  }
  /** A power-law-ish size: most small, a few large (min…max). */
  skewed(min: number, max: number, exponent = 3): number {
    return Math.floor(min + (max - min) * this.next() ** exponent);
  }
}

/** A deterministic GUID from (namespace, index): stable ids across runs, version-4 shaped, synthetic only. */
export function guid(namespace: number, index: number): string {
  const a = hash32(namespace, index, 1);
  const b = hash32(namespace, index, 2);
  const c = hash32(namespace, index, 3);
  const d = hash32(namespace, index, 4);
  const hex = (n: number, len = 8) => n.toString(16).padStart(8, '0').slice(0, len);
  return `${hex(a)}-${hex(b, 4)}-4${hex(b >>> 16, 3)}-${(8 + (c & 3)).toString(16)}${hex(c >>> 4, 3)}-${hex(d)}${hex(c, 4)}`;
}
