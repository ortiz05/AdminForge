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

interface Entry<V> {
  value: V;
  cachedAt: Date;
  expiresAt: number;
}

/**
 * Small TTL + LRU cache for datasource results. Keys always include the user (or automation identity) and the mode:
 * delegated results differ per user, so nothing is ever shared between users (§4.3).
 */
export class TtlCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  constructor(
    private readonly max = 1000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(key: string): { value: V; cachedAt: Date } | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now().getTime()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return { value: e.value, cachedAt: e.cachedAt };
  }

  set(key: string, value: V, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;
    const now = this.now();
    this.map.delete(key);
    this.map.set(key, { value, cachedAt: now, expiresAt: now.getTime() + ttlSeconds * 1000 });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
