import type jsonata from 'jsonata';
import { checkDeadline, DEADLINE_BINDING } from './budget';
import { MAX_SEQUENCE } from './limits';
import { fieldPath, pluck, unsafe, variables } from './order-by';

/**
 * A native grouping constructor (`rows{ id: name }`, `$x{ key: { "a": a } }`) for evaluation. JSONata evaluates the
 * value of every group at once (`Promise.all`), and each pending evaluation counts towards the shared depth guard, so
 * a lookup with more than a few hundred distinct keys failed with D1011 ("nested or recursing too deeply") — and was
 * slow before that. Before an expression is evaluated, each grouping whose key and value expressions don't bind tuples
 * or refer outwards is rewritten into a call of a native group-by: items are grouped by key in one pass (plain field
 * paths and string literals without JSONata at all), then each group's value is evaluated in turn. JSONata's own
 * semantics are kept: a key must be a string (T1003), one key may not come from two pairs (D1009), the internal flags
 * are refused as keys (D1013), several items with one key are appended into a sequence the value sees, an empty input
 * still builds literal keys, and the result has no prototype (a key "__proto__" is just a key).
 *
 * Shapes it doesn't rewrite keep JSONata's own grouping: tuple streams (`#$i`, `@$v`), the parent operator `%`, `$$`.
 * Only the evaluated copy is rewritten — the AST that validation and lint read (`compile`) stays as written.
 */

type Node = Record<string, unknown> & { type?: string; value?: unknown };

/**
 * One key or value: a constant or a field path read natively, an object constructor with string keys and such values
 * built natively (`{ "n": n, "k": nested.k }`), anything else as its own expression.
 */
interface Part {
  literal?: unknown;
  fields?: string[];
  object?: Array<[string, Part]>;
  expression?: jsonata.Expression;
  variables: string[];
}

export interface GroupSpec {
  pairs: Array<{ key: Part; value: Part }>;
}

type Compile = (ast: Node) => jsonata.Expression;

const LITERALS = new Set(['string', 'number', 'value']);

/** A part read without JSONata: a literal or a plain field path. */
function simple(ast: Node): Part | undefined {
  if (
    LITERALS.has(ast.type ?? '') &&
    Object.keys(ast).every((k) => ['type', 'value', 'position'].includes(k))
  )
    return { literal: ast.value, variables: [] };
  const fields = fieldPath(ast);
  return fields ? { fields, variables: [] } : undefined;
}

/** `{ "a": x, "b": y.z }` with distinct string keys and simple values, else undefined. */
function objectPart(ast: Node): Part | undefined {
  if (ast.type !== 'unary' || ast.value !== '{' || !Array.isArray(ast.lhs)) return undefined;
  if (Object.keys(ast).some((k) => !['type', 'value', 'lhs', 'position'].includes(k))) return undefined;
  const pairs: Array<[string, Part]> = [];
  const seen = new Set<string>();
  for (const [k, v] of ast.lhs as Array<[Node, Node]>) {
    if (k.type !== 'string' || typeof k.value !== 'string' || seen.has(k.value)) return undefined;
    if (k.value === '_jsonata_lambda' || k.value === '_jsonata_function') return undefined;
    const value = simple(v);
    if (!value) return undefined;
    seen.add(k.value);
    pairs.push([k.value, value]);
  }
  return pairs.length ? { object: pairs, variables: [] } : undefined;
}

function part(ast: Node, compile: Compile): Part {
  const quick = simple(ast) ?? objectPart(ast);
  if (quick) return quick;
  if (
    LITERALS.has(ast.type ?? '') &&
    Object.keys(ast).every((k) => ['type', 'value', 'position'].includes(k))
  )
    return { literal: ast.value, variables: [] };
  const fields = fieldPath(ast);
  if (fields) return { fields, variables: [] };
  return { expression: compile(ast), variables: [...variables(ast)] };
}

/** Step and source types whose one-item sequence could hold an array (JSONata would unwrap it before the call). */
const UNWRAPPING = new Set(['function', 'partial', 'block', 'condition', 'apply', 'unary', 'bind', 'lambda']);

/**
 * A source the native group-by sees exactly as JSONata's grouping does: a variable, or a path of names (and filters)
 * starting with a name or a variable. A function call, block, condition or array constructor can produce a one-item
 * sequence holding an array, which JSONata unwraps before passing it on (`$map(rows, …){ … }` with one row) — those
 * keep JSONata's own grouping.
 */
function plainSource(n: Node): boolean {
  if (UNWRAPPING.has(n.type ?? '')) return false;
  if (n.type === 'variable') return true;
  if (n.type !== 'path' || !Array.isArray(n.steps)) return false;
  return (n.steps as Node[]).every((s, i) => s.type === 'name' || (i === 0 && s.type === 'variable'));
}

/**
 * Rewrites the groupings of `ast` in place, appending what each groups by to `specs` (the native group-by reads them
 * by index); `compilePart` turns a key or value that isn't a literal or a plain field path into its own expression.
 * Returns how many groupings it rewrote.
 */
export function rewriteGroupBy(ast: Node, compilePart: Compile, specs: GroupSpec[]): number {
  let rewritten = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) visit(x);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const n = node as Node;
    // Children first: a grouping inside a key, a value or the input is rewritten too.
    for (const x of Object.values(n)) if (x && typeof x === 'object') visit(x);
    const group = n.group as { lhs?: Array<[Node, Node]>; position?: unknown } | undefined;
    if (!group || !Array.isArray(group.lhs) || !group.lhs.length) return;
    const { group: _drop, ...rest } = n;
    if (!plainSource(rest) || unsafe(rest) || unsafe(group.lhs)) return;
    const spec: GroupSpec = {
      pairs: group.lhs.map(([k, v]) => ({ key: part(k, compilePart), value: part(v, compilePart) })),
    };
    const id = specs.push(spec) - 1;
    rewritten++;
    const position = group.position ?? n.position;
    const source: Node = { ...rest };
    for (const key of Object.keys(n)) delete n[key];
    Object.assign(n, {
      type: 'function',
      value: '(',
      position,
      procedure: { type: 'variable', value: '__afGroupBy', position },
      arguments: [source, { type: 'number', value: id, position }],
    });
  };
  visit(ast);
  return rewritten;
}

type Focus = {
  environment: { lookup(name: string): unknown; base?: { guardrails?: () => void } };
};

/** JSONata's own timeout and depth check of the running evaluation (throws D1012 once the budget is spent). */
const checkBudget = (focus: Focus) => focus.environment.base?.guardrails?.();

const groupError = (code: 'T1003' | 'D1009' | 'D1013' | 'D2015', value: unknown) => ({
  code,
  stack: new Error().stack,
  value,
});

/**
 * JSONata's `$append` on the group's items (one value stands for itself; arrays flatten one level, the first item's
 * too) — in linear time: the arrays this group-by builds are its own (`owned`) and grow in place; input arrays are
 * never changed.
 */
function append(current: unknown, item: unknown, owned: WeakSet<unknown[]>): unknown {
  if (current === undefined) return item;
  if (item === undefined) return current;
  let a: unknown[];
  if (Array.isArray(current) && owned.has(current)) a = current;
  else {
    a = Array.isArray(current) ? [...current] : [current];
    owned.add(a);
  }
  if (Array.isArray(item)) for (const x of item) a.push(x);
  else a.push(item);
  if (a.length > MAX_SEQUENCE) throw groupError('D2015', a.length);
  return a;
}

/**
 * JSONata's object constructor on a context, for string keys and simple values: on a sequence every key's value reads
 * the whole sequence (the items share the key), on one item that item; undefined values are left out.
 */
function buildObject(pairs: Array<[string, Part]>, ctx: unknown): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const [k, p] of pairs) {
    const v = p.literal !== undefined ? p.literal : pluck(ctx, p.fields!);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The native group-by registered as `$__afGroupBy` on an expression rewritten by `rewriteGroupBy`. */
export function groupByFunction(specs: GroupSpec[]) {
  return async function groupBy(this: Focus, input: unknown, id: number): Promise<unknown> {
    const { pairs } = specs[id]!;
    // JSONata groups a sequence: one value stands for itself; nothing still builds the literal keys.
    const items = input === undefined ? [undefined] : Array.isArray(input) ? input : [input];
    if (!items.length) items.push(undefined);
    // The whole evaluation's deadline (budget.ts): every key and value gets only what is left of it, never a fresh
    // budget per row.
    const deadline = this.environment.lookup(DEADLINE_BINDING);
    const bindingsFor = (p: Part) => {
      const b: Record<string, unknown> = { [DEADLINE_BINDING]: deadline };
      for (const v of p.variables) b[v] = this.environment.lookup(v);
      return b;
    };
    const evaluatePart = async (p: Part, ctx: unknown, b: Record<string, unknown>) => {
      checkBudget(this);
      checkDeadline(deadline, 0);
      return p.expression!.evaluate(ctx, b);
    };
    const keyBindings = pairs.map((p) => bindingsFor(p.key));
    const valueBindings = pairs.map((p) => bindingsFor(p.value));
    const read = async (p: Part, ctx: unknown, b: Record<string, unknown>) =>
      p.literal !== undefined
        ? p.literal
        : p.fields
          ? pluck(ctx, p.fields)
          : p.object
            ? buildObject(p.object, ctx)
            : await evaluatePart(p, ctx, b);

    const groups = new Map<string, { data: unknown; pair: number }>();
    const owned = new WeakSet<unknown[]>();
    for (let i = 0; i < items.length; i++) {
      if ((i & 255) === 0) checkBudget(this);
      const item = items[i];
      for (let p = 0; p < pairs.length; p++) {
        const key = await read(pairs[p]!.key, item, keyBindings[p]!);
        if (key === undefined) continue;
        if (typeof key !== 'string') throw groupError('T1003', key);
        if (key === '_jsonata_lambda' || key === '_jsonata_function') throw groupError('D1013', key);
        const g = groups.get(key);
        if (!g) groups.set(key, { data: item, pair: p });
        else if (g.pair !== p) throw groupError('D1009', key);
        else g.data = append(g.data, item, owned);
      }
    }

    const result = Object.create(null) as Record<string, unknown>;
    let i = 0;
    for (const [key, g] of groups) {
      if ((i++ & 255) === 0) checkBudget(this);
      const value = await read(pairs[g.pair]!.value, g.data, valueBindings[g.pair]!);
      if (value !== undefined) result[key] = value;
    }
    checkBudget(this);
    checkDeadline(deadline, 0);
    return result;
  };
}
