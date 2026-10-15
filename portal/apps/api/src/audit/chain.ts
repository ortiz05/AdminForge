import { createHash } from 'node:crypto';

/** prev_hash of the first event. */
export const GENESIS = '0'.repeat(64);

/** Deterministic JSON: object keys sorted, `undefined` members dropped, `null` kept. */
export function canonical(v: unknown): string {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

/** hash = sha256(prev_hash || "\n" || canonical(event)). */
export function chainHash(prevHash: string, event: Record<string, unknown>): string {
  return createHash('sha256').update(prevHash).update('\n').update(canonical(event)).digest('hex');
}

export type ChainRow = Record<string, unknown> & { prevHash: string; hash: string };

/** Re-walks a chain in order; reports the index of the first row that doesn't verify. */
export function verifyChain(rows: ChainRow[], genesis = GENESIS): { ok: true } | { ok: false; brokenAt: number } {
  let prev = genesis;
  for (const [i, { prevHash, hash, ...event }] of rows.entries()) {
    if (prevHash !== prev || chainHash(prev, event) !== hash) return { ok: false, brokenAt: i };
    prev = hash;
  }
  return { ok: true };
}
