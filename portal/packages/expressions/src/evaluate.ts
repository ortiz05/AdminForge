import jsonata from 'jsonata';
import { DEADLINE_BINDING, deadlineGuard } from './budget';
import { registerHelpers } from './helpers';
import { MAX_SEQUENCE, registerLimits } from './limits';
import { groupByFunction, rewriteGroupBy, type GroupSpec } from './group-by';
import { orderByFunction, rewriteOrderBy, type Spec } from './order-by';

/**
 * JSONata evaluation with AdminForge limits (§7.6): compiled expressions are cached (LRU), evaluation is timeboxed
 * (250 ms default) and depth-limited, ranges and sequences are capped at MAX_SEQUENCE items, built-ins that could
 * run long in one step are size-limited and `$eval` is disabled (limits.ts), and every error names the expression it
 * came from.
 */

/** Expression scope: `params`, `inputs`, `row`, `rows`, `value`, `steps`, `run`, `user`, `env`, `now`, … */
export type Scope = Record<string, unknown>;

export interface EvaluateOptions {
  /** Default 250. */
  timeoutMs?: number;
  /** Max evaluation depth (recursion guard). Default 500. */
  maxDepth?: number;
  /**
   * Compile for evaluation: order-bys (`^( … )`) are rewritten into a native sort (order-by.ts). `evaluate` sets it;
   * validation and lint read the AST as written (the default).
   */
  forEvaluation?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 250;
export const DEFAULT_MAX_DEPTH = 500;

const short = (expr: string) => (expr.length > 200 ? `${expr.slice(0, 197)}…` : expr);

export class ExpressionError extends Error {
  /** Where in a definition the expression sits (set by renderTemplate / validateExpressions). */
  path?: string;
  constructor(
    readonly reason: string,
    readonly expression: string,
    readonly code?: string,
    readonly position?: number,
  ) {
    super(`${reason} — in expression: ${short(expression)}`);
    this.name = 'ExpressionError';
  }
}

export class ExpressionTimeoutError extends ExpressionError {
  constructor(expression: string, timeoutMs: number) {
    super(`Expression timed out after ${timeoutMs} ms`, expression, 'D1012');
    this.name = 'ExpressionTimeoutError';
  }
}

interface JsonataFailure {
  code?: string;
  message?: string;
  position?: number;
  token?: string;
}

function toExpressionError(err: unknown, expr: string, timeoutMs: number): ExpressionError {
  if (err instanceof ExpressionError) return err;
  const e = (err ?? {}) as JsonataFailure;
  if (e.code === 'D1012') return new ExpressionTimeoutError(expr, timeoutMs);
  if (e.code === 'D1011')
    return new ExpressionError('Expression is nested or recursing too deeply', expr, e.code, e.position);
  return new ExpressionError(e.message ?? String(err), expr, e.code, e.position);
}

/** Small LRU over Map insertion order. */
class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: V): void {
    this.map.delete(key);
    this.map.set(key, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  get size(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
}

const cache = new Lru<jsonata.Expression>(1000);

/** Compiles (or returns the cached) expression with helpers registered. Throws ExpressionError on syntax errors. */
export function compile(expr: string, opts: EvaluateOptions = {}): jsonata.Expression {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stack = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const key = `${opts.forEvaluation ? 'eval:' : ''}${timeout}:${stack}:${expr}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let compiled: jsonata.Expression;
  try {
    compiled = jsonata(expr, { timeout, stack, sequence: MAX_SEQUENCE });
  } catch (err) {
    const e = err as JsonataFailure;
    throw new ExpressionError(`Invalid expression: ${e.message ?? String(err)}`, expr, e.code, e.position);
  }
  registerHelpers(compiled);
  registerLimits(compiled);
  if (opts.forEvaluation) fastPaths(compiled, timeout, stack);
  cache.set(key, compiled);
  return compiled;
}

/**
 * Rewrites `compiled`'s groupings and order-bys into the native group-by (group-by.ts) and sort (order-by.ts) and
 * registers them. Sub-expressions (a key, a value, a sort term) get both, so either may nest in the other.
 */
function fastPaths(compiled: jsonata.Expression, timeout: number, stack: number): void {
  const groupSpecs: GroupSpec[] = [];
  const sortSpecs: Spec[] = [];
  const group = groupByFunction(groupSpecs);
  const sort = orderByFunction(sortSpecs);
  const register = (e: jsonata.Expression) => {
    e.registerFunction('__afGroupBy', group);
    e.registerFunction('__afOrderBy', sort);
  };
  const term = (ast: Record<string, unknown>): jsonata.Expression => {
    const sub = jsonata('0', { timeout, stack, sequence: MAX_SEQUENCE });
    const root = sub.ast() as unknown as Record<string, unknown>;
    for (const k of Object.keys(root)) delete root[k];
    Object.assign(root, ast);
    registerHelpers(sub);
    registerLimits(sub);
    register(sub);
    // Every step checks the whole evaluation's deadline (budget.ts) when the caller binds it: a sub-expression
    // evaluated once per row gets what is left of the budget, not a fresh one per row.
    sub.assign(Symbol.for('jsonata.__evaluate_entry') as unknown as string, deadlineGuard(timeout));
    return sub;
  };
  const ast = compiled.ast() as unknown as Record<string, unknown>;
  // Groupings first: an order-by whose path held a grouping can then use the native sort too.
  const grouped = rewriteGroupBy(ast, term, groupSpecs);
  const sorted = rewriteOrderBy(ast, term, sortSpecs);
  if (grouped || sorted) register(compiled);
}

/** Number of cached compiled expressions (for tests and metrics). */
export const compileCacheSize = (): number => cache.size;
export const clearCompileCache = (): void => cache.clear();

/** Converts JSONata sequences to plain arrays and drops functions, so results are plain JSON-like data. */
function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === 'function') return undefined;
  if (v && typeof v === 'object') {
    if ('_jsonata_lambda' in v || '_jsonata_function' in v) return undefined;
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      // A data key "__proto__" (a grouping by a value from the tenant) stays a key, never the copy's prototype.
      if (k === '__proto__')
        Object.defineProperty(out, k, {
          value: plain(val),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      else out[k] = plain(val);
    }
    return out;
  }
  return v;
}

/** Evaluates a JSONata expression (without `${ }`) against the scope. Async; timeboxed. */
export async function evaluate(
  expr: string,
  scope: Scope = {},
  opts: EvaluateOptions = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const compiled = compile(expr, { ...opts, forEvaluation: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // JSONata checks the timeout at every evaluation step; the timer is a backstop for anything that yields instead.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExpressionTimeoutError(expr, timeoutMs)), timeoutMs + 50);
  });
  try {
    // The absolute deadline, for the native fast paths' per-row sub-expressions (budget.ts).
    const bindings = { [DEADLINE_BINDING]: Date.now() + timeoutMs };
    return plain(await Promise.race([compiled.evaluate(scope, bindings), deadline]));
  } catch (err) {
    throw toExpressionError(err, expr, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}
