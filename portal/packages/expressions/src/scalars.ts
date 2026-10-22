import { isGuid } from '@adminforge/schemas';
import type * as NodeCrypto from 'node:crypto';
import { checkGrowth, PERCENT_GROWTH } from './limits';

/**
 * The helpers that take or make one value (§7.6): path segments, OData and KQL literals, ids, random secrets and
 * dates. Split from helpers.ts (organization review O-04), which keeps the row helpers and registers them all; each is
 * also a plain function so server code (e.g. the query-builder compiler) quotes values exactly the same way.
 */

const DAY_MS = 86_400_000;

const preview = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

function requireValue(name: string, v: unknown): string | number | boolean {
  if (v === undefined || v === null || v === '') throw new Error(`${name}: value is missing`);
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')
    throw new Error(`${name}: expected a string, got ${typeof v}`);
  return v;
}

/** URL path segment: percent-encodes everything outside the unreserved set; refuses empty, "." and "..". */
export function encodePathSegment(value: unknown): string {
  const s = String(requireValue('$encode', value));
  if (s === '.' || s === '..') throw new Error(`$encode: "${s}" is not a valid path segment`);
  checkGrowth('$encode', s, PERCENT_GROWTH);
  return encodeURIComponent(s);
}

/** Quoted OData string literal: O'Brien → 'O''Brien'. */
export function odataLiteral(value: unknown): string {
  const s = String(requireValue('$odata', value));
  checkGrowth('$odata', s, 2, 2);
  return `'${s.replaceAll("'", "''")}'`;
}

/** Escapes `\` and `"` for use inside a quoted Graph `$search` clause. */
export function odataSearchEscape(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = String(requireValue('$odataSearch', value));
  checkGrowth('$odataSearch', s, 2);
  return s.replace(/[\\"]/g, (c) => `\\${c}`);
}

/**
 * KQL string literal (R12): double-quoted with `\` and `"` escaped (and line breaks/tabs as escapes, which a quoted
 * KQL literal cannot contain raw). `$kql("O'Brien \"x\"")` → `"O'Brien \"x\""`. Numbers and booleans are quoted too;
 * a missing value throws (use a conditional to leave the clause out).
 */
export function kqlLiteral(value: unknown): string {
  if (value === undefined || value === null) throw new Error('$kql: value is missing');
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
    throw new Error(`$kql: expected a string, got ${Array.isArray(value) ? 'array' : typeof value}`);
  checkGrowth('$kql', String(value), 2, 2);
  const escaped = String(value).replace(
    /[\\"\n\r\t]/g,
    (c) => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c]!,
  );
  return `"${escaped}"`;
}

/** A fresh random GUID (e.g. role assignment names). */
export function newUuid(): string {
  return globalThis.crypto.randomUUID();
}

/** Uniform integer in [0, max) from a CSPRNG. */
export type RandomInt = (max: number) => number;

/**
 * node:crypto `randomInt` on the server (looked up at runtime, so this package still bundles for the browser);
 * Web Crypto with rejection sampling (unbiased) where Node is not available.
 */
export function cryptoRandomInt(): RandomInt {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const node = proc?.getBuiltinModule?.('node:crypto') as typeof NodeCrypto | undefined;
  if (node?.randomInt) return (max) => node.randomInt(max);
  return (max) => {
    const limit = Math.floor(0x1_0000_0000 / max) * max;
    const buf = new Uint32Array(1);
    for (;;) {
      globalThis.crypto.getRandomValues(buf);
      if (buf[0]! < limit) return buf[0]! % max;
    }
  };
}

/** Upper, lower, digits and symbols Entra accepts in passwords — without look-alikes (I l 1 O 0) or shell/template-hostile characters. */
export const SECURE_RANDOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_=+?';
const CHAR_CLASSES = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/];

/**
 * A random string from a CSPRNG (`$secureRandom(24)` → an initial password). With 8 or more characters it holds at
 * least one character of every class (upper, lower, digit, symbol) present in the alphabet — Entra's complexity rule
 * for the default alphabet. `length` 1–256; a custom `alphabet` needs at least 2 distinct characters.
 */
export function secureRandom(
  length: unknown,
  alphabet: unknown = SECURE_RANDOM_ALPHABET,
  randomInt: RandomInt = cryptoRandomInt(),
): string {
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 1 || length > 256)
    throw new Error(`$secureRandom: length must be a whole number from 1 to 256, got ${preview(length)}`);
  if (typeof alphabet !== 'string')
    throw new Error(`$secureRandom: alphabet must be a string, got ${preview(alphabet)}`);
  const chars = [...new Set(alphabet)];
  if (chars.length < 2) throw new Error('$secureRandom: the alphabet needs at least 2 distinct characters');
  const pick = (from: string[]) => from[randomInt(from.length)]!;
  const out: string[] = [];
  if (length >= 8)
    for (const re of CHAR_CLASSES) {
      const members = chars.filter((c) => re.test(c));
      if (members.length && out.length < length) out.push(pick(members));
    }
  while (out.length < length) out.push(pick(chars));
  // Fisher–Yates, so the guaranteed characters are not always first.
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.join('');
}

/** Validates a GUID and returns it lower-cased; throws otherwise. */
export function assertGuid(value: unknown): string {
  if (typeof value !== 'string' || !isGuid(value.trim()))
    throw new Error(`$guid: not a valid GUID: ${preview(value)}`);
  return value.trim().toLowerCase();
}

function toDate(value: unknown, name: string): Date {
  const d =
    value instanceof Date
      ? value
      : typeof value === 'number' || typeof value === 'string'
        ? new Date(value)
        : undefined;
  if (!d || Number.isNaN(d.getTime())) throw new Error(`${name}: not a valid date: ${preview(value)}`);
  return d;
}

/** ISO timestamp `days` before `now`. */
export function daysAgo(days: unknown, now: Date = new Date()): string {
  if (typeof days !== 'number' || !Number.isFinite(days))
    throw new Error(`$daysAgo: expected a number of days, got ${preview(days)}`);
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
