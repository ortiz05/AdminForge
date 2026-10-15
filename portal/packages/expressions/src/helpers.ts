import type jsonata from 'jsonata';

/**
 * Helper functions available in every expression (§7.6). Each is also exported as a plain function so server code
 * (e.g. the query-builder compiler) quotes values exactly the same way.
 */

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

const preview = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

function requireValue(name: string, v: unknown): string | number | boolean {
  if (v === undefined || v === null || v === '') throw new Error(`${name}: value is missing`);
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new Error(`${name}: expected a string, got ${typeof v}`);
  return v;
}

/** URL path segment: percent-encodes everything outside the unreserved set; refuses empty, "." and "..". */
export function encodePathSegment(value: unknown): string {
  const s = String(requireValue('$encode', value));
  if (s === '.' || s === '..') throw new Error(`$encode: "${s}" is not a valid path segment`);
  return encodeURIComponent(s);
}

/** Quoted OData string literal: O'Brien → 'O''Brien'. */
export function odataLiteral(value: unknown): string {
  return `'${String(requireValue('$odata', value)).replaceAll("'", "''")}'`;
}

/** Escapes `\` and `"` for use inside a quoted Graph `$search` clause. */
export function odataSearchEscape(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(requireValue('$odataSearch', value)).replace(/[\\"]/g, (c) => `\\${c}`);
}

/** Validates a GUID and returns it lower-cased; throws otherwise. */
export function assertGuid(value: unknown): string {
  if (typeof value !== 'string' || !GUID_RE.test(value.trim())) throw new Error(`$guid: not a valid GUID: ${preview(value)}`);
  return value.trim().toLowerCase();
}

function toDate(value: unknown, name: string): Date {
  const d = value instanceof Date ? value : typeof value === 'number' || typeof value === 'string' ? new Date(value) : undefined;
  if (!d || Number.isNaN(d.getTime())) throw new Error(`${name}: not a valid date: ${preview(value)}`);
  return d;
}

/** ISO timestamp `days` before `now`. */
export function daysAgo(days: unknown, now: Date = new Date()): string {
  if (typeof days !== 'number' || !Number.isFinite(days)) throw new Error(`$daysAgo: expected a number of days, got ${preview(days)}`);
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

/** ISO 8601 string for a date, epoch milliseconds or date string; no argument → now. */
export function toIso(value?: unknown, now: Date = new Date()): string {
  return value === undefined ? now.toISOString() : toDate(value, '$iso').toISOString();
}

/** Whole days from `now` until the date (negative when past). */
export function daysUntil(value: unknown, now: Date = new Date()): number {
  return Math.floor((toDate(value, '$daysUntil').getTime() - now.getTime()) / DAY_MS);
}

/** `now` from the evaluation scope when present (tests, consistent run timestamps), else the clock. */
function scopeNow(focus: jsonata.Focus | undefined): Date {
  const root = focus?.environment?.lookup('$') as { now?: unknown } | undefined;
  const now = root && typeof root === 'object' ? root.now : undefined;
  if (now instanceof Date) return now;
  if (typeof now === 'string' || typeof now === 'number') {
    const d = new Date(now);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export const HELPER_NAMES = ['encode', 'odata', 'odataSearch', 'guid', 'daysAgo', 'iso', 'daysUntil'] as const;

/** Registers the helpers on a compiled expression. */
export function registerHelpers(expr: jsonata.Expression): void {
  expr.registerFunction('encode', (v: unknown) => encodePathSegment(v));
  expr.registerFunction('odata', (v: unknown) => odataLiteral(v));
  expr.registerFunction('odataSearch', (v: unknown) => odataSearchEscape(v));
  expr.registerFunction('guid', (v: unknown) => assertGuid(v));
  expr.registerFunction('daysAgo', function (this: jsonata.Focus, n: unknown) {
    return daysAgo(n, scopeNow(this));
  });
  expr.registerFunction('iso', function (this: jsonata.Focus, v?: unknown) {
    return toIso(v, scopeNow(this));
  });
  expr.registerFunction('daysUntil', function (this: jsonata.Focus, v: unknown) {
    return daysUntil(v, scopeNow(this));
  });
}
