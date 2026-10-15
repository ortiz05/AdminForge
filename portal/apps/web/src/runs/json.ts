import { isRecord, type Parser } from '../lib/api';

/**
 * Small, lenient readers for API payloads. The run, schedule and audit contracts are owned by other services and
 * still settling, so the SPA reads the fields it needs, tolerates extra ones, and fails with a contract error only
 * when the core of a response is missing.
 */

export const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** First string among several candidate fields. */
export function pick(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/** A Parser that runs `fn` and turns a thrown TypeError into the api() contract error. */
export function parser<T>(fn: (input: unknown) => T): Parser<T> {
  return { parse: fn };
}

/** `{ items, cursor? }` lists (runs, audit, schedule history). */
export function listOf<T>(read: (raw: unknown) => T | null, key = 'items'): Parser<{ items: T[]; cursor: string | null }> {
  return parser((input) => {
    const o = rec(input);
    const raw = Array.isArray(input) ? input : o[key];
    if (!Array.isArray(raw)) throw new TypeError(`Expected { ${key}: [] }`);
    const items = raw.map(read).filter((x): x is T => x !== null);
    return { items, cursor: str(o.cursor) ?? str(o.nextCursor) ?? null };
  });
}

/** `?a=1&b=2` from an object, skipping empty values. */
export function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}
