import type jsonata from 'jsonata';
import { MAX_SEQUENCE } from './limits';
import type * as NodeCrypto from 'node:crypto';

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
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')
    throw new Error(`${name}: expected a string, got ${typeof v}`);
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

/**
 * KQL string literal (R12): double-quoted with `\` and `"` escaped (and line breaks/tabs as escapes, which a quoted
 * KQL literal cannot contain raw). `$kql("O'Brien \"x\"")` → `"O'Brien \"x\""`. Numbers and booleans are quoted too;
 * a missing value throws (use a conditional to leave the clause out).
 */
export function kqlLiteral(value: unknown): string {
  if (value === undefined || value === null) throw new Error('$kql: value is missing');
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
    throw new Error(`$kql: expected a string, got ${Array.isArray(value) ? 'array' : typeof value}`);
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
  if (typeof value !== 'string' || !GUID_RE.test(value.trim()))
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

/** A query-builder condition for `filters.advanced.dialect: rows`, as the API puts it in scope (already validated). */
export interface RowsFilterCondition {
  /** Dot path into the row (`owner.displayName`). */
  path: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'guid' | 'enum';
  /** `notEmpty` (has a value; a list has an element) and `notContains` are for filters written in content. */
  op:
    | 'eq'
    | 'ne'
    | 'gt'
    | 'ge'
    | 'lt'
    | 'le'
    | 'startsWith'
    | 'contains'
    | 'notContains'
    | 'in'
    | 'notIn'
    | 'isEmpty'
    | 'notEmpty';
  value: string | number | boolean | Array<string | number | boolean> | null;
  /**
   * Compare with another field of the same row instead of `value` (`{ "path": "storageUsedInBytes", "type": "number",
   * "op": "ge", "field": "prohibitSendQuotaInBytes", "times": 0.9 }`); `times` scales a number. For filters written in
   * content, not the query builder. A row without either field matches only the negated operators (`ne`,
   * `notContains`, `notIn`), as with `value`.
   */
  field?: string;
  times?: number;
}
/** `advanced` in the expression scope of a `dialect: rows` page: conditions joined with and/or (nesting ≤ 2). */
export interface RowsFilterGroup {
  join: 'and' | 'or';
  clauses: Array<RowsFilterCondition | RowsFilterGroup>;
}

const ROWS_OPS = new Set([
  'eq',
  'ne',
  'gt',
  'ge',
  'lt',
  'le',
  'startsWith',
  'contains',
  'in',
  'isEmpty',
  'notEmpty',
  'notContains',
  'notIn',
]);
const ROWS_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * The value at a dot path (split into `keys`). A list on the way (`passwordCredentials.endDateTime`) is read item by
 * item, so the result is every value found (a condition then matches when any of them does); a single value stands
 * for itself.
 */
function readPath(row: unknown, keys: readonly string[]): unknown {
  // The usual case — fields of objects, no list on the way — without the bookkeeping.
  let v: unknown = row;
  let i = 0;
  for (; i < keys.length; i++) {
    if (v === null || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, keys[i]!)) break;
    v = (v as Record<string, unknown>)[keys[i]!];
  }
  if (i === keys.length) return v;
  if (!Array.isArray(v) || i === 0) return undefined;
  let values: unknown[] = v;
  for (; i < keys.length; i++) {
    const next: unknown[] = [];
    for (const x of values) {
      if (x === null || typeof x !== 'object' || Array.isArray(x) || !Object.hasOwn(x, keys[i]!)) continue;
      const y = (x as Record<string, unknown>)[keys[i]!];
      if (Array.isArray(y)) for (const z of y) next.push(z);
      else next.push(y);
    }
    values = next;
  }
  return values.length === 0 ? undefined : values;
}

/**
 * Parsed dates of the running `$applyAdvanced` call: report rows repeat a few hundred day values across tens of
 * thousands of rows, so each is parsed once. Reset per call (bounded).
 */
let dateMemo: Map<string, number> | undefined;

/** Comparable form of one value: lower-cased text, epoch ms for dates, numbers and booleans as they are. */
function comparable(type: RowsFilterCondition['type'], v: unknown): string | number | boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (type === 'date' && typeof v === 'string' && dateMemo) {
    let ms = dateMemo.get(v);
    if (ms === undefined) {
      ms = Date.parse(v);
      if (dateMemo.size < 50_000) dateMemo.set(v, ms);
    }
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (type === 'date') {
    // Date.parse, not new Date(): the same instant without an object per row.
    const t =
      typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? new Date(v).getTime() : Number.NaN;
    return Number.isNaN(t) ? undefined : t;
  }
  if (type === 'number') return typeof v === 'number' ? v : Number.isNaN(Number(v)) ? undefined : Number(v);
  if (type === 'boolean')
    return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
  if (typeof v === 'string') return v.toLowerCase();
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return undefined;
}

/** A condition with its path split and its values made comparable once, not once per row. */
interface Compiled {
  keys: string[];
  /** `field`: the other field's path, and its `times`. */
  other?: { keys: string[]; times: number };
  type: RowsFilterCondition['type'];
  op: RowsFilterCondition['op'];
  want: string | number | boolean | undefined;
  values: Array<string | number | boolean | undefined>;
  /** `in` / `notIn` on long lists (thousands of ids): a set, not a scan per row. */
  valueSet: Set<string | number | boolean | undefined>;
}

function compileCondition(c: RowsFilterCondition): Compiled {
  const values = (Array.isArray(c.value) ? c.value : [c.value]).map((v) => comparable(c.type, v));
  const other =
    typeof c.field === 'string'
      ? {
          keys: c.field.split('.'),
          times: typeof c.times === 'number' && Number.isFinite(c.times) ? c.times : 1,
        }
      : undefined;
  return {
    keys: c.path.split('.'),
    type: c.type,
    op: c.op,
    want: values[0],
    values,
    valueSet: new Set(values),
    ...(other ? { other } : {}),
  };
}

function matchOne(
  c: Compiled,
  op: RowsFilterCondition['op'],
  actual: unknown,
  want: string | number | boolean | undefined = c.want,
): boolean {
  const a = comparable(c.type, actual);
  if (a === undefined) return false;
  switch (op) {
    case 'eq':
      return a === want;
    case 'in':
      return c.other ? a === want : c.valueSet.has(a);
    case 'startsWith':
      return typeof a === 'string' && typeof want === 'string' && a.startsWith(want);
    case 'contains':
      return typeof a === 'string' && typeof want === 'string' && a.includes(want);
    case 'gt':
      return want !== undefined && a > want;
    case 'ge':
      return want !== undefined && a >= want;
    case 'lt':
      return want !== undefined && a < want;
    case 'le':
      return want !== undefined && a <= want;
    default:
      return false;
  }
}

const blank = (v: unknown) => v === undefined || v === null || v === '';

/** The value to compare with: the condition's own, or this row's value of `field` (× `times`). */
function wantFor(c: Compiled, row: unknown): string | number | boolean | undefined {
  if (!c.other) return c.want;
  const v = comparable(c.type, readPath(row, c.other.keys));
  return typeof v === 'number' && c.other.times !== 1 ? v * c.other.times : v;
}

function matchCondition(c: Compiled, row: unknown): boolean {
  const want = wantFor(c, row);
  const actual = readPath(row, c.keys);
  // One value (the usual case): no list to build.
  if (!Array.isArray(actual)) {
    if (c.op === 'isEmpty') return blank(actual);
    if (c.op === 'notEmpty') return !blank(actual);
    if (c.op === 'ne') return !matchOne(c, 'eq', actual, want);
    if (c.op === 'notContains') return !matchOne(c, 'contains', actual, want);
    if (c.op === 'notIn') return !matchOne(c, 'in', actual, want);
    return matchOne(c, c.op, actual, want);
  }
  const list = actual;
  if (c.op === 'isEmpty') return list.every((v) => v === undefined || v === null || v === '');
  if (c.op === 'notEmpty') return list.some((v) => v !== undefined && v !== null && v !== '');
  // A list-valued field (tags, addresses) matches when any element does; `ne` when none equals the value.
  if (c.op === 'ne') return !list.some((v) => matchOne(c, 'eq', v, want));
  // No value contains the text (a row without the field doesn't either).
  if (c.op === 'notContains') return !list.some((v) => matchOne(c, 'contains', v, want));
  if (c.op === 'notIn') return !list.some((v) => matchOne(c, 'in', v, want));
  return list.some((v) => matchOne(c, c.op, v, want));
}

function checkRowsFilter(g: unknown, depth: number): RowsFilterGroup {
  const bad = (why: string): never => {
    throw new Error(`$applyAdvanced: not a query-builder filter (${why})`);
  };
  if (!g || typeof g !== 'object' || Array.isArray(g)) return bad('expected an object');
  const { join, clauses } = g as { join?: unknown; clauses?: unknown };
  if (join !== 'and' && join !== 'or') return bad('join must be and/or');
  if (!Array.isArray(clauses)) return bad('clauses must be a list');
  for (const c of clauses as unknown[]) {
    if (c && typeof c === 'object' && 'join' in c) {
      if (depth >= 2) bad('nested too deeply');
      checkRowsFilter(c, depth + 1);
      continue;
    }
    const { path, op } = (c ?? {}) as { path?: unknown; op?: unknown };
    if (typeof path !== 'string' || !ROWS_PATH.test(path)) bad('invalid path');
    if (typeof op !== 'string' || !ROWS_OPS.has(op)) bad('invalid operator');
    const { field } = c as { field?: unknown };
    if (field !== undefined && (typeof field !== 'string' || !ROWS_PATH.test(field))) bad('invalid field');
    const { times } = c as { times?: unknown };
    if (times !== undefined && (field === undefined || typeof times !== 'number' || !Number.isFinite(times)))
      bad('times needs a field and a finite number');
  }
  return g as RowsFilterGroup;
}

type Matcher = (row: unknown) => boolean;

/** The filter as one function over a row: every condition compiled once (applyAdvanced runs it on every row). */
function compileGroup(g: RowsFilterGroup): Matcher {
  const tests: Matcher[] = g.clauses.map((c) => {
    if ('join' in c) return compileGroup(c);
    const compiled = compileCondition(c);
    return (row) => matchCondition(compiled, row);
  });
  return g.join === 'and' ? (row) => tests.every((f) => f(row)) : (row) => tests.some((f) => f(row));
}

/**
 * Rows that match the query builder's filter (`filters.advanced.dialect: rows`): `$applyAdvanced(rows, advanced)` in
 * a datasource transform. No filter (`advanced` undefined/null) returns the rows unchanged. Text comparisons ignore
 * case; dates compare as instants; a row without the field matches only the negated operators (`ne`, `notContains`,
 * `notIn`) — and `isEmpty`. `isEmpty` / `notEmpty` look at plain values (a list counts its items; an object is never
 * empty). Content may also pass a filter of
 * its own (`{ "join": "and", "clauses": [{ "path": "accountEnabled", "type": "boolean", "op": "eq", "value": true }] }`):
 * it runs natively, so filtering tens of thousands of rows costs milliseconds instead of JSONata's ~15 µs a row.
 */
export function applyAdvanced(rows: unknown, filter: unknown): unknown[] {
  const list = rows === undefined || rows === null ? [] : Array.isArray(rows) ? rows : [rows];
  if (filter === undefined || filter === null) return [...list];
  const match = compileGroup(checkRowsFilter(filter, 1));
  dateMemo = new Map();
  try {
    return list.filter(match);
  } finally {
    dateMemo = undefined;
  }
}

/**
 * `$withFields(rows, { "state": "never" })`: every object row with these fields added (or replaced) — natively, where
 * `rows.$merge([$, {…}])` costs ~15 µs a row in JSONata. Non-object items pass through; the input isn't changed.
 */
export function withFields(rows: unknown, fields: unknown): unknown[] {
  const list = rows === undefined || rows === null ? [] : Array.isArray(rows) ? rows : [rows];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    throw new Error('$withFields: the fields must be an object');
  for (const [k, v] of Object.entries(fields)) {
    // JSONata's internal flags and functions (a lambda would leave the expression's sandbox in the result).
    if (k.startsWith('_jsonata')) throw new Error(`$withFields: "${k}" can't be a field name`);
    if (
      typeof v === 'function' ||
      (v && typeof v === 'object' && ('_jsonata_lambda' in v || '_jsonata_function' in v))
    )
      throw new Error(`$withFields: "${k}" can't be a function`);
  }
  if (list.length > MAX_SEQUENCE) throw new Error(`$withFields: at most ${MAX_SEQUENCE} rows`);
  return list.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? { ...r, ...fields } : r));
}

/**
 * `$take(rows, n)`: the first `n` items — natively, where `rows[[0..n-1]]` on a variable is quadratic in JSONata (it
 * tests every item against the whole range).
 */
export function take(rows: unknown, n: unknown): unknown[] {
  const list = rows === undefined || rows === null ? [] : Array.isArray(rows) ? rows : [rows];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0)
    throw new Error('$take: n must be a whole number ≥ 0');
  return list.slice(0, n);
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

export const HELPER_NAMES = [
  'encode',
  'odata',
  'odataSearch',
  'guid',
  'daysAgo',
  'iso',
  'daysUntil',
  'kql',
  'uuid',
  'secureRandom',
  'applyAdvanced',
  'withFields',
  'take',
] as const;

/** Registers the helpers on a compiled expression. */
export function registerHelpers(expr: jsonata.Expression): void {
  expr.registerFunction('encode', (v: unknown) => encodePathSegment(v));
  expr.registerFunction('odata', (v: unknown) => odataLiteral(v));
  expr.registerFunction('odataSearch', (v: unknown) => odataSearchEscape(v));
  expr.registerFunction('guid', (v: unknown) => assertGuid(v));
  expr.registerFunction('kql', (v: unknown) => kqlLiteral(v));
  expr.registerFunction('uuid', () => newUuid());
  expr.registerFunction('secureRandom', (length: unknown, alphabet?: unknown) =>
    secureRandom(length, alphabet ?? SECURE_RANDOM_ALPHABET),
  );
  expr.registerFunction('daysAgo', function (this: jsonata.Focus, n: unknown) {
    return daysAgo(n, scopeNow(this));
  });
  expr.registerFunction('iso', function (this: jsonata.Focus, v?: unknown) {
    return toIso(v, scopeNow(this));
  });
  expr.registerFunction('daysUntil', function (this: jsonata.Focus, v: unknown) {
    return daysUntil(v, scopeNow(this));
  });
  expr.registerFunction('applyAdvanced', (rows: unknown, filter: unknown) => applyAdvanced(rows, filter));
  expr.registerFunction('withFields', (rows: unknown, fields: unknown) => withFields(rows, fields), '<xo:a>');
  expr.registerFunction('take', (rows: unknown, n: unknown) => take(rows, n));
}
