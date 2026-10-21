/**
 * Taint analysis behind the injection lint (validate.ts `lintExpressions`; §5.10, §7.9, R12). It follows user data —
 * page params, playbook inputs, rows, items, a datasource's or a step's result — through an expression the way JSONata
 * evaluates it, without evaluating anything: paths and their steps, `&`, conditionals, blocks and their variables,
 * functions as values (lambdas, partial applications, transforms — bound to a variable, kept in an array or an object,
 * returned, given to `$map`, `$filter`, `$reduce`, …, applied with `~>`), object and array constructors, the context
 * JSONata hands a built-in (`params.q.$trim()`), and every function call. It ends at:
 *   - the encoders that suit the place the value goes (`$odata` / `$odataSearch` in OData, `$kql` in KQL, `$encode`
 *     in a path; `$guid` anywhere) — an encoder in the wrong place does not count, and an encoded value taken apart
 *     again (`$substring`, `$replace`, `$split`, …) is user data again;
 *   - functions whose result is a number, a boolean, a date or a new id (`$number`, `$count`, `$daysAgo`, …);
 *   - a literal allowlist (`params.x in ['a', 'b'] ? … params.x … : …`) and the params a caller vouches for;
 *   - a character allowlist, `$replace(x, /[^…]/, '')`, without quotes, backslashes or line breaks: safe in OData or
 *     KQL only inside a quoted literal (`"name eq '" & $replace(…) & "'"`, judged from the literal text around it in
 *     the dialect's own quoting rules), in a path only when it is letters, digits, `-` and `_`, and anywhere when it
 *     is digits only; taken apart again (`$substring`, …) it may have lost its quotes.
 * A taint is a set of flags (Level), so these combine: what a value needs (quotes), where it may not go (a path),
 * which encoder made it safe (and so where it may go), and whether it may hold quote characters of its own.
 * Objects keep a taint per field, so `ds.scope.path` (encoded in its transform) is clean while `ds.scope.label` (the
 * param as it came) is not.
 */

type AstNode = { type?: string; value?: unknown } & Record<string, unknown>;

/** Safe anywhere. */
export const CLEAN = 0;
/** Flag: safe in OData or KQL only inside a quoted literal (words: an identifier or a keyword outside quotes). */
export const NEEDS_QUOTES = 1;
/** Flag: not safe in a request path (`/`, `.`, spaces, …). */
export const NOT_IN_PATH = 2;
/** Flag: not safe anywhere (it can hold quotes and backslashes). */
export const ANYWHERE = 4;
/** Flags: user data an encoder made safe as it is, for its own kind of text only — and not once taken apart. */
export const ENC_ODATA = 8;
export const ENC_SEARCH = 16;
export const ENC_KQL = 32;
export const ENC_PATH = 64;
export const ENCODED = ENC_ODATA | ENC_SEARCH | ENC_KQL | ENC_PATH;
/** Flag: allowlisted text placed between quotes (taken apart again, it may lose them). */
export const QUOTED = 128;
/** Flag: may hold quote characters that open or close a literal (so text around it can't tell what is quoted). */
export const MAY_QUOTE = 256;
/** Flag: a `$odataSearch` value placed inside a `"…"` clause (still for Graph search text only). */
export const SEARCH_PLACED = 512;
/** Flag (with ANYWHERE): an encoder that brings its own quotes placed inside a quoted literal — for the message. */
export const MISPLACED = 1024;
/** Letters, digits, `-` and `_`: a safe path segment that needs quotes in OData or KQL. */
export const SEGMENT = NEEDS_QUOTES;
/** Text without quotes, backslashes or line breaks: only inside a quoted OData or KQL literal. */
export const TEXT = NEEDS_QUOTES | NOT_IN_PATH;
/** User data as it came. */
export const RAW = NEEDS_QUOTES | NOT_IN_PATH | ANYWHERE | ENCODED | QUOTED | MAY_QUOTE | SEARCH_PLACED;
/** A set of the flags above. */
export type Level = number;

/** An object whose fields differ: a taint per field, `rest` for any other key; `resolve` works a field out on demand. */
export interface Shape {
  readonly fields: ReadonlyMap<string, Taint>;
  readonly rest: Level;
  readonly resolve?: (key: string) => Taint | undefined;
  readonly keys?: () => readonly string[];
}
export type Taint = Level | Shape;

const max = (a: Level, b: Level): Level => a | b;

/** `t.key` (a field of an array is the field of its items, as in JSONata). */
export function get(t: Taint, key: string): Taint {
  if (typeof t === 'number') return t;
  return t.fields.get(key) ?? t.resolve?.(key) ?? t.rest;
}

const keysOf = (s: Shape): string[] => [...new Set([...s.fields.keys(), ...(s.keys?.() ?? [])])];

/** The most user data any part of a value carries: the value turned into text. */
export function level(t: Taint, seen: Set<Shape> = new Set()): Level {
  if (typeof t === 'number') return t;
  if (seen.has(t)) return t.rest;
  seen.add(t);
  let out = t.rest;
  for (const k of keysOf(t)) {
    if ((out & RAW) === RAW) break;
    out = max(out, level(get(t, k), seen));
  }
  return out;
}

/** Either value (a conditional's branches, the items of an array). */
export function join(a: Taint, b: Taint): Taint {
  if (a === CLEAN || a === b) return b;
  if (b === CLEAN) return a;
  if (typeof a === 'number' || typeof b === 'number') return max(level(a), level(b));
  const fields = new Map<string, Taint>();
  for (const k of new Set([...keysOf(a), ...keysOf(b)])) fields.set(k, join(get(a, k), get(b, k)));
  return { fields, rest: max(a.rest, b.rest) };
}

/** Any value of an object (`$lookup` with a computed key, `$each`). */
const anyValue = (t: Taint): Taint =>
  typeof t === 'number' ? t : keysOf(t).reduce<Taint>((acc, k) => join(acc, get(t, k)), t.rest);

/** `params.q` → "params.q"; undefined for anything that is not a plain name path. */
export function pathKey(n: unknown): string | undefined {
  const node = n as AstNode | undefined;
  if (!node) return undefined;
  if (node.type === 'name') return String(node.value);
  const steps = node.steps as AstNode[] | undefined;
  if (node.type === 'path' && steps?.length && steps.every((s) => s.type === 'name'))
    return steps.map((s) => String(s.value)).join('.');
  return undefined;
}

/** `params.x in ['a', 'b']` (a literal allowlist) → "params.x": inside the `then` branch the value is one of the literals. */
function allowlisted(cond: unknown): string[] {
  const n = cond as AstNode | undefined;
  if (!n || n.type !== 'binary') return [];
  if (n.value === 'and') return [...allowlisted(n.lhs), ...allowlisted(n.rhs)];
  if (n.value !== 'in') return [];
  const list = n.rhs as AstNode | undefined;
  const literal =
    list?.type === 'unary' &&
    list.value === '[' &&
    Array.isArray(list.expressions) &&
    (list.expressions as AstNode[]).every((e) => e.type === 'string' || e.type === 'number');
  const key = literal ? pathKey(n.lhs) : undefined;
  return key ? [key] : [];
}

/** The encoders and the flag each sets: safe as it is, in its own kind of text (`$guid` is clean anywhere). */
const ENCODER_FLAG = new Map<string, Level>([
  ['odata', ENC_ODATA],
  ['odataSearch', ENC_SEARCH],
  ['kql', ENC_KQL],
  // encodeURIComponent leaves `'` alone.
  ['encode', ENC_PATH | MAY_QUOTE],
]);
export const ENCODERS: ReadonlySet<string> = new Set([...ENCODER_FLAG.keys(), 'guid']);

/** Functions whose result is a number, a boolean, a date or a new id: no text of their arguments gets through. */
const SAFE_RESULTS = new Set([
  'number',
  'count',
  'length',
  'boolean',
  'exists',
  'not',
  'contains',
  'sum',
  'max',
  'min',
  'average',
  'abs',
  'floor',
  'ceil',
  'round',
  'power',
  'sqrt',
  'random',
  'millis',
  'toMillis',
  'parseInteger',
  'type',
  'daysAgo',
  'iso',
  'daysUntil',
  'uuid',
]);

/** Functions that can rebuild any character from harmless-looking text (`%27`, base64). */
const DECODERS = new Set(['decodeUrlComponent', 'decodeUrl', 'base64decode']);

/** Functions that mix literal text into their result where the data decides (`$pad(x, 6, "'")`, `$join(xs, "'")`). */
const ADDS_LITERALS = new Set([
  'replace',
  'pad',
  'join',
  'formatNumber',
  'formatBase',
  'formatInteger',
  'fromMillis',
  'now',
]);

/** Functions that take text apart or rewrite it: an encoded value given to them is user data again. */
const TAKES_APART = new Set([
  'substring',
  'substringBefore',
  'substringAfter',
  'replace',
  'split',
  'match',
  'base64encode',
  'encodeUrlComponent',
  'encodeUrl',
  'formatNumber',
  'formatBase',
  'formatInteger',
]);

/** What a built-in returns, for the context rule below: s(tring), n(umber), b(oolean), a(rray). */
const RESULT_KIND = new Map<string, string>([
  ...[
    'number',
    'count',
    'length',
    'sum',
    'max',
    'min',
    'average',
    'abs',
    'floor',
    'ceil',
    'round',
    'power',
    'sqrt',
    'random',
    'millis',
    'toMillis',
    'parseInteger',
    'daysUntil',
  ].map((f) => [f, 'n'] as const),
  ...['boolean', 'exists', 'not', 'contains'].map((f) => [f, 'b'] as const),
  ...[
    'string',
    'substring',
    'substringBefore',
    'substringAfter',
    'lowercase',
    'uppercase',
    'trim',
    'pad',
    'replace',
    'join',
    'base64encode',
    'base64decode',
    'encodeUrlComponent',
    'encodeUrl',
    'decodeUrlComponent',
    'decodeUrl',
    'formatNumber',
    'formatBase',
    'formatInteger',
    'fromMillis',
    'now',
    'iso',
    'daysAgo',
    'uuid',
    'secureRandom',
    'type',
    ...ENCODERS,
  ].map((f) => [f, 's'] as const),
  ...['split', 'keys', 'spread', 'map', 'filter', 'sort', 'distinct', 'append', 'reverse', 'zip'].map(
    (f) => [f, 'a'] as const,
  ),
]);

/**
 * Built-ins JSONata may hand the context (`$`) as their first argument (`params.q.$trim()`, `$lookup('params')`):
 * their parameters as in JSONata's signatures (the first takes the context; `?` = optional).
 */
const CONTEXT_PARAMS = new Map<string, readonly string[]>([
  ['string', ['x', 'b?']],
  ['substring', ['s', 'n', 'n?']],
  ['substringBefore', ['s', 's']],
  ['substringAfter', ['s', 's']],
  ['lowercase', ['s']],
  ['uppercase', ['s']],
  ['trim', ['s']],
  ['pad', ['s', 'n', 's?']],
  ['match', ['s', 'f', 'n?']],
  ['replace', ['s', 'sf', 'sf', 'n?']],
  ['split', ['s', 'sf', 'n?']],
  ['base64encode', ['s']],
  ['base64decode', ['s']],
  ['encodeUrlComponent', ['s']],
  ['encodeUrl', ['s']],
  ['decodeUrlComponent', ['s']],
  ['decodeUrl', ['s']],
  ['formatNumber', ['n', 's', 'o?']],
  ['formatBase', ['n', 'n?']],
  ['formatInteger', ['n', 's']],
  ['fromMillis', ['n', 's?', 's?']],
  ['keys', ['x']],
  ['lookup', ['x', 's']],
  ['spread', ['x']],
  ['clone', ['oa']],
  ['sift', ['o', 'f?']],
  ['each', ['o', 'f']],
]);

/** Characters that let text out of a quoted OData or KQL literal (or a Graph `$search` clause). */
const QUOTE_UNSAFE = '\'"\\`\n\r\t\0\v\f\u2028\u2029';
/** …and those that change a URL path (segments, query, fragment, escapes, dot segments, OData key syntax). */
const PATH_UNSAFE = `${QUOTE_UNSAFE} !#$%&()*+,./:;<=>?@[]^{|}~`;
/** …and what makes a value more than a number (an identifier, a keyword) outside quotes. */
const WORD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

/**
 * A function as a value: a lambda, a partial application or a transform with the context it was written in, a
 * built-in by name, or something opaque that can return `captured` besides its arguments.
 */
interface Fn {
  lambda?: AstNode;
  partial?: AstNode;
  transform?: AstNode;
  closure?: Ctx;
  builtin?: string;
  captured?: Level;
}

/** A variable: the data it may hold and the functions it may hold (a bind in a branch keeps both possible). */
interface Binding {
  taint: Taint;
  fns: readonly Fn[];
}

/** What a node is as a callee: the functions it may be, and the data it may be instead (called opaquely). */
interface Callee {
  fns: readonly Fn[];
  data: Taint;
}

/** Variables of one block or lambda call; lookups go outwards, as JSONata's frames do. */
class Frame {
  private readonly vars = new Map<string, Binding>();
  constructor(private readonly parent?: Frame) {}
  lookup(name: string): Binding | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }
  /** `overwrite` for a block's own `$x := …`; a bind that may not run (in a branch) keeps the old value possible. */
  bind(name: string, b: Binding, overwrite: boolean): void {
    const old = overwrite ? undefined : this.lookup(name);
    this.vars.set(name, old ? { taint: join(old.taint, b.taint), fns: [...old.fns, ...b.fns] } : b);
  }
}

interface Ctx {
  frame: Frame;
  /** `$`: the scope at the top, the current item inside a path step. */
  dollar: Taint;
  /** `$$`: the scope. */
  root: Taint;
  /** `params.x` keys a literal allowlist (or the caller) vouches for. */
  trusted: ReadonlySet<string>;
  /** How the text this expression goes into quotes literals. */
  dialect: Dialect;
}

interface Run {
  /** The most user data an `&` concatenated. */
  concat: Level;
  depth: number;
  /** Lambdas being applied (a recursive call is not followed again). */
  calling: Set<AstNode>;
}

/** An argument: its node and where it is evaluated, or (given to a lambda, `~>`'s left side, the context) a taint. */
interface Arg {
  node?: AstNode;
  ctx?: Ctx;
  taint?: Taint;
  callee?: Callee;
}

const MAX_DEPTH = 400;

export interface Analysis {
  /** What the expression yields. */
  taint: Taint;
  /** The most user data an `&` concatenated on the way (`concatenated into` rather than `placed in`). */
  concat: Level;
}

export interface AnalyseOptions {
  /** `params.x` keys known to be safe (the params the advanced KQL filter builder compiles). */
  trusted?: ReadonlySet<string>;
  /** How the text the result goes into quotes literals (default `any`). */
  dialect?: Dialect;
}

/** Follows user data through `ast` (a JSONata AST) evaluated against `scope`. */
export function analyse(ast: unknown, scope: Taint, opts: AnalyseOptions = {}): Analysis {
  const run: Run = { concat: CLEAN, depth: 0, calling: new Set() };
  const ctx: Ctx = {
    frame: new Frame(),
    dollar: scope,
    root: scope,
    trusted: opts.trusted ?? new Set(),
    dialect: opts.dialect ?? 'any',
  };
  const result = taint(ast, ctx, run);
  return { taint: result, concat: run.concat };
}

function taint(node: unknown, ctx: Ctx, run: Run): Taint {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return CLEAN;
  if (run.depth >= MAX_DEPTH) return RAW;
  run.depth++;
  try {
    const n = node as AstNode;
    const t = own(n, ctx, run);
    // `rows{ key: value }`: a grouping over what the node yields replaces it.
    const group = n.group as AstNode | undefined;
    return group ? object(group.lhs, { ...ctx, dollar: t }, run) : t;
  } finally {
    run.depth--;
  }
}

function own(n: AstNode, ctx: Ctx, run: Run): Taint {
  switch (n.type) {
    case 'lambda':
      // JSONata wraps a lambda body's tail call in a thunk it runs at once: its value is the call's.
      if (n.thunk === true) return taint(n.body, ctx, run);
      return fnValue({ lambda: n, closure: ctx }, run);
    case 'partial':
      return fnValue({ partial: n, closure: ctx }, run);
    case 'transform':
      return fnValue({ transform: n, closure: ctx }, run);
    case 'string':
      return quoteNeutral([String(n.value)], ctx.dialect) ? CLEAN : MAY_QUOTE;
    case 'number':
    case 'value':
    case 'regex':
      return CLEAN;
    case 'name':
      return get(ctx.dollar, String(n.value));
    case 'variable': {
      const name = String(n.value);
      // `$$ := …` rebinds the root in that block.
      const b = ctx.frame.lookup(name);
      if (b) return bindingValue(b, run);
      if (name === '') return ctx.dollar;
      if (name === '$') return ctx.root;
      return CLEAN;
    }
    case 'wildcard':
    case 'descendant':
      return level(ctx.dollar);
    case 'parent':
      return RAW;
    case 'path':
      return path(n, ctx, run);
    case 'unary':
      if (n.value === '-') return CLEAN;
      if (n.value === '[')
        return ((n.expressions as unknown[] | undefined) ?? []).reduce<Taint>(
          (acc, e) => join(acc, taint(e, ctx, run)),
          CLEAN,
        );
      if (n.value === '{') return object(n.lhs, ctx, run);
      return children(n, ctx, run);
    case 'binary':
      return binary(n, ctx, run);
    case 'condition': {
      const guarded = new Set([...ctx.trusted, ...allowlisted(n.condition)]);
      return join(taint(n.then, { ...ctx, trusted: guarded }, run), taint(n.else, ctx, run));
    }
    case 'block': {
      const inner = { ...ctx, frame: new Frame(ctx.frame) };
      const exprs = (n.expressions as AstNode[] | undefined) ?? [];
      let t: Taint = CLEAN;
      exprs.forEach((e, i) => {
        t = e?.type === 'bind' ? bind(e, inner, run, true, i === exprs.length - 1) : taint(e, inner, run);
      });
      return t;
    }
    case 'bind':
      return bind(n, ctx, run, false);
    case 'function':
      return call(n, ctx, run);
    case 'apply':
      return applyOperator(n, ctx, run);
    case 'sort':
      return ctx.dollar;
    default:
      return children(n, ctx, run);
  }
}

/** Anything not modelled: whatever user data its parts carry. */
function children(n: AstNode, ctx: Ctx, run: Run): Level {
  let out: Level = CLEAN;
  for (const v of Object.values(n))
    if (v && typeof v === 'object')
      for (const c of Array.isArray(v) ? v : [v]) out = max(out, level(taint(c, ctx, run)));
  return out;
}

function path(n: AstNode, ctx: Ctx, run: Run): Taint {
  if (ctx.dollar === ctx.root) {
    const key = pathKey(n);
    if (key && ctx.trusted.has(key)) return CLEAN;
  }
  let t: Taint = ctx.dollar;
  ((n.steps as AstNode[] | undefined) ?? []).forEach((s, i) => {
    const step = i === 0 ? ctx : { ...ctx, dollar: t };
    const value = taint(s, step, run);
    // `a@$x.b`: $x is the item; the next step still reads the context `a` was read from.
    if (typeof s.focus === 'string') {
      ctx.frame.bind(s.focus, { taint: value, fns: [] }, false);
      t = join(step.dollar, value);
    } else t = value;
    if (typeof s.index === 'string') ctx.frame.bind(s.index, { taint: CLEAN, fns: [] }, false);
  });
  return t;
}

/** `{ 'k': v, … }`: a taint per literal key; computed keys and their values go to `rest`. */
function object(pairs: unknown, ctx: Ctx, run: Run): Shape {
  const fields = new Map<string, Taint>();
  let rest: Level = CLEAN;
  for (const [k, v] of (Array.isArray(pairs) ? pairs : []) as Array<[AstNode, AstNode]>) {
    const value = taint(v, ctx, run);
    if (k?.type === 'string' && typeof k.value === 'string') {
      const before = fields.get(k.value);
      fields.set(k.value, before === undefined ? value : join(before, value));
    } else rest = max(rest, max(level(taint(k, ctx, run)), level(value)));
  }
  return { fields, rest };
}

/** Operators whose result is a number, a boolean or a range of numbers. */
const NON_TEXT_OPERATORS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'and',
  'or',
  'in',
  '..',
]);

/** A `&` with nothing else on it: one link of a chain `a & b & c`. */
const chainLink = (n: unknown): n is AstNode =>
  !!n &&
  typeof n === 'object' &&
  (n as AstNode).type === 'binary' &&
  (n as AstNode).value === '&' &&
  Object.keys(n).every(
    (k) => k === 'type' || k === 'value' || k === 'lhs' || k === 'rhs' || k === 'position',
  );

function binary(n: AstNode, ctx: Ctx, run: Run): Taint {
  if (NON_TEXT_OPERATORS.has(String(n.value))) return CLEAN;
  if (n.value !== '&') return max(level(taint(n.lhs, ctx, run)), level(taint(n.rhs, ctx, run)));
  const operands: AstNode[] = [];
  const flatten = (x: AstNode): void => {
    if (x !== n && chainLink(x)) {
      flatten(x.lhs as AstNode);
      flatten(x.rhs as AstNode);
    } else operands.push(x);
  };
  flatten(n.lhs as AstNode);
  flatten(n.rhs as AstNode);
  const levels = operands.map((o) => level(taint(o, ctx, run)));
  const items: QuoteItem[] = operands.map((o, i) =>
    o.type === 'string' ? String(o.value) : levels[i]! & MAY_QUOTE ? null : '',
  );
  let out: Level = CLEAN;
  // Allowlisted text inside a literal of the chain (`"name eq '" & $replace(…) & "'"`), an encoded value outside one.
  levels.forEach((l, i) => {
    out = max(out, place(l, items.slice(0, i), items.slice(i + 1), ctx.dialect) & ~MAY_QUOTE);
  });
  if (!quoteNeutral(items, ctx.dialect)) out |= MAY_QUOTE;
  run.concat = max(run.concat, out);
  return out;
}

/**
 * How a kind of text quotes literals: OData `$filter` / `$orderby` / `$expand` with `'` (doubled to escape), a Graph
 * `$search` clause with `"` (backslash escapes), KQL with `'` and `"` (backslash escapes, `@'…'` verbatim, `//`
 * comments). `any`: what holds in all of them (datasource and step results, before anyone knows where they go).
 */
export type Dialect = 'odata' | 'search' | 'kql' | 'any';
const DIALECTS = ['odata', 'search', 'kql'] as const;
const QUOTES: Record<(typeof DIALECTS)[number], string> = { odata: "'", search: '"', kql: '\'"' };

/** The quote state after `text` (`''` outside, else the open quote, `@` first for a KQL verbatim string). */
function scan(
  text: string,
  state: string,
  dialect: (typeof DIALECTS)[number],
  until?: (s: string) => boolean,
): string {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!state) {
      if (dialect === 'kql' && c === '/' && text[i + 1] === '/') {
        const end = text.indexOf('\n', i);
        i = end < 0 ? text.length : end;
      } else if (QUOTES[dialect].includes(c)) state = dialect === 'kql' && text[i - 1] === '@' ? `@${c}` : c;
    } else if (c === '\\' && dialect !== 'odata' && !state.startsWith('@')) i++;
    else if (c === state.at(-1)) state = '';
    if (until?.(state)) return state;
  }
  return state;
}

/** Texts around values: a literal's text, `''` for a value that holds no quotes, `null` for one that may. */
export type QuoteItem = string | null;

/** The value between `before` and `after` sits inside a quoted literal (closed after it) in this dialect. */
export function insideQuotes(
  before: readonly QuoteItem[],
  after: readonly QuoteItem[],
  dialect: Dialect,
): boolean {
  if (dialect === 'any') return DIALECTS.every((d) => insideQuotes(before, after, d));
  let state = '';
  for (const item of before) {
    if (item === null) return false;
    state = scan(item, state, dialect);
  }
  if (!state) return false;
  for (const item of after) {
    if (item === null) return false;
    if (scan(item, state, dialect, (s) => s === '') === '') return true;
  }
  return false;
}

/** The text before a value leaves no literal open (in every dialect, for `any`). */
export function outsideQuotes(before: readonly QuoteItem[], dialect: Dialect): boolean {
  if (dialect === 'any') return DIALECTS.every((d) => outsideQuotes(before, d));
  let state = '';
  for (const item of before) {
    if (item === null) return false;
    state = scan(item, state, dialect);
  }
  return state === '';
}

/** Needs a place outside any literal: values that bring their own quotes (`$odata`, `$kql`, a quoted literal). */
const OUTSIDE = ENC_ODATA | ENC_KQL | QUOTED | SEARCH_PLACED;
/** Needs a place inside a literal: allowlisted text, a `$odataSearch` value (it escapes, it doesn't quote). */
const INSIDE = NEEDS_QUOTES | ENC_SEARCH;

/**
 * A value placed between literal texts: one that needs to be inside a literal and is becomes QUOTED (or
 * SEARCH_PLACED); one that must be outside and isn't — or can't be told, because it may hold quotes of its own —
 * is unsafe anywhere. One that needs a literal and has none here keeps the need for the text around this one.
 */
export function place(
  f: Level,
  before: readonly QuoteItem[],
  after: readonly QuoteItem[],
  dialect: Dialect,
): Level {
  if (f & ANYWHERE || !(f & (OUTSIDE | INSIDE))) return f;
  if (f & MAY_QUOTE || (f & OUTSIDE && f & INSIDE)) return f | ANYWHERE;
  if (f & OUTSIDE) return outsideQuotes(before, dialect) ? f : f | ANYWHERE | MISPLACED;
  if (!insideQuotes(before, after, dialect)) return f;
  return (f & ~INSIDE) | (f & NEEDS_QUOTES ? QUOTED : 0) | (f & ENC_SEARCH ? SEARCH_PLACED : 0);
}

/** Texts that leave every quote state as they found it (so they can sit anywhere without moving a quote). */
export function quoteNeutral(items: readonly QuoteItem[], dialect: Dialect): boolean {
  if (dialect === 'any') return DIALECTS.every((d) => quoteNeutral(items, d));
  if (items.includes(null)) return false;
  // (Inside a KQL verbatim string, text that closes and reopens it leaves a normal string: the quotes still match.)
  const starts = ['', ...QUOTES[dialect]];
  return starts.every(
    (start) => items.reduce<string>((st, item) => scan(item!, st, dialect), start) === start,
  );
}

/** `$x := …` (a block's own binds overwrite; `value` when the bind's value is used, e.g. last in its block). */
function bind(n: AstNode, ctx: Ctx, run: Run, overwrite: boolean, value = true): Taint {
  const lhs = n.lhs as AstNode | undefined;
  if (lhs?.type !== 'variable') return taint(n.rhs, ctx, run);
  const c = callee(n.rhs as AstNode, ctx, run);
  const b: Binding = { taint: c.data, fns: c.fns };
  ctx.frame.bind(String(lhs.value), b, overwrite);
  return value ? bindingValue(b, run) : CLEAN;
}

/** A variable's value: its data, and what the functions it may hold can return. */
const bindingValue = (b: Binding, run: Run): Taint =>
  b.fns.reduce<Taint>((acc, fn) => join(acc, fnValue(fn, run)), b.taint);

/**
 * A function used as data: what it can return besides its arguments (a lambda's body with its parameters clean, a
 * partial's fixed arguments, a transform's update). Called later from where it was stored, it is called opaquely.
 */
function fnValue(fn: Fn, run: Run): Level {
  if (fn.lambda) return level(applyLambda(fn, [], run));
  if (fn.partial || fn.transform) return level(invoke(fn, [], fn.closure!, run));
  return fn.captured ?? CLEAN;
}

/** What a node is when it is called or given as a function. */
function callee(node: AstNode | undefined, ctx: Ctx, run: Run): Callee {
  if (!node) return { fns: [], data: CLEAN };
  switch (node.type) {
    case 'lambda':
      if (node.thunk !== true) return { fns: [{ lambda: node, closure: ctx }], data: CLEAN };
      break;
    case 'partial':
      return { fns: [{ partial: node, closure: ctx }], data: CLEAN };
    case 'transform':
      return { fns: [{ transform: node, closure: ctx }], data: CLEAN };
    case 'variable': {
      const name = String(node.value);
      const b = ctx.frame.lookup(name);
      if (b) return { fns: b.fns, data: b.taint };
      if (name !== '' && name !== '$') return { fns: [{ builtin: name }], data: CLEAN };
      break;
    }
    case 'block': {
      const exprs = node.expressions as AstNode[] | undefined;
      if (exprs?.length === 1) return callee(exprs[0], { ...ctx, frame: new Frame(ctx.frame) }, run);
      break;
    }
  }
  return { fns: [], data: taint(node, ctx, run) };
}

function call(n: AstNode, ctx: Ctx, run: Run, first?: Taint): Taint {
  const args: Arg[] = ((n.arguments as AstNode[] | undefined) ?? []).map((node) => ({ node, ctx }));
  if (first !== undefined) args.unshift({ taint: first });
  return invokeCallee(callee(n.procedure as AstNode, ctx, run), args, ctx, run);
}

/** `x ~> $f(a)` is `$f(x, a)`; `x ~> $f` is `$f(x)`; `x ~> | … | … |` is a changed copy of x. */
function applyOperator(n: AstNode, ctx: Ctx, run: Run): Taint {
  const lhs = taint(n.lhs, ctx, run);
  const rhs = n.rhs as AstNode | undefined;
  if (rhs?.type === 'function') return call(rhs, ctx, run, lhs);
  return invokeCallee(callee(rhs, ctx, run), [{ taint: lhs }], ctx, run);
}

const argTaint = (a: Arg, run: Run): Taint => (a.taint ??= a.node ? taint(a.node, a.ctx!, run) : CLEAN);
const argCallee = (a: Arg, run: Run): Callee =>
  (a.callee ??= a.node ? callee(a.node, a.ctx!, run) : { fns: [], data: a.taint ?? CLEAN });

/** Every function the callee may be, joined; data called as a function is opaque. */
function invokeCallee(c: Callee, args: Arg[], ctx: Ctx, run: Run): Taint {
  let out: Taint = CLEAN;
  for (const fn of c.fns) out = join(out, invoke(fn, args, ctx, run));
  if (c.data !== CLEAN || !c.fns.length) out = join(out, opaque(level(c.data), args, run));
  return out;
}

/** An unknown function: whatever went in, and whatever it held, can come out. */
const opaque = (captured: Level, args: readonly Arg[], run: Run): Level =>
  args.reduce<Level>((acc, a) => max(acc, level(argTaint(a, run))), captured);

function invoke(fn: Fn, args: Arg[], ctx: Ctx, run: Run): Taint {
  if (fn.lambda)
    return applyLambda(
      fn,
      args.map((a) => argTaint(a, run)),
      run,
    );
  if (fn.partial) {
    // `$f(?, 0)`: the placeholders take the call's arguments, the rest are evaluated where the partial was written.
    const p = fn.partial;
    const closure = fn.closure!;
    let next = 0;
    const filled = ((p.arguments as AstNode[] | undefined) ?? []).map((a): Arg =>
      a.type === 'operator' && a.value === '?'
        ? (args[next++] ?? { taint: CLEAN })
        : { node: a, ctx: closure },
    );
    return invokeCallee(callee(p.procedure as AstNode, closure, run), filled, closure, run);
  }
  if (fn.transform) {
    const input = args[0] ? argTaint(args[0], run) : CLEAN;
    return max(level(input), level(taint(fn.transform.update, { ...fn.closure!, dollar: input }, run)));
  }
  if (fn.builtin !== undefined) return builtin(fn.builtin, args, ctx, run);
  return opaque(fn.captured ?? CLEAN, args, run);
}

function applyLambda(fn: Fn, args: Taint[], run: Run): Taint {
  const lambda = fn.lambda!;
  if (run.calling.has(lambda)) return args.reduce<Level>((acc, t) => max(acc, level(t)), CLEAN);
  run.calling.add(lambda);
  try {
    const closure = fn.closure!;
    const frame = new Frame(closure.frame);
    ((lambda.arguments as AstNode[] | undefined) ?? []).forEach((p, i) =>
      frame.bind(String(p.value), { taint: args[i] ?? CLEAN, fns: [] }, true),
    );
    return taint(lambda.body, { ...closure, frame }, run);
  } finally {
    run.calling.delete(lambda);
  }
}

/** The type an argument is known to have (`?` when it depends on the data). */
function kindOf(a: Arg, run: Run): string {
  const n = a.node;
  if (!n) return '?';
  switch (n.type) {
    case 'string':
      return 's';
    case 'number':
      return 'n';
    case 'value':
      return n.value === null ? 'l' : 'b';
    case 'regex':
    case 'partial':
      return 'f';
    case 'lambda':
      return n.thunk === true ? '?' : 'f';
    case 'unary':
      return n.value === '{' ? 'o' : n.value === '[' ? 'a' : n.value === '-' ? 'n' : '?';
    case 'binary':
      return n.value === '&'
        ? 's'
        : ['+', '-', '*', '/', '%'].includes(String(n.value))
          ? 'n'
          : n.value === '..'
            ? 'a'
            : NON_TEXT_OPERATORS.has(String(n.value))
              ? 'b'
              : '?';
    case 'function': {
      const p = n.procedure as AstNode | undefined;
      if (p?.type !== 'variable' || a.ctx?.frame.lookup(String(p.value))) return '?';
      return RESULT_KIND.get(String(p.value)) ?? '?';
    }
    case 'variable': {
      const c = argCallee(a, run);
      return c.fns.length && c.data === CLEAN ? 'f' : '?';
    }
    default:
      return '?';
  }
}

/** The arguments fit the parameters (JSONata's signature rules, `?` matching anything). */
function fits(kinds: readonly string[], params: readonly string[]): boolean {
  if (kinds.length > params.length) return false;
  return params.every((p, i) => {
    const types = p.replace('?', '');
    if (i >= kinds.length) return p.endsWith('?');
    const k = kinds[i]!;
    return k === '?' || types.includes('x') || types.includes(k);
  });
}

/**
 * JSONata hands a built-in the context as its first argument when the arguments given fit only that way
 * (`params.q.$substring(0, 5)`); when the data decides (`params.q.$substring($n, 5)`), the context may come out too.
 */
function withContext(name: string, given: Arg[], ctx: Ctx, run: Run): { args: Arg[]; extra: Taint } {
  const params = CONTEXT_PARAMS.get(name);
  if (!params) return { args: given, extra: CLEAN };
  const kinds = given.map((a) => kindOf(a, run));
  const without = fits(kinds, params);
  const withIt = fits([ctx.dollar === ctx.root ? 'o' : '?', ...kinds], params);
  if (withIt && !without) return { args: [{ taint: ctx.dollar }, ...given], extra: CLEAN };
  // A first parameter of any type always takes the first argument; otherwise any unknown type can tip it.
  const decidedFrom = params[0]!.includes('x') ? 1 : 0;
  if (withIt && kinds.slice(decidedFrom).includes('?')) return { args: given, extra: ctx.dollar };
  return { args: given, extra: CLEAN };
}

/**
 * `$replace(x, /[^…]/, '')` — every character outside a literal allowlist removed: TEXT when the allowlist has no
 * quote, backslash or line break, SEGMENT when it is letters, digits, `-` and `_` only, CLEAN when digits only. The
 * replacement must be a literal without `$` (`$0` would put the character back) and leave out the same.
 */
function stripped(args: readonly Arg[]): Level | undefined {
  if (args.length !== 3) return undefined;
  const pattern = args[1]!.node;
  const replacement = args[2]!.node;
  if (pattern?.type !== 'regex' || !(pattern.value instanceof RegExp)) return undefined;
  if (replacement?.type !== 'string' || typeof replacement.value !== 'string') return undefined;
  const re = pattern.value;
  const by = replacement.value;
  if (by.includes('$') || !/^\[\^(?:[^\\\]]|\\.)*\]$/.test(re.source)) return undefined;
  const probe = new RegExp(re.source, re.flags.replace(/[gy]/g, ''));
  const removes = (chars: string) => [...chars].every((c) => probe.test(c) && !by.includes(c));
  if (!removes(QUOTE_UNSAFE)) return undefined;
  return removes(PATH_UNSAFE + WORD_CHARS) ? CLEAN : removes(PATH_UNSAFE) ? SEGMENT : TEXT;
}

function builtin(name: string, given: Arg[], ctx: Ctx, run: Run): Taint {
  if (SAFE_RESULTS.has(name) || name === 'guid') return CLEAN;
  const { args, extra } = withContext(name, given, ctx, run);
  const levelOf = (i: number) => (args[i] ? level(argTaint(args[i]!, run)) : CLEAN);
  const all = () => args.reduce<Level>((acc, _, i) => max(acc, levelOf(i)), level(extra));

  // Safe as it is in its own kind of text when the argument was user data; a literal stays a literal.
  const encoded = ENCODER_FLAG.get(name);
  if (encoded !== undefined) return all() & ~MAY_QUOTE ? encoded : CLEAN;
  if (DECODERS.has(name)) return all() === CLEAN ? CLEAN : RAW;
  // A literal with a quote mixed into user data where the data decides (`$pad(x, 6, "'")`).
  if (
    ADDS_LITERALS.has(name) &&
    args.some(
      (a) => a.node?.type === 'string' && [...String(a.node.value)].some((c) => QUOTE_UNSAFE.includes(c)),
    ) &&
    all() & ~MAY_QUOTE
  )
    return RAW;
  // `$string` of anything but text is JSON, with quotes of its own.
  if (name === 'string' && args[0] && kindOf(args[0], run) !== 's') return all() === CLEAN ? CLEAN : RAW;
  if (name === 'replace') {
    const allow = stripped(args);
    if (allow !== undefined) return join(levelOf(0) === CLEAN ? CLEAN : allow, extra);
  }
  if (TAKES_APART.has(name)) {
    const l = all();
    // Encoded text taken apart is no longer encoded; quoted text taken apart may have lost its quotes.
    if (l & ENCODED) return RAW;
    return l & QUOTED ? l | NEEDS_QUOTES : l;
  }
  // `$lookup(object, key)` is a value of the object, whatever the key: one field for a literal key, any otherwise.
  if (name === 'lookup' && args.length === 2) {
    const object = argTaint(args[0]!, run);
    const key = args[1]!.node;
    return join(key?.type === 'string' ? get(object, String(key.value)) : anyValue(object), extra);
  }

  const data: Taint[] = [extra];
  const fns: Fn[] = [];
  for (const a of args) {
    const c = argCallee(a, run);
    fns.push(...c.fns);
    data.push(c.data);
  }
  const items = data.reduce<Taint>(join, CLEAN);
  if (!fns.length) return items;
  // A function given a function: what that function makes of the items.
  const apply = (fn: Fn, taints: Taint[]): Taint =>
    invoke(
      fn,
      taints.map((t) => ({ taint: t })),
      { ...ctx, dollar: CLEAN },
      run,
    );
  switch (name) {
    case 'map':
      return fns.reduce<Taint>((acc, fn) => join(acc, apply(fn, [items, CLEAN, items])), CLEAN);
    case 'each': {
      const v = anyValue(items);
      return fns.reduce<Taint>((acc, fn) => join(acc, apply(fn, [v, level(items), items])), CLEAN);
    }
    case 'filter':
    case 'single':
    case 'sort':
    case 'sift':
      return items;
    case 'reduce': {
      const start = items;
      const once = fns.reduce<Taint>((acc, fn) => join(acc, apply(fn, [start, items, CLEAN, items])), CLEAN);
      const twice = fns.reduce<Taint>(
        (acc, fn) => join(acc, apply(fn, [join(start, once), items, CLEAN, items])),
        CLEAN,
      );
      return join(join(data[2] ?? CLEAN, once), twice);
    }
    default:
      return fns.reduce<Taint>((acc, fn) => join(acc, apply(fn, data)), items);
  }
}
