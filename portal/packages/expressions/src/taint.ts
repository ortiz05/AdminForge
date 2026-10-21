/**
 * Taint analysis behind the injection lint (validate.ts `lintExpressions`; §5.10, §7.9, R12). It follows user data —
 * page params, playbook inputs, rows, items, a datasource's result — through an expression the way JSONata evaluates
 * it, without evaluating anything: paths and their steps, `&`, conditionals, blocks and their variables, lambdas
 * (bound to a variable, given to `$map`, `$filter`, `$reduce`, …, applied with `~>`), object and array constructors,
 * and every function call. It ends at:
 *   - the encoders `$odata`, `$odataSearch`, `$kql`, `$encode` and `$guid`;
 *   - functions whose result is a number, a boolean or a date (`$number`, `$count`, `$exists`, `$daysAgo`, …);
 *   - a literal allowlist (`params.x in ['a', 'b'] ? … params.x … : …`) and the params a caller vouches for;
 *   - a character allowlist, `$replace(x, /[^…]/, '')`: when the allowlist has no quotes, backslashes or line breaks
 *     the result is TEXT — safe inside a quoted OData or KQL literal, not in a path —, and CLEAN when it is letters,
 *     digits, `-` and `_` only.
 * Objects keep a taint per field, so `ds.scope.path` (encoded in its transform) is clean while `ds.scope.label` (the
 * param as it came) is not.
 */

type AstNode = { type?: string; value?: unknown } & Record<string, unknown>;

export const CLEAN = 0;
/** Text without quotes, backslashes or line breaks (a character allowlist): fine in a quoted literal, not in a path. */
export const TEXT = 1;
export const RAW = 2;
export type Level = typeof CLEAN | typeof TEXT | typeof RAW;

/** An object whose fields differ: a taint per field, `rest` for any other key; `resolve` works a field out on demand. */
export interface Shape {
  readonly fields: ReadonlyMap<string, Taint>;
  readonly rest: Level;
  readonly resolve?: (key: string) => Taint | undefined;
  readonly keys?: () => readonly string[];
}
export type Taint = Level | Shape;

const max = (a: Level, b: Level): Level => (a > b ? a : b);
const min = (a: Level, b: Level): Level => (a < b ? a : b);

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
    if (out === RAW) break;
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

/** The encoders: their result is never user data. */
export const ENCODERS = new Set(['odata', 'odataSearch', 'kql', 'encode', 'guid']);

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

/**
 * Built-ins JSONata hands the context (`$`) as their first argument when it is left out (`params.q.$trim()`,
 * `$lookup('params')`): how many arguments they take with it, and the type that argument must have.
 */
const CONTEXT_ARGUMENT = new Map<string, readonly [number, 's' | 'n' | 'o' | 'x']>([
  ['string', [1, 'x']],
  ['substring', [2, 's']],
  ['substringBefore', [2, 's']],
  ['substringAfter', [2, 's']],
  ['lowercase', [1, 's']],
  ['uppercase', [1, 's']],
  ['trim', [1, 's']],
  ['pad', [2, 's']],
  ['match', [2, 's']],
  ['replace', [3, 's']],
  ['split', [2, 's']],
  ['base64encode', [1, 's']],
  ['base64decode', [1, 's']],
  ['encodeUrlComponent', [1, 's']],
  ['encodeUrl', [1, 's']],
  ['decodeUrlComponent', [1, 's']],
  ['decodeUrl', [1, 's']],
  ['formatNumber', [2, 'n']],
  ['formatBase', [1, 'n']],
  ['formatInteger', [2, 'n']],
  ['fromMillis', [1, 'n']],
  ['keys', [1, 'x']],
  ['lookup', [2, 'x']],
  ['spread', [1, 'x']],
  ['clone', [1, 'x']],
  ['sift', [1, 'o']],
  ['each', [2, 'o']],
]);

/** Characters that let text out of a quoted OData or KQL literal (or a Graph `$search` clause). */
const QUOTE_UNSAFE = '\'"\\`\n\r\t\0\v\f\u2028\u2029';
/** …and those that change a URL path (segments, query, fragment, escapes, dot segments, OData key syntax). */
const PATH_UNSAFE = `${QUOTE_UNSAFE} !#$%&()*+,./:;<=>?@[]^{|}~`;

/** A function as a value: a lambda with where it was written, a built-in by name, or something opaque (neither). */
interface Fn {
  lambda?: AstNode;
  closure?: Ctx;
  builtin?: string;
}
type Binding = { taint: Taint; fn?: undefined } | { fn: Fn; taint?: undefined };

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
    this.vars.set(
      name,
      old?.taint !== undefined && b.taint !== undefined ? { taint: join(old.taint, b.taint) } : b,
    );
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
}

interface Run {
  /** The most user data an `&` concatenated. */
  concat: Level;
  depth: number;
  /** Lambdas being applied (a recursive call is not followed again). */
  calling: Set<AstNode>;
}

/** An argument: its node, or (given to a lambda, or `~>`'s left side) only its taint. */
interface Arg {
  node?: AstNode;
  taint?: Taint;
  fn?: Fn | null;
}

const MAX_DEPTH = 400;

export interface Analysis {
  /** What the expression yields. */
  taint: Taint;
  /** The most user data an `&` concatenated on the way (`concatenated into` rather than `placed in`). */
  concat: Level;
}

/** Follows user data through `ast` (a JSONata AST) evaluated against `scope`. */
export function analyse(ast: unknown, scope: Taint, trusted: ReadonlySet<string> = new Set()): Analysis {
  const run: Run = { concat: CLEAN, depth: 0, calling: new Set() };
  const result = taint(ast, { frame: new Frame(), dollar: scope, root: scope, trusted }, run);
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
      return n.thunk === true ? taint(n.body, ctx, run) : CLEAN;
    case 'string':
    case 'number':
    case 'value':
    case 'regex':
    case 'partial':
    case 'transform':
      // Functions as values turn into '' as text.
      return CLEAN;
    case 'name':
      return get(ctx.dollar, String(n.value));
    case 'variable': {
      const name = String(n.value);
      if (name === '') return ctx.dollar;
      if (name === '$') return ctx.root;
      return ctx.frame.lookup(name)?.taint ?? CLEAN;
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
      let t: Taint = CLEAN;
      for (const e of (n.expressions as AstNode[] | undefined) ?? [])
        t = e?.type === 'bind' ? bind(e, inner, run, true) : taint(e, inner, run);
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
      ctx.frame.bind(s.focus, { taint: value }, false);
      t = join(step.dollar, value);
    } else t = value;
    if (typeof s.index === 'string') ctx.frame.bind(s.index, { taint: CLEAN }, false);
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

function binary(n: AstNode, ctx: Ctx, run: Run): Taint {
  if (NON_TEXT_OPERATORS.has(String(n.value))) return CLEAN;
  const found = max(level(taint(n.lhs, ctx, run)), level(taint(n.rhs, ctx, run)));
  if (n.value === '&') run.concat = max(run.concat, found);
  return found;
}

function bind(n: AstNode, ctx: Ctx, run: Run, overwrite: boolean): Taint {
  const lhs = n.lhs as AstNode | undefined;
  if (lhs?.type !== 'variable') return taint(n.rhs, ctx, run);
  const fn = fnOf(n.rhs, ctx);
  if (fn) {
    ctx.frame.bind(String(lhs.value), { fn }, true);
    return CLEAN;
  }
  const t = taint(n.rhs, ctx, run);
  ctx.frame.bind(String(lhs.value), { taint: t }, overwrite);
  return t;
}

/** The function a node stands for, or undefined when it is data. */
function fnOf(node: unknown, ctx: Ctx): Fn | undefined {
  const n = node as AstNode | undefined;
  if (!n) return undefined;
  switch (n.type) {
    case 'lambda':
      return n.thunk === true ? undefined : { lambda: n, closure: ctx };
    case 'variable': {
      const name = String(n.value);
      if (name === '' || name === '$') return undefined;
      const b = ctx.frame.lookup(name);
      return b ? b.fn : { builtin: name };
    }
    case 'partial':
    case 'transform':
      return {};
    case 'block': {
      const exprs = n.expressions as AstNode[] | undefined;
      return exprs?.length === 1 ? fnOf(exprs[0], ctx) : undefined;
    }
    default:
      return undefined;
  }
}

function call(n: AstNode, ctx: Ctx, run: Run, first?: Taint): Taint {
  const args: Arg[] = ((n.arguments as AstNode[] | undefined) ?? []).map((node) => ({ node }));
  if (first !== undefined) args.unshift({ taint: first });
  // A procedure that is data (a variable holding a value, a path, …) is called opaquely.
  return invoke(fnOf(n.procedure, ctx) ?? {}, args, ctx, run);
}

/** `x ~> $f(a)` is `$f(x, a)`; `x ~> $f` is `$f(x)`; `x ~> | … | … |` is a changed copy of x. */
function applyOperator(n: AstNode, ctx: Ctx, run: Run): Taint {
  const lhs = taint(n.lhs, ctx, run);
  const rhs = n.rhs as AstNode | undefined;
  if (rhs?.type === 'function') return call(rhs, ctx, run, lhs);
  if (rhs?.type === 'transform')
    return max(level(lhs), level(taint(rhs.update, { ...ctx, dollar: lhs }, run)));
  const fn = fnOf(rhs, ctx);
  if (fn) return invoke(fn, [{ taint: lhs }], ctx, run);
  return max(level(lhs), level(taint(rhs, ctx, run)));
}

const argTaint = (a: Arg, ctx: Ctx, run: Run): Taint => (a.taint ??= taint(a.node, ctx, run));
const argFn = (a: Arg, ctx: Ctx): Fn | null =>
  a.fn !== undefined ? a.fn : (a.fn = a.node ? (fnOf(a.node, ctx) ?? null) : null);

function invoke(fn: Fn, args: Arg[], ctx: Ctx, run: Run): Taint {
  if (fn.lambda)
    return applyLambda(
      fn,
      args.map((a) => argTaint(a, ctx, run)),
      run,
    );
  if (fn.builtin !== undefined) return builtin(fn.builtin, args, ctx, run);
  // Opaque: whatever goes in can come out.
  return args.reduce<Level>((acc, a) => max(acc, level(argTaint(a, ctx, run))), CLEAN);
}

function applyLambda(fn: Fn, args: Taint[], run: Run): Taint {
  const lambda = fn.lambda!;
  if (run.calling.has(lambda)) return args.reduce<Level>((acc, t) => max(acc, level(t)), CLEAN);
  run.calling.add(lambda);
  try {
    const closure = fn.closure!;
    const frame = new Frame(closure.frame);
    ((lambda.arguments as AstNode[] | undefined) ?? []).forEach((p, i) =>
      frame.bind(String(p.value), { taint: args[i] ?? CLEAN }, true),
    );
    return taint(lambda.body, { ...closure, frame }, run);
  } finally {
    run.calling.delete(lambda);
  }
}

/** JSONata hands the context to a built-in when its first argument is left out (or has the wrong type). */
function takesContext(name: string, args: readonly Arg[]): boolean {
  const spec = CONTEXT_ARGUMENT.get(name);
  if (!spec) return false;
  if (args.length < spec[0]) return true;
  if (spec[1] === 'x') return false;
  const first = args[0]?.node;
  const kind =
    first?.type === 'string'
      ? 's'
      : first?.type === 'number'
        ? 'n'
        : first?.type === 'value'
          ? 'b'
          : first?.type === 'regex' || first?.type === 'lambda'
            ? 'f'
            : first?.type === 'unary'
              ? first.value === '{'
                ? 'o'
                : 'a'
              : undefined;
  return kind !== undefined && kind !== spec[1];
}

/**
 * `$replace(x, /[^…]/, '')` — every character outside a literal allowlist removed: TEXT when the allowlist has no
 * quote, backslash or line break, CLEAN when it has nothing a path treats specially either (letters, digits, `-`,
 * `_`). A replacement must be a literal without `$` (`$0` would put the character back) and leave out the same.
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
  return removes(PATH_UNSAFE) ? CLEAN : removes(QUOTE_UNSAFE) ? TEXT : undefined;
}

function builtin(name: string, given: Arg[], ctx: Ctx, run: Run): Taint {
  if (ENCODERS.has(name) || SAFE_RESULTS.has(name)) return CLEAN;
  const args = takesContext(name, given) ? [{ taint: ctx.dollar }, ...given] : given;
  if (name === 'replace') {
    const allow = stripped(args);
    if (allow !== undefined) return min(allow, level(argTaint(args[0]!, ctx, run)));
  }
  // `$lookup(object, key)` is a value of the object, whatever the key: one field for a literal key, any otherwise.
  if (name === 'lookup' && args.length === 2) {
    const object = argTaint(args[0]!, ctx, run);
    const key = args[1]!.node;
    if (key?.type === 'string') return get(object, String(key.value));
    return typeof object === 'number'
      ? object
      : keysOf(object).reduce<Taint>((acc, k) => join(acc, get(object, k)), object.rest);
  }

  const data: Taint[] = [];
  const fns: Fn[] = [];
  for (const a of args) {
    const fn = argFn(a, ctx);
    if (fn) fns.push(fn);
    else data.push(argTaint(a, ctx, run));
  }
  const items = data.reduce<Taint>(join, CLEAN);
  if (!fns.length) return items;
  // A function given a function: what that function makes of the items.
  const apply = (fn: Fn, taints: Taint[]): Taint =>
    invoke(
      fn,
      taints.map((t) => ({ taint: t, fn: null })),
      { ...ctx, dollar: CLEAN },
      run,
    );
  switch (name) {
    case 'map':
      return fns.reduce<Taint>((acc, fn) => join(acc, apply(fn, [items, CLEAN, items])), CLEAN);
    case 'each': {
      const v = level(items);
      return fns.reduce<Taint>((acc, fn) => join(acc, apply(fn, [v, v, items])), CLEAN);
    }
    case 'filter':
    case 'single':
    case 'sort':
    case 'sift':
      return items;
    case 'reduce': {
      const init = data[1] ?? CLEAN;
      const start = join(init, items);
      const once = apply(fns[0]!, [start, items, CLEAN, items]);
      return join(init, apply(fns[0]!, [join(start, once), items, CLEAN, items]));
    }
    default:
      return fns.reduce<Taint>((acc, fn) => join(acc, apply(fn, data)), items);
  }
}
