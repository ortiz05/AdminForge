import jsonata from 'jsonata';

/**
 * Size limits for JSONata built-ins (§7.6). JSONata checks its timeout between evaluation steps, but a single built-in
 * call runs to completion: `$pad("", 1e9)`, `$string` of a huge value, `$sort` (an O(n²)-memory merge in JSONata) or
 * `$distinct` (O(n²)) on a big range could stall the event loop for seconds or exhaust memory. These overrides keep
 * JSONata's behaviour and refuse sizes no AdminForge content needs. `$eval` (code from data) is disabled. `&` is an
 * operator, not a built-in: evaluation rewrites it into a size-checked concatenation (`rewriteConcat`).
 */

/** Largest range (`[1..n]`) or sequence an expression may build. */
export const MAX_SEQUENCE = 1_000_000;
/** Most characters a string built-in may produce. */
export const MAX_TEXT = 10_000_000;
/** Widest `$pad`. */
export const MAX_PAD = 10_000;

type Focus = jsonata.Focus & { createSequence?: () => unknown[] };
type Builtin = { implementation: (this: Focus, ...args: unknown[]) => unknown };

let originals: Promise<Record<string, Builtin>> | undefined;
/** JSONata's own implementation of a built-in (looked up once). */
async function builtin(name: 'pad' | 'string' | 'join' | 'replace'): Promise<Builtin> {
  originals ??= jsonata('{"pad": $pad, "string": $string, "join": $join, "replace": $replace}').evaluate(
    {},
  ) as Promise<Record<string, Builtin>>;
  return (await originals)[name]!;
}

const tooLarge = (fn: string, what: string) => new Error(`${fn}: ${what}`);

/** True when the JSON text of `value` would be longer than `budget` characters (stops counting once it is). */
function exceeds(value: unknown, budget: number): boolean {
  let size = 0;
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') size += v.length + 2;
    else if (Array.isArray(v)) {
      size += v.length + 2;
      for (const item of v) stack.push(item);
    } else if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        size += k.length + 4;
        stack.push(item);
      }
      size += 2;
    } else size += 8;
    if (size > budget) return true;
  }
  return false;
}

const fnIds = new WeakMap<object, number>();
let nextFnId = 0;

/** A key equal for values JSONata's deep-equality considers equal (object keys in any order). */
function canonical(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (
    typeof v === 'function' ||
    (typeof v === 'object' && ('_jsonata_lambda' in v || '_jsonata_function' in v))
  ) {
    const o = v as object;
    if (!fnIds.has(o)) fnIds.set(o, nextFnId++);
    return `fn#${fnIds.get(o)}`;
  }
  if (typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Object.is(v, -0) ? '0' : String(v);
  return `${typeof v}:${String(v)}`;
}

/** `$distinct` in O(n): first occurrence of each deep-equal value, sequences stay sequences. */
function distinct(this: Focus, arr: unknown): unknown {
  if (arr === undefined) return undefined;
  if (!Array.isArray(arr) || arr.length <= 1) return arr;
  const out =
    (arr as { sequence?: boolean }).sequence === true && this.createSequence ? this.createSequence() : [];
  const seen = new Set<string>();
  for (const v of arr) {
    const key = canonical(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * `$sort` in O(n log n): the default order (numbers or strings, ascending) natively; a comparator through a stable
 * bottom-up merge — `comparator(a, b)` true puts `b` first, exactly as in JSONata. Each comparator call is an
 * evaluation step, so the expression timeout still applies.
 */
async function sort(
  this: Focus,
  arr: unknown,
  comparator?: (a: unknown, b: unknown) => unknown,
): Promise<unknown> {
  if (arr === undefined) return undefined;
  if (!Array.isArray(arr) || arr.length <= 1) return arr;
  if (arr.length > MAX_SEQUENCE) throw tooLarge('$sort', `at most ${MAX_SEQUENCE} items can be sorted`);
  if (comparator === undefined) {
    const numbers = arr.every((v) => typeof v === 'number' && Number.isFinite(v));
    if (!numbers && !arr.every((v) => typeof v === 'string'))
      throw tooLarge(
        '$sort',
        'without a comparison function it sorts only an array of strings or an array of numbers',
      );
    return [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  let src: unknown[] = [...arr];
  const n = src.length;
  for (let width = 1; width < n; width *= 2) {
    const out: unknown[] = new Array<unknown>(n);
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n);
      const hi = Math.min(lo + 2 * width, n);
      let i = lo;
      let j = mid;
      let k = lo;
      while (i < mid && j < hi) out[k++] = (await comparator(src[i], src[j])) ? src[j++] : src[i++];
      while (i < mid) out[k++] = src[i++];
      while (j < hi) out[k++] = src[j++];
    }
    src = out;
  }
  return src;
}

async function pad(this: Focus, str: unknown, width: unknown, char?: unknown): Promise<unknown> {
  const w = typeof width === 'number' ? Math.abs(Math.trunc(width)) : 0;
  const unit = typeof char === 'string' && char.length > 0 ? char.length : 1;
  if (w > MAX_PAD) throw tooLarge('$pad', `the width is limited to ${MAX_PAD} characters`);
  if (w * unit > MAX_TEXT) throw tooLarge('$pad', `the result would exceed ${MAX_TEXT} characters`);
  return (await builtin('pad')).implementation.call(this, str, width, char);
}

async function string(this: Focus, arg: unknown, prettify?: unknown): Promise<unknown> {
  if (arg !== undefined && typeof arg !== 'string' && exceeds(arg, prettify ? MAX_TEXT / 4 : MAX_TEXT))
    throw tooLarge('$string', `the value is too large to turn into text (over ${MAX_TEXT} characters)`);
  return (await builtin('string')).implementation.call(this, arg, prettify);
}

async function join(this: Focus, arr: unknown, separator?: unknown): Promise<unknown> {
  if (Array.isArray(arr)) {
    const sep = typeof separator === 'string' ? separator.length : 0;
    let total = Math.max(0, arr.length - 1) * sep;
    for (const s of arr) {
      total += typeof s === 'string' ? s.length : 0;
      if (total > MAX_TEXT) throw tooLarge('$join', `the result would exceed ${MAX_TEXT} characters`);
    }
  }
  return (await builtin('join')).implementation.call(this, arr, separator);
}

async function replace(
  this: Focus,
  str: unknown,
  pattern: unknown,
  replacement: unknown,
  limit?: unknown,
): Promise<unknown> {
  if (typeof str === 'string' && typeof replacement === 'string' && replacement.length > 0) {
    const possible =
      typeof pattern === 'string' && pattern.length > 0
        ? Math.floor(str.length / pattern.length)
        : str.length;
    const matches = typeof limit === 'number' && limit >= 0 ? Math.min(limit, possible) : possible;
    if (str.length + matches * replacement.length > MAX_TEXT)
      throw tooLarge('$replace', `the result could exceed ${MAX_TEXT} characters`);
  }
  return (await builtin('replace')).implementation.call(this, str, pattern, replacement, limit);
}

/** The size-checked `&` evaluation calls instead of JSONata's operator (`$__af…` names are reserved for AdminForge). */
export const CONCAT_FUNCTION = '__afConcat';

/** One `&` operand as JSONata turns it into text: undefined → '', a string as it is, anything else as `$string` does. */
async function text(this: Focus, value: unknown): Promise<string> {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'function' && exceeds(value, MAX_TEXT))
    throw tooLarge('&', `a value is too large to turn into text (over ${MAX_TEXT} characters)`);
  return (await (await builtin('string')).implementation.call(this, value)) as string;
}

/**
 * `a & b & …` exactly as JSONata evaluates it — every operand turned into text, undefined as '' — refused past
 * MAX_TEXT characters like `$join`. A chain is one call: `((a & b) & c)` is the text of a, b and c either way.
 */
function concat(this: Focus, ...operands: unknown[]): string | Promise<string> {
  // Strings, finite numbers, booleans and null (the usual cases) without a round trip through JSONata's `$string`.
  const parts: string[] = [];
  let length = 0;
  for (const v of operands) {
    const part = scalarText(v);
    if (part === undefined)
      return Promise.all(operands.map((x) => text.call(this, x))).then((all) => concat.call(this, ...all));
    length += part.length;
    if (length > MAX_TEXT) throw tooLarge('&', `the result would exceed ${MAX_TEXT} characters`);
    parts.push(part);
  }
  return parts.join('');
}

/** `$string` of a scalar, as JSONata writes it (numbers to 15 significant digits); undefined for anything else. */
function scalarText(v: unknown): string | undefined {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number')
    return Number.isFinite(v) ? String(Number.isInteger(v) ? v : Number(v.toPrecision(15))) : undefined;
  if (typeof v === 'boolean' || v === null) return String(v);
  return undefined;
}

/** A `&` node with nothing else on it (no predicate, grouping, …): its chain can be read as one concatenation. */
const plainConcat = (n: unknown): n is Record<string, unknown> =>
  !!n &&
  typeof n === 'object' &&
  (n as { type?: unknown }).type === 'binary' &&
  (n as { value?: unknown }).value === '&' &&
  Object.keys(n).every(
    (k) => k === 'type' || k === 'value' || k === 'lhs' || k === 'rhs' || k === 'position',
  );

/**
 * Rewrites every `&` of a compiled expression's AST, in place, into a call of the size-checked concatenation — a chain
 * `a & b & c` into one call — keeping its other keys (a predicate, a grouping). For evaluation only: validation and
 * lint read the AST as written. Returns how many calls it made.
 */
export function rewriteConcat(ast: unknown): number {
  let rewritten = 0;
  const seen = new WeakSet<object>();
  const stack: unknown[] = [ast];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object' || seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    const n = v as Record<string, unknown>;
    if (n.type !== 'binary' || n.value !== '&') {
      for (const x of Object.values(n)) if (x && typeof x === 'object') stack.push(x);
      continue;
    }
    const operands: unknown[] = [];
    const flatten = (x: unknown): void => {
      if (plainConcat(x)) {
        flatten(x.lhs);
        flatten(x.rhs);
      } else operands.push(x);
    };
    flatten(n.lhs);
    flatten(n.rhs);
    stack.push(...operands);
    n.type = 'function';
    n.value = '(';
    n.procedure = { type: 'variable', value: CONCAT_FUNCTION, position: n.position };
    n.arguments = operands;
    delete n.lhs;
    delete n.rhs;
    rewritten++;
  }
  return rewritten;
}

/** Registers the size-limited built-ins on a compiled expression (signatures as JSONata's own). */
export function registerLimits(expr: jsonata.Expression): void {
  expr.registerFunction(CONCAT_FUNCTION, concat);
  expr.registerFunction('pad', pad, '<s-ns?:s>');
  expr.registerFunction('string', string, '<x-b?:s>');
  expr.registerFunction('join', join, '<a<s>s?:s>');
  expr.registerFunction('replace', replace, '<s-(sf)(sf)n?:s>');
  expr.registerFunction('sort', sort, '<af?:a>');
  expr.registerFunction('distinct', distinct, '<x:x>');
  expr.registerFunction('eval', () => {
    throw new Error('$eval is not available in AdminForge expressions');
  });
}
