import type jsonata from 'jsonata';
import { DEADLINE_BINDING, checkDeadline } from './budget';
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
    | 'notEmpty'
    | 'containsAny'
    | 'startsWithAny'
    | 'notContainsAny'
    | 'notStartsWithAny';
  /**
   * `containsAny` / `startsWithAny` / `notContainsAny` / `notStartsWithAny` (text, content filters only): `value` is a
   * list and the field matches when it contains (starts with) any of them — or, negated, none — in one pass over the
   * field instead of one clause per value.
   */
  value: string | number | boolean | Array<string | number | boolean> | null;
  /**
   * Compare with another field of the same row instead of `value` (`{ "path": "storageUsedInBytes", "type": "number",
   * "op": "ge", "field": "prohibitSendQuotaInBytes", "times": 0.9 }`); `times` scales a number. For filters written in
   * content, not the query builder. A row without either field matches only the negated operators (`ne`,
   * `notContains`, `notIn`), as with `value`.
   */
  field?: string;
  times?: number;
  /**
   * With `field` and `type: date`: compare with the other field shifted by this many days (`{ "path": "endDateTime",
   * "type": "date", "op": "gt", "field": "startDateTime", "days": 365 }` = lives longer than a year). For dates `days`
   * is used instead of `times`. A row without the other field matches as if the field itself were missing.
   */
  days?: number;
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
  'containsAny',
  'startsWithAny',
  'notContainsAny',
  'notStartsWithAny',
]);
/** Operators whose `value` is a list of texts any of which may match (never with `field`). */
const MAX_ANY_VALUES = 256;
/** Longest text in such a list (as the query builder's): their pattern stays small — 256 × 256 characters at most. */
const MAX_ANY_TEXT = 256;
/** Conditions in one filter, nested groups included (the query builder sends at most 20). */
const MAX_CONDITIONS = 64;
const ANY_OPS = new Set(['containsAny', 'startsWithAny', 'notContainsAny', 'notStartsWithAny']);
const ROWS_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** A JSONata function value: a lambda or a built-in (objects with internal flags), or a host function. */
const isLambda = (v: unknown) =>
  typeof v === 'function' ||
  (!!v && typeof v === 'object' && ('_jsonata_lambda' in v || '_jsonata_function' in v));
/** A plain data object (not a list, not a function): the only thing the native helpers read into or copy. */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !isLambda(v);

/**
 * The value at a dot path (split into `keys`). A list on the way (`passwordCredentials.endDateTime`) is read item by
 * item, so the result is every value found (a condition then matches when any of them does); a single value stands
 * for itself.
 */
function readPath(row: unknown, keys: readonly string[]): unknown {
  // The usual case — fields of objects, no list on the way — without the bookkeeping. Functions (JSONata lambdas
  // and built-ins are objects too) are never read into: their fields are the evaluator's, not data.
  let v: unknown = row;
  let i = 0;
  for (; i < keys.length; i++) {
    if (!isRecord(v) || !Object.hasOwn(v, keys[i]!)) break;
    v = v[keys[i]!];
  }
  if (i === keys.length) return v;
  if (!Array.isArray(v) || i === 0) return undefined;
  let values: unknown[] = v;
  for (; i < keys.length; i++) {
    const next: unknown[] = [];
    for (const x of values) {
      if (!isRecord(x) || !Object.hasOwn(x, keys[i]!)) continue;
      const y = x[keys[i]!];
      if (Array.isArray(y)) for (const z of y) next.push(z);
      else next.push(y);
      if (next.length > MAX_SEQUENCE) throw new Error(`a path read more than ${MAX_SEQUENCE} values`);
    }
    values = next;
  }
  return values.length === 0 ? undefined : values;
}

/**
 * Parsed dates (text → epoch ms), shared by every `$applyAdvanced` call: report rows repeat a few hundred day values
 * across tens of thousands of rows and one transform filters the same rows several times, so each value is parsed
 * once. A pure function of the text, bounded (cleared when full).
 */
const dateMemo = new Map<string, number>();
const DATE_MEMO_MAX = 200_000;

/** Comparable form of one value: lower-cased text, epoch ms for dates, numbers and booleans as they are. */
function comparable(type: RowsFilterCondition['type'], v: unknown): string | number | boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (type === 'date' && typeof v === 'string') {
    let ms = dateMemo.get(v);
    if (ms === undefined) {
      ms = Date.parse(v);
      // Bounded by entries and by size: an ISO timestamp is at most ~35 characters.
      if (v.length <= 40) {
        if (dateMemo.size >= DATE_MEMO_MAX) dateMemo.clear();
        dateMemo.set(v, ms);
      }
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
  /** `field`: the other field's path, its `times` (numbers) and its `days` shift (dates, in ms). */
  other?: { keys: string[]; times: number; shift: number };
  type: RowsFilterCondition['type'];
  op: RowsFilterCondition['op'];
  want: string | number | boolean | undefined;
  values: Array<string | number | boolean | undefined>;
  /** `in` / `notIn` on long lists (thousands of ids): a set, not a scan per row. */
  valueSet: Set<string | number | boolean | undefined>;
  /**
   * `containsAny` / `startsWithAny` (and their negations): one expression of the escaped texts — an alternation of
   * literals, linear in the text — tested against the lower-cased value, ~3× faster than one `includes` per text.
   */
  anyRe?: RegExp;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The texts of a `containsAny`-style condition as one pattern; never echoes them (they can be long). */
function anyPattern(texts: string[], prefix: boolean): RegExp {
  try {
    return new RegExp(prefix ? `^(?:${texts.join('|')})` : texts.join('|'));
  } catch {
    throw new Error('containsAny / startsWithAny: the texts could not be compiled');
  }
}

function compileCondition(c: RowsFilterCondition, budget?: Budget): Compiled {
  const given = Array.isArray(c.value) ? c.value : [c.value];
  // `in` lists can hold every id of a collection: made comparable with the budget checked on the way.
  const values: Compiled['values'] = new Array(given.length);
  for (let i = 0; i < given.length; i++) {
    if (i > 0 && i % DEADLINE_STRIDE === 0) checkBudget(budget);
    values[i] = comparable(c.type, given[i]);
  }
  const other =
    typeof c.field === 'string'
      ? {
          keys: c.field.split('.'),
          times: typeof c.times === 'number' && Number.isFinite(c.times) ? c.times : 1,
          shift:
            c.type === 'date' && typeof c.days === 'number' && Number.isFinite(c.days)
              ? c.days * 86_400_000
              : 0,
        }
      : undefined;
  const texts = values.filter((v): v is string => typeof v === 'string').map(escapeRegExp);
  const anyRe =
    texts.length && (c.op === 'containsAny' || c.op === 'notContainsAny')
      ? anyPattern(texts, false)
      : texts.length && (c.op === 'startsWithAny' || c.op === 'notStartsWithAny')
        ? anyPattern(texts, true)
        : undefined;
  return {
    keys: c.path.split('.'),
    type: c.type,
    op: c.op,
    want: values[0],
    values,
    valueSet: new Set(values),
    ...(other ? { other } : {}),
    ...(anyRe ? { anyRe } : {}),
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
    case 'containsAny':
    case 'startsWithAny':
      return typeof a === 'string' && c.anyRe !== undefined && c.anyRe.test(a);
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
  if (typeof v !== 'number') return v;
  if (c.other.shift) return v + c.other.shift;
  return c.other.times !== 1 ? v * c.other.times : v;
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
    if (c.op === 'notContainsAny') return !matchOne(c, 'containsAny', actual, want);
    if (c.op === 'notStartsWithAny') return !matchOne(c, 'startsWithAny', actual, want);
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
  if (c.op === 'notContainsAny') return !list.some((v) => matchOne(c, 'containsAny', v, want));
  if (c.op === 'notStartsWithAny') return !list.some((v) => matchOne(c, 'startsWithAny', v, want));
  return list.some((v) => matchOne(c, c.op, v, want));
}

/**
 * A query-builder filter, checked before it is compiled: and/or groups nested at most twice, at most
 * `MAX_CONDITIONS` conditions, known paths and operators. `where` names the caller (and the filter) in errors.
 */
function checkRowsFilter(filter: unknown, where = '$applyAdvanced'): RowsFilterGroup {
  const bad = (why: string): never => {
    throw new Error(`${where}: not a query-builder filter (${why})`);
  };
  let conditions = 0;
  const check = (g: unknown, depth: number): void => {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return bad('expected an object');
    const { join, clauses } = g as { join?: unknown; clauses?: unknown };
    if (join !== 'and' && join !== 'or') return bad('join must be and/or');
    if (!Array.isArray(clauses)) return bad('clauses must be a list');
    for (const c of clauses as unknown[]) {
      if (c && typeof c === 'object' && 'join' in c) {
        if (depth >= 2) bad('nested too deeply');
        check(c, depth + 1);
        continue;
      }
      if (++conditions > MAX_CONDITIONS) bad(`at most ${MAX_CONDITIONS} conditions`);
      const { path, op } = (c ?? {}) as { path?: unknown; op?: unknown };
      if (typeof path !== 'string' || !ROWS_PATH.test(path)) bad('invalid path');
      if (typeof op !== 'string' || !ROWS_OPS.has(op)) bad('invalid operator');
      const { field } = c as { field?: unknown };
      if (field !== undefined && (typeof field !== 'string' || !ROWS_PATH.test(field))) bad('invalid field');
      if (ANY_OPS.has(op as string)) {
        const { value, type: t } = c as { value?: unknown; type?: unknown };
        if (field !== undefined) bad(`${String(op)} compares with values, not a field`);
        if (
          t !== 'string' ||
          !Array.isArray(value) ||
          !value.length ||
          !value.every((v) => typeof v === 'string')
        )
          bad(`${String(op)} needs type string and a non-empty list of texts`);
        if ((value as unknown[]).length > MAX_ANY_VALUES)
          bad(`${String(op)} takes at most ${MAX_ANY_VALUES} values`);
        if ((value as string[]).some((v) => v.length > MAX_ANY_TEXT))
          bad(`${String(op)} texts are at most ${MAX_ANY_TEXT} characters`);
      }
      const { times } = c as { times?: unknown };
      if (
        times !== undefined &&
        (field === undefined || typeof times !== 'number' || !Number.isFinite(times))
      )
        bad('times needs a field and a finite number');
      const { days, type } = c as { days?: unknown; type?: unknown };
      if (
        days !== undefined &&
        (field === undefined || type !== 'date' || typeof days !== 'number' || !Number.isFinite(days))
      )
        bad('days needs a field, type date and a finite number');
    }
  };
  check(filter, 1);
  return filter as RowsFilterGroup;
}

type Matcher = (row: unknown) => boolean;

/**
 * The filter as one function over a row: every condition compiled once (applyAdvanced runs it on every row). `cost`:
 * the work of one row in budget units — one per condition, more for a `containsAny`-style list (one pattern of up to
 * 256 texts) — so callers check the budget by work done, not by rows.
 */
interface RowFilter {
  match: Matcher;
  cost: number;
}
function compileGroup(g: RowsFilterGroup, budget?: Budget): RowFilter {
  let cost = 0;
  const tests: Matcher[] = g.clauses.map((c) => {
    if ('join' in c) {
      const inner = compileGroup(c, budget);
      cost += inner.cost;
      return inner.match;
    }
    const compiled = compileCondition(c, budget);
    cost += compiled.anyRe ? 1 + Math.ceil(compiled.values.length / 16) : 1;
    return (row) => matchCondition(compiled, row);
  });
  const match: Matcher =
    g.join === 'and' ? (row) => tests.every((f) => f(row)) : (row) => tests.some((f) => f(row));
  return { match, cost: Math.max(1, cost) };
}

/**
 * Rows that match the query builder's filter (`filters.advanced.dialect: rows`): `$applyAdvanced(rows, advanced)` in
 * a datasource transform. No filter (`advanced` undefined/null) returns the rows unchanged. Text comparisons ignore
 * case; dates compare as instants; a row without the field matches only the negated operators (`ne`, `notContains`,
 * `notIn`, `notContainsAny`, `notStartsWithAny`) — and `isEmpty`. `containsAny` / `startsWithAny` / `notContainsAny` /
 * `notStartsWithAny` take a list of texts (at most 256, each at most 256 characters) and test them in one pass over the field. A filter holds at most 64 conditions; the budget is checked by work done (rows × conditions). `isEmpty` / `notEmpty` look at plain values (a list counts its items; an object is never
 * empty). Content may also pass a filter of
 * its own (`{ "join": "and", "clauses": [{ "path": "accountEnabled", "type": "boolean", "op": "eq", "value": true }] }`):
 * it runs natively, so filtering tens of thousands of rows costs milliseconds instead of JSONata's ~15 µs a row.
 */
export function applyAdvanced(rows: unknown, filter: unknown, budget?: Budget): unknown[] {
  const list = rows === undefined || rows === null ? [] : Array.isArray(rows) ? rows : [rows];
  if (filter === undefined || filter === null) return [...list];
  const { match, cost } = compileGroup(checkRowsFilter(filter), budget);
  checkBudget(budget);
  const out: unknown[] = [];
  let work = 0;
  for (let i = 0; i < list.length; i++) {
    if ((work += cost) >= DEADLINE_STRIDE) {
      work = 0;
      checkBudget(budget);
    }
    if (match(list[i])) out.push(list[i]);
  }
  return out;
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
  // Function items pass through unchanged: a copy of a lambda would be a forged, callable function.
  return list.map((r) => (isRecord(r) ? { ...r, ...fields } : r));
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

/** Field names a native helper may write into a row: an identifier, never a prototype key or a JSONata internal. */
const WRITABLE_FIELD = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);
function writableField(name: unknown, fn: string, what: string): string {
  if (
    typeof name !== 'string' ||
    !WRITABLE_FIELD.test(name) ||
    RESERVED_FIELDS.has(name) ||
    name.startsWith('_jsonata')
  )
    throw new Error(`${fn}: ${what} must be a plain field name`);
  return name;
}
function pathKeys(path: unknown, fn: string): string[] {
  if (typeof path !== 'string' || !ROWS_PATH.test(path))
    throw new Error(`${fn}: the path must be field names joined with dots`);
  const keys = path.split('.');
  if (keys.some((k) => RESERVED_FIELDS.has(k))) throw new Error(`${fn}: the path can't name ${path}`);
  return keys;
}
const asRows = (rows: unknown): unknown[] =>
  rows === undefined || rows === null ? [] : Array.isArray(rows) ? rows : [rows];
/** Checks the evaluation's budget every `DEADLINE_STRIDE` rows (or rows written). */
const DEADLINE_STRIDE = 4096;
/** Fields one `$pick` may name and paths one `$attach` may join (content uses a handful). */
const MAX_NAMES = 64;
/**
 * The evaluation's budget as the registered helpers see it: JSONata's own guardrails (its timeout and depth checks,
 * as the native group-by and sort call them) and the absolute deadline (budget.ts). Tests pass a deadline number.
 */
type Budget = number | (() => void) | undefined;
const checkBudget = (budget: unknown) =>
  typeof budget === 'function' ? (budget as () => void)() : checkDeadline(budget, 0);
const budgetOf = (focus: jsonata.Focus | undefined): Budget => {
  const env = focus?.environment as
    { lookup(name: string): unknown; base?: { guardrails?: () => void } } | undefined;
  return () => {
    env?.base?.guardrails?.();
    checkDeadline(env?.lookup(DEADLINE_BINDING), 0);
  };
};

/**
 * `$pluck(rows, path)`: the values at `path` (a dot path through own properties; a list on the way is read item by
 * item) of every row, flattened — natively, where `rows.path` over tens of thousands of rows costs much of a
 * transform's budget. Missing and `null` values are left out, so `$distinct($pluck(rows, 'principalId'))` lists ids.
 * Unlike a JSONata path, a list directly inside a list isn't read into (Graph data has none on these paths).
 */
export function pluck(rows: unknown, path: unknown, budget?: Budget): unknown[] {
  const keys = pathKeys(path, '$pluck');
  const list = asRows(rows);
  const out: unknown[] = [];
  const push = (x: unknown) => {
    if (x === undefined || x === null) return;
    if (out.length >= MAX_SEQUENCE) throw new Error(`$pluck: at most ${MAX_SEQUENCE} values`);
    out.push(x);
  };
  for (let i = 0; i < list.length; i++) {
    if (i % DEADLINE_STRIDE === 0) checkBudget(budget);
    const v = readPath(list[i], keys);
    if (Array.isArray(v)) for (const x of v) push(x);
    else push(v);
  }
  return out;
}

/**
 * `$tableRows(table, names?)`: the rows of a columnar answer — `{ columns: [{ name } | name, …], rows: [[…], …] }`, as
 * Azure Cost Management (`value.properties`) and Log Analytics tables return them — as objects keyed by column name,
 * natively (a JSONata `$map` over thousands of rows costs most of a transform's budget). `names` picks and renames
 * columns, `{ "cost": "Cost", "service": "ServiceName" }`; a column the answer doesn't have gives no field. Without
 * `names`, columns whose names aren't plain field names are left out.
 */
export function tableRows(table: unknown, names?: unknown, budget?: Budget): Record<string, unknown>[] {
  if (table === undefined || table === null) return [];
  if (!isRecord(table)) throw new Error('$tableRows: the table must be an object with columns and rows');
  const columns = Array.isArray(table.columns) ? table.columns : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const columnNames = columns.map((c) =>
    typeof c === 'string' ? c : isRecord(c) && typeof c.name === 'string' ? c.name : '',
  );
  let pick: Array<[string, number]>;
  if (names === undefined || names === null)
    pick = columnNames.flatMap((n, i): Array<[string, number]> =>
      WRITABLE_FIELD.test(n) && !RESERVED_FIELDS.has(n) && !n.startsWith('_jsonata') ? [[n, i]] : [],
    );
  else {
    if (!isRecord(names)) throw new Error('$tableRows: names must be an object of field: column');
    const keys = Object.keys(names);
    if (keys.length > MAX_NAMES) throw new Error(`$tableRows: at most ${MAX_NAMES} names`);
    pick = keys.flatMap((k): Array<[string, number]> => {
      writableField(k, '$tableRows', 'each name');
      const column = names[k];
      if (typeof column !== 'string') throw new Error(`$tableRows: "${k}" must name a column`);
      const i = columnNames.indexOf(column);
      return i < 0 ? [] : [[k, i]];
    });
  }
  if (rows.length > MAX_SEQUENCE) throw new Error(`$tableRows: at most ${MAX_SEQUENCE} rows`);
  const out: Record<string, unknown>[] = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) {
    if (r % DEADLINE_STRIDE === 0) checkBudget(budget);
    const row = rows[r];
    const o: Record<string, unknown> = {};
    if (Array.isArray(row))
      for (const [k, i] of pick) {
        const v = row[i];
        // Functions never cross into the result (a copy of a lambda would be a forged, callable function).
        if (v !== undefined && typeof v !== 'function') o[k] = v;
      }
    out[r] = o;
  }
  return out;
}

/**
 * `$withShare(rows, 'cost', 'share')`: every object row with `share` = its `cost` divided by the total `cost` of the
 * rows (0 when the total is 0; a row without a number there counts as 0) — natively, for "share of total" columns over
 * lists too long for a JSONata `$map`.
 */
export function withShare(rows: unknown, field: unknown, as: unknown, budget?: Budget): unknown[] {
  const keys = pathKeys(field, '$withShare');
  const name = writableField(as, '$withShare', 'the new field');
  const list = asRows(rows);
  if (list.length > MAX_SEQUENCE) throw new Error(`$withShare: at most ${MAX_SEQUENCE} rows`);
  const num = (r: unknown) => {
    const v = readPath(r, keys);
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    if (i % DEADLINE_STRIDE === 0) checkBudget(budget);
    total += num(list[i]);
  }
  return list.map((r, i) => {
    if (i % DEADLINE_STRIDE === 0) checkBudget(budget);
    return isRecord(r) ? { ...r, [name]: total ? num(r) / total : 0 } : r;
  });
}

/**
 * `$idsWhere(rows, path, { "publicClient": filter, "multiTenant": filter, … })`: for each named query-builder filter
 * (as `$applyAdvanced` takes), the values at `path` (usually `id`) of the rows it matches — every filter compiled once
 * and all of them checked in one pass over the rows, where one `$applyAdvanced` per finding walks the rows again each
 * time. Names are plain field names (≤ 64); rows without a text, number or true/false at `path` are skipped. The budget is
 * checked while the filters compile and by work done (rows × conditions) while they run.
 */
export function idsWhere(
  rows: unknown,
  path: unknown,
  filters: unknown,
  budget?: Budget,
): Record<string, unknown[]> {
  const keys = pathKeys(path, '$idsWhere');
  if (!isRecord(filters))
    throw new Error('$idsWhere: the filters must be an object of query-builder filters');
  const names = Object.keys(filters);
  if (names.length > MAX_NAMES) throw new Error(`$idsWhere: at most ${MAX_NAMES} filters`);
  // One compiled filter per filter object: names that share one (`{ "a": $f, "b": $f }`) share its work.
  const byFilter = new Map<unknown, { filter: RowFilter; names: string[] }>();
  for (const name of names) {
    writableField(name, '$idsWhere', 'each filter name');
    const given = filters[name];
    const known = byFilter.get(given);
    if (known) {
      known.names.push(name);
      continue;
    }
    byFilter.set(given, {
      filter: compileGroup(checkRowsFilter(given, `$idsWhere: filter "${name}"`), budget),
      names: [name],
    });
    checkBudget(budget);
  }
  const tests = [...byFilter.values()];
  // At least 1 a row: with no filters the rows are still read.
  const cost = Math.max(
    1,
    tests.reduce((sum, t) => sum + t.filter.cost, 0),
  );
  const out: Record<string, unknown[]> = {};
  for (const name of names) out[name] = [];
  const list = asRows(rows);
  let work = 0;
  for (let i = 0; i < list.length; i++) {
    if ((work += cost) >= DEADLINE_STRIDE) {
      work = 0;
      checkBudget(budget);
    }
    const row = list[i];
    if (!isRecord(row)) continue;
    // Only plain values are ids: never an object, a list or a function (which would leave by reference).
    const id = readPath(row, keys);
    if (typeof id !== 'string' && typeof id !== 'number' && typeof id !== 'boolean') continue;
    for (const { filter, names: shared } of tests) {
      if (!filter.match(row)) continue;
      for (const name of shared) {
        const ids = out[name]!;
        if (ids.length >= MAX_SEQUENCE)
          throw new Error(`$idsWhere: at most ${MAX_SEQUENCE} values per filter`);
        ids.push(id);
      }
    }
  }
  return out;
}

/**
 * `$flagIn(rows, path, { "wildcardUri": [ids…], "publicClient": [ids…] })`: every object row copied once with one
 * true/false field per set — whether the row's value at `path` (a dot path; for a list, any of its values) is in that
 * set — natively, in one pass. Values compare as text (as `$attach` and `$withCount` do); a single value counts as a
 * one-item set. Replaces one `$withFields` copy per set (`$reduce` over findings) — at 13k flagged rows and ten
 * findings, ~180 ms in JSONata, a few ms here. Set names are plain field names (≤ 64), at most 1,000,000 values across
 * the sets; only texts, numbers and true/false match; function rows pass through.
 */
export function flagIn(rows: unknown, path: unknown, sets: unknown, budget?: Budget): unknown[] {
  const keys = pathKeys(path, '$flagIn');
  if (!isRecord(sets)) throw new Error('$flagIn: the sets must be an object of lists');
  const names = Object.keys(sets);
  if (names.length > MAX_NAMES) throw new Error(`$flagIn: at most ${MAX_NAMES} sets`);
  // One Set per list (names may share one), at most MAX_SEQUENCE values across all of them, the budget checked while
  // they are built.
  const built = new Map<unknown, Set<string>>();
  let total = 0;
  const compiled = names.map((name) => {
    writableField(name, '$flagIn', 'each set name');
    const given = sets[name];
    const known = built.get(given);
    if (known) return [name, known] as const;
    const values = asRows(given);
    if ((total += values.length) > MAX_SEQUENCE)
      throw new Error(`$flagIn: at most ${MAX_SEQUENCE} values across the sets`);
    const set = new Set<string>();
    for (let j = 0; j < values.length; j++) {
      if (j % DEADLINE_STRIDE === 0) checkBudget(budget);
      const v = values[j];
      if (v === null || v === undefined) continue;
      const k = flagText(v);
      if (k === undefined)
        throw new Error(`$flagIn: "${name}" must be a list of texts, numbers or true/false`);
      set.add(k);
    }
    built.set(given, set);
    return [name, set] as const;
  });
  const list = asRows(rows);
  if (list.length > MAX_SEQUENCE) throw new Error(`$flagIn: at most ${MAX_SEQUENCE} rows`);
  const out: unknown[] = new Array(list.length);
  let work = 0;
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    // Function items pass through unchanged: a copy of a lambda would be a forged, callable function.
    if (!isRecord(row)) {
      out[i] = row;
      continue;
    }
    const v = readPath(row, keys);
    if ((work += Math.max(1, compiled.length) * (Array.isArray(v) ? v.length + 1 : 1)) >= DEADLINE_STRIDE) {
      work = 0;
      checkBudget(budget);
    }
    // Object spread copies own properties as data; the names were checked (never "__proto__" or a JSONata internal).
    const copy: Record<string, unknown> = { ...row };
    if (Array.isArray(v)) {
      const own: string[] = [];
      for (const x of v) {
        const k = flagText(x);
        if (k !== undefined) own.push(k);
      }
      for (let j = 0; j < compiled.length; j++) {
        const set = compiled[j]![1];
        copy[compiled[j]![0]] = own.some((x) => set.has(x));
      }
    } else {
      // The usual case (an id): no lists to build.
      const k = flagText(v);
      for (let j = 0; j < compiled.length; j++)
        copy[compiled[j]![0]] = k !== undefined && compiled[j]![1].has(k);
    }
    out[i] = copy;
  }
  return out;
}

/** The text a `$flagIn` value compares as: texts, numbers and true/false only (an object or a function never matches). */
function flagText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** A shallow copy without `key`: object rest copies own enumerable properties as data (a "__proto__" key stays a key). */
function omit(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = row;
  return rest;
}

/**
 * `$unnest(rows, path, as, key?)`: one row per item of the list at `path` — a shallow copy of the row with that item
 * under `as` — natively. The new rows leave the list out (each carries its own item, not every item again): for a
 * one-field path the field is dropped; for a dotted path the objects along it are copied without the list, and when
 * the path runs through another list on the way, its first field is dropped whole. Rows whose list is missing or
 * empty are left out; a single value counts as a one-item list. With `key`, each new row also gets that field — the
 * row's `id` (`#<n>` for a numeric id, `@<position>` without one), the list's path and the item's position, e.g.
 * `"<id>:passwordCredentials:1"` — unique within the result, for a table's `rowKey`. (`$u := $; list.( … $u … )` per
 * row is what this replaces.)
 */
export function unnest(rows: unknown, path: unknown, as: unknown, budget?: Budget, key?: unknown): unknown[] {
  const keys = pathKeys(path, '$unnest');
  const name = writableField(as, '$unnest', 'the name for each item');
  const keyName = key === undefined || key === null ? null : writableField(key, '$unnest', 'the key field');
  const list = asRows(rows);
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < list.length; i++) {
    if (i % DEADLINE_STRIDE === 0) checkBudget(budget);
    const row = list[i];
    if (!isRecord(row)) continue;
    const v = readPath(row, keys);
    const items = v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
    if (items.length === 0) continue;
    const base = keyName ? keyBase(row, i) : '';
    const shared = withoutPath(row, keys);
    for (let j = 0; j < items.length; j++) {
      if (out.length >= MAX_SEQUENCE) throw new Error(`$unnest: at most ${MAX_SEQUENCE} rows`);
      // By work done, not only by input row: one row can hold a long list.
      if ((out.length & (DEADLINE_STRIDE - 1)) === DEADLINE_STRIDE - 1) checkBudget(budget);
      const copy: Record<string, unknown> = { ...shared, [name]: items[j] };
      if (keyName) copy[keyName] = `${base}:${path}:${j}`;
      out.push(copy);
    }
  }
  return out;
}

/**
 * A row's part of an `$unnest` key, distinct for text ids, numeric ids and positions: a text id as it is (prefixed
 * with `!` when it starts with `#`, `@` or `!`), `#<n>` for a numeric id, `@<position>` without an id.
 */
function keyBase(row: Record<string, unknown>, i: number): string {
  const id = Object.hasOwn(row, 'id') ? row.id : undefined;
  if (typeof id === 'string') return /^[#@!]/.test(id) ? `!${id}` : id;
  if (typeof id === 'number') return `#${id}`;
  return `@${i}`;
}

/** A shallow copy of `row` without the list at `keys` (see `$unnest`): only the objects along the path are copied. */
function withoutPath(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const [head, ...rest] = keys;
  if (!rest.length) return omit(row, head!);
  const inner = row[head!];
  if (!isRecord(inner) || !Object.hasOwn(row, head!)) return omit(row, head!);
  return { ...row, [head!]: withoutPath(inner, rest) };
}

/**
 * `$attach(rows, path, lookup, defaults?, as?)`: each row with the fields of `lookup[<the row's value at path>]` added
 * (a shallow copy; the lookup's fields win) — natively, for joining rows with a table built once per distinct value
 * (e.g. a grouping `ids{ $: { … } }`). A row without a matching entry gets `defaults` when given (`null` for none),
 * else stays as it is. With `as`, the entry is not merged but put under that one field (`row.as.…`), so a lookup of
 * whole objects (`objects{ id: $ }`) joins without building an entry per object. The value at `path` is compared as
 * text (1 joins "1", as `$lookup` does). Entries are read as own properties only and must be objects; merged, their
 * fields replace the row's (any key but JSONata's internal `_jsonata…` flags, e.g. `@odata.type`). A key that a
 * grouping repeated holds a list, not an object: that row gets the default.
 */
export function attach(
  rows: unknown,
  path: unknown,
  lookup: unknown,
  defaults?: unknown,
  budget?: Budget,
  as?: unknown,
): unknown[] {
  if (!lookup || typeof lookup !== 'object' || Array.isArray(lookup) || isLambda(lookup))
    throw new Error('$attach: the lookup must be an object');
  const table = lookup as Record<string, unknown>;
  // Several id fields joined against the same lookup in one copy per row: `path` and `as` are lists of the same
  // length, `defaults` (optional) an object of per-name defaults.
  const many = Array.isArray(path);
  if (many && (!Array.isArray(as) || as.length !== (path as unknown[]).length || !as.length))
    throw new Error('$attach: with a list of paths, name one field per path');
  if (many && (path as unknown[]).length > MAX_NAMES)
    throw new Error(`$attach: at most ${MAX_NAMES} paths in one call`);
  const joins = (many ? (path as unknown[]) : [path]).map((p, i) => {
    const name = many ? (as as unknown[])[i] : as;
    const nest =
      name === undefined || name === null ? null : writableField(name, '$attach', 'the name to attach under');
    return { keys: pathKeys(p, '$attach'), nest };
  });
  if (many && joins.some((j) => !j.nest))
    throw new Error('$attach: with a list of paths, name one field per path');
  const fallbackFor = (nest: string | null): Record<string, unknown> | null => {
    if (defaults === undefined || defaults === null) return null;
    if (!many) return nest ? safeNested(defaults, 'the defaults') : safeEntry(defaults, 'the defaults');
    if (typeof defaults !== 'object' || Array.isArray(defaults) || isLambda(defaults))
      throw new Error('$attach: the defaults must be an object of one default per name');
    const d = Object.hasOwn(defaults, nest!) ? (defaults as Record<string, unknown>)[nest!] : undefined;
    return d === undefined || d === null ? null : safeNested(d, `the default for "${nest}"`);
  };
  const fallbacks = joins.map((j) => fallbackFor(j.nest));
  const checked = new Map<string, Record<string, unknown> | null>();
  const nestedOk = joins.every((j) => j.nest);
  const entry = (key: string) => {
    if (checked.has(key)) return checked.get(key)!;
    let e: Record<string, unknown> | null = null;
    if (Object.hasOwn(table, key)) {
      const v = table[key];
      if (v && typeof v === 'object' && !Array.isArray(v) && !isLambda(v))
        e = nestedOk ? safeNested(v, `"${key}"`) : safeEntry(v, `"${key}"`);
    }
    checked.set(key, e);
    return e;
  };
  const list = asRows(rows);
  if (list.length > MAX_SEQUENCE) throw new Error(`$attach: at most ${MAX_SEQUENCE} rows`);
  return list.map((row, i) => {
    if (i % DEADLINE_STRIDE === 0) checkBudget(budget);
    if (!isRecord(row)) return row;
    if (!many) {
      // One join (the usual case): a single spread copy.
      const v = readPath(row, joins[0]!.keys);
      const e =
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? entry(String(v)) : null;
      const add = e ?? fallbacks[0];
      if (!add) return row;
      const nest = joins[0]!.nest;
      return nest ? { ...row, [nest]: add } : { ...row, ...add };
    }
    let out: Record<string, unknown> | null = null;
    for (let j = 0; j < joins.length; j++) {
      const { keys, nest } = joins[j]!;
      const v = readPath(row, keys);
      const e =
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? entry(String(v)) : null;
      const add = e ?? fallbacks[j];
      if (!add) continue;
      out ??= { ...row };
      out[nest!] = add;
    }
    return out ?? row;
  });
}

/**
 * `$withCount(rows, path, as)`: each row with `as` = how many rows share its value at `path`, compared as text like
 * `$attach` (rows without one get 0) — natively, e.g. "apps with several live secrets" as `$applyAdvanced($withCount(secrets, 'id', 'n'), n > 1)`.
 */
export function withCount(rows: unknown, path: unknown, as: unknown, budget?: Budget): unknown[] {
  const keys = pathKeys(path, '$withCount');
  const name = writableField(as, '$withCount', 'the count field');
  const list = asRows(rows);
  if (list.length > MAX_SEQUENCE) throw new Error(`$withCount: at most ${MAX_SEQUENCE} rows`);
  const keyOf = (row: unknown) => {
    const v = readPath(row, keys);
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
  };
  const counts = new Map<string, number>();
  for (let i = 0; i < list.length; i++) {
    if (i % DEADLINE_STRIDE === 0) checkBudget(budget);
    const k = keyOf(list[i]);
    if (k !== null) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return list.map((row, i) => {
    if (i % DEADLINE_STRIDE === 0) checkBudget(budget);
    if (!isRecord(row)) return row;
    const k = keyOf(row);
    return { ...row, [name]: k === null ? 0 : counts.get(k)! };
  });
}

/**
 * `$pick(rows, fields)`: each row with only the named top-level fields (own properties; missing ones left out) —
 * natively, to keep big objects (a service principal from `getByIds`) small before they are joined or returned.
 */
export function pick(rows: unknown, fields: unknown, budget?: Budget): unknown[] {
  const list = asRows(rows);
  const given = Array.isArray(fields) ? fields : [fields];
  if (given.length > MAX_NAMES) throw new Error(`$pick: at most ${MAX_NAMES} fields`);
  const names = given.map((f) => writableField(f, '$pick', 'each field'));
  if (!names.length) throw new Error('$pick: name at least one field');
  if (list.length > MAX_SEQUENCE) throw new Error(`$pick: at most ${MAX_SEQUENCE} rows`);
  return list.map((row, i) => {
    if (i % DEADLINE_STRIDE === 0) checkBudget(budget);
    if (!isRecord(row)) return row;
    const out: Record<string, unknown> = {};
    for (const n of names) if (Object.hasOwn(row, n)) out[n] = row[n];
    return out;
  });
}

/** An object nested whole under one field: no functions at its top level (it is data, not merged into the row). */
function safeNested(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || isLambda(v))
    throw new Error(`$attach: ${what} must be an object`);
  for (const [k, x] of Object.entries(v))
    if (isLambda(x)) throw new Error(`$attach: "${k}" can't be a function`);
  return v as Record<string, unknown>;
}

/**
 * An object of fields to merge into rows (by spread, so any key — `@odata.type`, even `__proto__` — stays a plain
 * key): no JSONata internal flags (they would mark the row as a function), no functions.
 */
function safeEntry(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || isLambda(v))
    throw new Error(`$attach: ${what} must be an object`);
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith('_jsonata')) throw new Error(`$attach: "${k}" can't be a field name`);
    if (isLambda(x)) throw new Error(`$attach: "${k}" can't be a function`);
  }
  return v as Record<string, unknown>;
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
  'pluck',
  'unnest',
  'attach',
  'pick',
  'withCount',
  'flagIn',
  'idsWhere',
  'tableRows',
  'withShare',
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
  expr.registerFunction('applyAdvanced', function (this: jsonata.Focus, rows: unknown, filter: unknown) {
    return applyAdvanced(rows, filter, budgetOf(this));
  });
  expr.registerFunction('withFields', (rows: unknown, fields: unknown) => withFields(rows, fields), '<xo:a>');
  expr.registerFunction('take', (rows: unknown, n: unknown) => take(rows, n));
  expr.registerFunction(
    'pluck',
    function (this: jsonata.Focus, rows: unknown, path: unknown) {
      return pluck(rows, path, budgetOf(this));
    },
    '<xs:a>',
  );
  expr.registerFunction(
    'unnest',
    function (this: jsonata.Focus, rows: unknown, path: unknown, as: unknown, key?: unknown) {
      return unnest(rows, path, as, budgetOf(this), key);
    },
    '<xss(sl)?:a>',
  );
  expr.registerFunction(
    'attach',
    function (
      this: jsonata.Focus,
      rows: unknown,
      path: unknown,
      lookup: unknown,
      defaults?: unknown,
      as?: unknown,
    ) {
      return attach(rows, path, lookup, defaults, budgetOf(this), as);
    },
    '<xxox?x?:a>',
  );
  expr.registerFunction(
    'pick',
    function (this: jsonata.Focus, rows: unknown, fields: unknown) {
      return pick(rows, fields, budgetOf(this));
    },
    '<xx:a>',
  );
  expr.registerFunction(
    'withCount',
    function (this: jsonata.Focus, rows: unknown, path: unknown, as: unknown) {
      return withCount(rows, path, as, budgetOf(this));
    },
    '<xss:a>',
  );
  expr.registerFunction(
    'flagIn',
    function (this: jsonata.Focus, rows: unknown, path: unknown, sets: unknown) {
      return flagIn(rows, path, sets, budgetOf(this));
    },
    '<xso:a>',
  );
  expr.registerFunction(
    'idsWhere',
    function (this: jsonata.Focus, rows: unknown, path: unknown, filters: unknown) {
      return idsWhere(rows, path, filters, budgetOf(this));
    },
    '<xso:o>',
  );
  expr.registerFunction(
    'tableRows',
    function (this: jsonata.Focus, table: unknown, names?: unknown) {
      return tableRows(table, names, budgetOf(this));
    },
    '<xx?:a>',
  );
  expr.registerFunction(
    'withShare',
    function (this: jsonata.Focus, rows: unknown, field: unknown, as: unknown) {
      return withShare(rows, field, as, budgetOf(this));
    },
    '<xss:a>',
  );
}
