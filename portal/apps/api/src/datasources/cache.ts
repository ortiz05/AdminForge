import { createHash } from 'node:crypto';

/** Stable JSON (sorted keys) for cache keys. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export const cacheKey = (parts: unknown[]) => createHash('sha256').update(canonicalJson(parts)).digest('hex');

/**
 * Rough size of a value in bytes (UTF-16 strings, 8-byte numbers, a little per key and slot). Long arrays and wide
 * objects are sampled — 64 items or entries spread over the whole of them, extrapolated — so measuring a 100k-row
 * result costs microseconds, not a serialisation, and a few small rows at the front can't hide large ones behind.
 * Past the node budget, values count at the average size measured so far rather than as nothing.
 */
export function approximateBytes(value: unknown, budget = 20_000): number {
  const SAMPLE = 64;
  let seen = 0;
  let leafBytes = 0;
  let leaves = 0;
  const leaf = (bytes: number) => {
    leafBytes += bytes;
    leaves++;
    return bytes;
  };
  /** Evenly spread indexes 0…n-1 (all of them when n ≤ SAMPLE). */
  const picks = (n: number) =>
    n <= SAMPLE
      ? Array.from({ length: n }, (_, i) => i)
      : Array.from({ length: SAMPLE }, (_, i) => Math.floor((i * n) / SAMPLE));
  const walk = (v: unknown, depth: number): number => {
    if (++seen > budget || depth > 32) return leaves ? leafBytes / leaves : 16;
    if (v === null || v === undefined) return 8;
    switch (typeof v) {
      case 'string':
        return leaf(16 + v.length * 2);
      case 'number':
      case 'boolean':
        return leaf(8);
      case 'object': {
        if (Array.isArray(v)) {
          const n = v.length;
          if (n === 0) return 16;
          const at = picks(n);
          let sum = 0;
          for (const i of at) sum += walk(v[i], depth + 1);
          return 16 + Math.round((sum / at.length) * n) + n * 8;
        }
        const entries = Object.entries(v as Record<string, unknown>);
        const n = entries.length;
        if (n === 0) return 16;
        const at = picks(n);
        let sum = 0;
        for (const i of at) {
          const [k, val] = entries[i]!;
          sum += 16 + k.length * 2 + walk(val, depth + 1);
        }
        return 16 + Math.round((sum / at.length) * n);
      }
      default:
        return 8;
    }
  };
  return Math.round(walk(value, 0));
}

interface Entry<V> {
  value: V;
  cachedAt: Date;
  expiresAt: number;
  bytes: number;
  /** What the entry belongs to (`kind:key` of its definition), for invalidating one definition. */
  tag?: string;
}

/**
 * Small TTL + LRU cache for datasource results, capped by entries and by approximate bytes. Keys always include the
 * user (or automation identity) and the mode: delegated results differ per user, so nothing is ever shared between
 * users (§4.3). An entry larger than a quarter of the byte cap is not kept.
 */
export class TtlCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private bytes = 0;
  constructor(
    private readonly max = 1000,
    private readonly now: () => Date = () => new Date(),
    private readonly maxBytes = 256 * 1024 * 1024,
  ) {}

  get(key: string): { value: V; cachedAt: Date } | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now().getTime()) {
      this.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return { value: e.value, cachedAt: e.cachedAt };
  }

  set(key: string, value: V, ttlSeconds: number, opts: { tag?: string; bytes?: number } = {}): void {
    if (ttlSeconds <= 0) return;
    const bytes = opts.bytes ?? approximateBytes(value);
    this.delete(key);
    if (bytes > this.maxBytes / 4) return;
    const now = this.now();
    this.map.set(key, {
      value,
      cachedAt: now,
      expiresAt: now.getTime() + ttlSeconds * 1000,
      bytes,
      ...(opts.tag ? { tag: opts.tag } : {}),
    });
    this.bytes += bytes;
    while (this.map.size > this.max || this.bytes > this.maxBytes) this.delete(this.map.keys().next().value!);
  }

  delete(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    this.bytes -= e.bytes;
  }

  /** Drops every entry with this tag (one definition changed). */
  deleteTag(tag: string): void {
    for (const [k, e] of this.map) if (e.tag === tag) this.delete(k);
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  /** Approximate bytes held (tests and metrics). */
  get approximateSize(): number {
    return this.bytes;
  }
}

/**
 * One in-flight promise per key: identical concurrent requests share a single execution. The shared work gets its
 * own abort signal, which fires only when every caller waiting for it has gone (aborted); each caller still stops
 * waiting as soon as its own signal aborts.
 */
export class Inflight<V> {
  private readonly flights = new Map<
    string,
    { promise: Promise<V>; controller: AbortController; waiting: number }
  >();

  run(key: string, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<V>): Promise<V> {
    // A caller that has already gone neither starts work nor joins it.
    if (signal?.aborted) return Promise.reject(signal.reason);
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const promise = work(controller.signal).finally(() => {
        if (this.flights.get(key)?.promise === promise) this.flights.delete(key);
      });
      promise.catch(() => undefined);
      flight = { promise, controller, waiting: 0 };
      this.flights.set(key, flight);
    }
    const f = flight;
    f.waiting++;
    if (!signal) return f.promise.finally(() => f.waiting--);
    return new Promise<V>((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return false;
        done = true;
        signal.removeEventListener('abort', onAbort);
        f.waiting--;
        return true;
      };
      const onAbort = () => {
        if (!finish()) return;
        // Nobody else is waiting: stop the work too (closed page, deadline).
        if (f.waiting === 0) {
          // A caller arriving after this starts afresh instead of joining work that is being stopped.
          if (this.flights.get(key) === f) this.flights.delete(key);
          f.controller.abort(signal.reason);
        }
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      f.promise.then(
        (v) => finish() && resolve(v),
        (e) => finish() && reject(e),
      );
    });
  }

  /** Executions in flight (tests and metrics). */
  get size(): number {
    return this.flights.size;
  }
}
