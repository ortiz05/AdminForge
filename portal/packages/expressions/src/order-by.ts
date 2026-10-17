import jsonata from 'jsonata';
import { checkDeadline, DEADLINE_BINDING } from './budget';
import { MAX_SEQUENCE } from './limits';

/**
 * A fast `^( … )` (order-by) for evaluation. JSONata sorts with an asynchronous merge sort whose comparator evaluates
 * every sort term twice per comparison: 10k rows take over a second and 50k rows exhaust memory. Before an
 * expression is evaluated, each order-by that ends a path (`rows^(>createdDateTime)`, `$x[a > 1]^(name, >b)[0]`) is
 * rewritten into a call of a native decorate-sort-undecorate: every term is evaluated once per item (plain field
 * paths without JSONata at all), then the items are sorted natively — stably, undefined last, `>` descending, and
 * with JSONata's own errors (T2008 a term that isn't a string or number, T2007 strings mixed with numbers). A
 * constant slice right after it (`[[0..9]]`, on the sort or on the block around it) is taken natively too: JSONata
 * evaluates such a filter once per item.
 *
 * Shapes it doesn't rewrite keep JSONata's own sort: order-by in the middle of a path (`a^(x).b`), tuple streams
 * (`#$i`, `@$v`), the parent operator `%`, `$$` in a term, grouping. Only the evaluated copy is rewritten — the AST
 * that validation and lint read (`compile`) stays as written.
 */

type Node = Record<string, unknown> & { type?: string; value?: unknown };

/** Keys that bind tuples, refer outwards or group: such paths keep JSONata's sort. */
const UNSAFE_KEYS = new Set(['tuple', 'focus', 'index', 'ancestor', 'seekingParent', 'keepArray', 'group']);

export function unsafe(node: unknown): boolean {
  const stack: unknown[] = [node];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const n = v as Node;
    if (n.type === 'parent') return true;
    // `$$` (the root) can't be handed to a term evaluated on its own.
    if (n.type === 'variable' && n.value === '$') return true;
    for (const [k, x] of Object.entries(n)) {
      if (UNSAFE_KEYS.has(k)) return true;
      if (x && typeof x === 'object') stack.push(x);
    }
  }
  return false;
}

/** `name.name…` without anything else: read natively from the item. */
export function fieldPath(e: Node): string[] | undefined {
  const steps =
    e.type === 'name' ? [e] : e.type === 'path' && Array.isArray(e.steps) ? (e.steps as Node[]) : undefined;
  if (!steps?.length) return undefined;
  const names: string[] = [];
  for (const s of steps) {
    if (s.type !== 'name' || typeof s.value !== 'string') return undefined;
    if (Object.keys(s).some((k) => k !== 'type' && k !== 'value' && k !== 'position')) return undefined;
    names.push(s.value);
  }
  return names;
}

/** Variable names a term uses (passed to its own evaluation), `$` (the item) excluded. */
export function variables(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const x of node) variables(x, out);
  else if (node && typeof node === 'object') {
    const n = node as Node;
    if (n.type === 'variable' && typeof n.value === 'string' && n.value !== '') out.add(n.value);
    for (const x of Object.values(n)) if (x && typeof x === 'object') variables(x, out);
  }
  return out;
}

/** `[[a..b]]` with constant integer bounds, else undefined. */
function constantRange(stage: Node | undefined): [number, number] | undefined {
  if (!stage || stage.type !== 'filter') return undefined;
  const e = stage.expr as Node | undefined;
  if (
    !e ||
    e.type !== 'unary' ||
    e.value !== '[' ||
    !Array.isArray(e.expressions) ||
    e.expressions.length !== 1
  )
    return undefined;
  const r = e.expressions[0] as Node;
  const lhs = r.lhs as Node | undefined;
  const rhs = r.rhs as Node | undefined;
  if (r.type !== 'binary' || r.value !== '..' || lhs?.type !== 'number' || rhs?.type !== 'number')
    return undefined;
  const a = lhs.value as number;
  const b = rhs.value as number;
  return Number.isInteger(a) && Number.isInteger(b) ? [a, b] : undefined;
}

export interface Term {
  descending: boolean;
  /** Plain field path, read natively. */
  fields?: string[];
  /** Anything else: the term as its own expression, evaluated once per item with the outer variables bound. */
  expression?: jsonata.Expression;
  variables: string[];
}

/** What one order-by sorts by, and the constant slice taken right after it. */
export interface Spec {
  terms: Term[];
  slice?: [number, number];
  /**
   * JSONata's own sort of `$__afItems` by the same terms: used when the keys aren't all strings or all numbers per
   * term (mixed types, booleans, objects — JSONata's errors there depend on which pairs its merge sort compares).
   */
  fallback: jsonata.Expression;
  /** Variables the terms use (bound for the fallback). */
  variables: string[];
}

const ITEMS = '__afItems';

type Compile = (ast: Node) => jsonata.Expression;

const isOrderByCall = (n: Node | undefined): n is Node =>
  !!n && n.type === 'function' && (n.procedure as Node | undefined)?.value === '__afOrderBy';

/**
 * Rewrites the order-bys of `ast` in place, appending what each sorts by to `specs` (the native sort reads them by
 * index); `compileTerm` turns a term that isn't a plain field path into its own expression (with `$__afOrderBy`
 * registered over the same `specs`, for order-bys inside the term). Returns how many order-bys it rewrote.
 */
export function rewriteOrderBy(ast: Node, compileTerm: Compile, specs: Spec[]): number {
  let rewritten = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) visit(x);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const n = node as Node;
    // Children first: an order-by inside a term or a prefix is rewritten too.
    for (const x of Object.values(n)) if (x && typeof x === 'object') visit(x);

    // `(rows^(>at))[[0..9]]`: the block's leading constant slice is taken by the native sort.
    if (n.type === 'block' && Array.isArray(n.expressions) && n.expressions.length === 1) {
      const inner = n.expressions[0] as Node;
      const preds = n.predicate as Node[] | undefined;
      const range = constantRange(preds?.[0]);
      if (range && isOrderByCall(inner) && !inner.predicate) {
        const spec = specs[(inner.arguments as Node[])[1]!.value as number]!;
        if (!spec.slice) {
          spec.slice = range;
          if (preds!.length > 1) n.predicate = preds!.slice(1);
          else delete n.predicate;
        }
      }
      return;
    }

    if (n.type !== 'path' || !Array.isArray(n.steps)) return;
    const steps = n.steps as Node[];
    // The last order-by of the path; one before it stays in the prefix (and is rewritten there in turn).
    const k = steps.map((s) => s.type).lastIndexOf('sort');
    if (k < 1) return;
    const sort = steps[k]!;
    if (Object.keys(n).some((key) => key !== 'type' && key !== 'steps' && key !== 'position')) return;
    if (Object.keys(sort).some((key) => !['type', 'terms', 'position', 'stages'].includes(key))) return;
    const prefix = steps.slice(0, k);
    const after = steps.slice(k + 1);
    const terms = sort.terms as Array<{ descending?: boolean; expression: Node }>;
    if (!Array.isArray(terms) || !terms.length || unsafe(prefix) || unsafe(terms) || unsafe(after)) return;
    const stages = sort.stages as Node[] | undefined;
    if (stages?.some((s) => s.type !== 'filter')) return;
    const slice = constantRange(stages?.[0]);
    const rest = slice ? stages!.slice(1) : stages;
    const spec: Spec = {
      terms: terms.map((t) => {
        const fields = fieldPath(t.expression);
        return fields
          ? { descending: t.descending === true, fields, variables: [] }
          : {
              descending: t.descending === true,
              expression: compileTerm(t.expression),
              variables: [...variables(t.expression)],
            };
      }),
      ...(slice ? { slice } : {}),
      fallback: compileTerm({
        type: 'path',
        steps: [
          { type: 'variable', value: ITEMS, position: sort.position },
          { type: 'sort', terms, position: sort.position },
        ],
      }),
      variables: [...variables(terms.map((t) => t.expression))],
    };
    const id = specs.push(spec) - 1;
    rewritten++;
    const position = sort.position;
    const source: Node = { type: 'path', steps: prefix };
    visit(source);
    const call: Node = {
      type: 'function',
      value: '(',
      position,
      procedure: { type: 'variable', value: '__afOrderBy', position },
      arguments: [source, { type: 'number', value: id, position }],
      // The order-by's other filters (`[0]`, `[price > 5]`) apply to the sorted result, as before.
      ...(rest?.length ? { predicate: rest } : {}),
    };
    for (const key of Object.keys(n)) delete n[key];
    if (!after.length) {
      Object.assign(n, call);
      return;
    }
    // `rows^(x).name`: the sorted sequence is bound in a block and the path goes on from that variable — a path that
    // starts with a variable is evaluated once, whatever the context, like the original prefix.
    const name = `__afSorted${id}`;
    Object.assign(n, {
      type: 'block',
      position,
      expressions: [
        { type: 'bind', value: ':=', position, lhs: { type: 'variable', value: name, position }, rhs: call },
        { type: 'path', position, steps: [{ type: 'variable', value: name, position }, ...after] },
      ],
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

/**
 * A field path on one item, with JSONata's path rules: values of the steps before the last flatten; at the last step a
 * single array value stays an array (so it fails the sort as T2008, as in JSONata), several values form a sequence,
 * one value stands for itself.
 */
export function pluck(item: unknown, fields: string[]): unknown {
  // Own properties only, as JSONata reads them (never `toString`, `constructor` or anything inherited).
  const field = (v: unknown, f: string) =>
    v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, f)
      ? (v as Record<string, unknown>)[f]
      : undefined;
  // The usual case — one field of an object — without the sequence bookkeeping.
  if (fields.length === 1 && item && typeof item === 'object' && !Array.isArray(item))
    return field(item, fields[0]!);
  let current: unknown[] = Array.isArray(item) ? item : [item];
  for (let s = 0; s < fields.length; s++) {
    const results: unknown[] = [];
    for (const v of current) {
      const x = field(v, fields[s]!);
      if (x !== undefined) results.push(x);
    }
    if (s === fields.length - 1 && results.length === 1) return results[0];
    current = results.flatMap((x) => (Array.isArray(x) ? x : [x]));
    if (!current.length) return undefined;
  }
  return current.length === 1 ? current[0] : current;
}

/**
 * JSONata's index-range filter `[[a..b]]` on a sequence: each index in the range (a negative one counts from the
 * end) selects that item; items come out in their order, an item selected by two indexes twice.
 */
/** JSONata's own limit on a range (`[a..b]`): D2014 beyond 1e7 items. */
const MAX_RANGE = 1e7;

function take(items: unknown[], [a, b]: [number, number]): unknown[] {
  const n = items.length;
  if (b < a) return [];
  if (b - a + 1 > MAX_RANGE) throw { code: 'D2014', stack: new Error().stack, value: b - a + 1 };
  const hits = new Array<number>(n).fill(0);
  // Only indexes that can land on an item matter: [a..b] ∩ [-n, n-1].
  for (let v = Math.max(a, -n); v <= Math.min(b, n - 1); v++) hits[v < 0 ? n + v : v]!++;
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) for (let k = 0; k < hits[i]!; k++) out.push(items[i]);
  return out;
}

/** A result sequence as JSONata hands it on: empty is nothing, one item is that item. */
const sequence = (items: unknown[]): unknown =>
  items.length === 0 ? undefined : items.length === 1 ? items[0] : items;

/** Every defined key of one term is a string, or every one a number: the native comparison is exactly JSONata's. */
function clean(values: unknown[]): boolean {
  let kind: string | undefined;
  for (const v of values) {
    if (v === undefined) continue;
    const t = typeof v;
    if (t !== 'string' && t !== 'number') return false;
    if (kind && kind !== t) return false;
    kind = t;
  }
  return true;
}

/** The native order-by registered as `$__afOrderBy` on an expression rewritten by `rewriteOrderBy`. */
export function orderByFunction(specs: Spec[]) {
  return async function orderBy(this: Focus, input: unknown, id: number): Promise<unknown> {
    const spec = specs[id]!;
    const { terms, slice } = spec;
    if (input === undefined) return undefined;
    // JSONata sorts a sequence: one value stands for itself, and a one-item sequence is that item.
    if (!Array.isArray(input)) return slice ? sequence(take([input], slice)) : input;
    if (input.length <= 1) return sequence(slice ? take(input, slice) : input);
    if (input.length > MAX_SEQUENCE) throw new Error(`order-by: at most ${MAX_SEQUENCE} items can be sorted`);
    // The whole evaluation's deadline (budget.ts): every row's term gets only what is left of it.
    const deadline = this.environment.lookup(DEADLINE_BINDING);
    const outer = (names: string[]) => {
      const bindings: Record<string, unknown> = { [DEADLINE_BINDING]: deadline };
      for (const v of names) bindings[v] = this.environment.lookup(v);
      return bindings;
    };
    const n = input.length;
    const keys: unknown[][] = [];
    let native = true;
    for (const term of terms) {
      const values = new Array<unknown>(n);
      if (term.fields) for (let i = 0; i < n; i++) values[i] = pluck(input[i], term.fields);
      else {
        const bindings = outer(term.variables);
        for (let i = 0; i < n; i++) {
          checkBudget(this);
          checkDeadline(deadline, 0);
          values[i] = await term.expression!.evaluate(input[i], bindings);
        }
      }
      keys.push(values);
      if (!clean(values)) {
        native = false;
        break;
      }
    }
    checkBudget(this);
    let sorted: unknown[];
    if (native) {
      const order = Array.from({ length: n }, (_, i) => i);
      order.sort((a, b) => {
        for (let t = 0; t < terms.length; t++) {
          const va = keys[t]![a] as string | number | undefined;
          const vb = keys[t]![b] as string | number | undefined;
          if (va === vb) continue;
          // Undefined last, whatever the direction.
          if (va === undefined) return 1;
          if (vb === undefined) return -1;
          const c = va < vb ? -1 : 1;
          return terms[t]!.descending ? -c : c;
        }
        return a - b; // stable, as JSONata's merge sort
      });
      sorted = order.map((i) => input[i]);
      // A native sort of up to 1M items runs to completion: check the budget right after it.
      checkBudget(this);
      checkDeadline(deadline, 0);
    } else {
      // Keys JSONata compares only pair by pair (mixed types, booleans, objects): its own sort decides, errors included.
      const out = await spec.fallback.evaluate(undefined, { ...outer(spec.variables), [ITEMS]: input });
      sorted = out === undefined ? [] : Array.isArray(out) ? out : [out];
      if (!slice) return out;
    }
    return slice ? sequence(take(sorted, slice)) : sorted;
  };
}
