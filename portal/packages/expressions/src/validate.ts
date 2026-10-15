import { compile, ExpressionError } from './evaluate';
import { hasTemplate, splitTemplate, TemplateError } from './template';

export type PathSegment = string | number;

export interface ExpressionIssue {
  /** Dotted path, e.g. `steps[1].request.path`. */
  path: string;
  segments: PathSegment[];
  /** The template or expression text that failed. */
  expression: string;
  message: string;
  position?: number;
}

export interface WalkOptions {
  /** Return true to skip a subtree. Default: skips top-level `tests` (literal test data) and `$schema`. */
  skip?: (segments: readonly PathSegment[]) => boolean;
}

const defaultSkip = (s: readonly PathSegment[]) => s.length === 1 && (s[0] === 'tests' || s[0] === '$schema');

export function formatPath(segments: readonly PathSegment[]): string {
  return segments.reduce<string>(
    (out, seg) =>
      typeof seg === 'number'
        ? `${out}[${seg}]`
        : /^[A-Za-z_$][\w$-]*$/.test(seg)
          ? out
            ? `${out}.${seg}`
            : seg
          : `${out}[${JSON.stringify(seg)}]`,
    '',
  );
}

/** Visits every string in a definition with its path. */
function walkStrings(
  value: unknown,
  visit: (s: string, segments: PathSegment[]) => void,
  opts: WalkOptions,
  segments: PathSegment[] = [],
): void {
  if ((opts.skip ?? defaultSkip)(segments)) return;
  if (typeof value === 'string') visit(value, segments);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, visit, opts, [...segments, i]));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) walkStrings(v, visit, opts, [...segments, k]);
}

/** Compiles every `${ … }` in a definition and reports the ones that are malformed. Empty array = all good. */
export function validateExpressions(def: unknown, opts: WalkOptions = {}): ExpressionIssue[] {
  const issues: ExpressionIssue[] = [];
  walkStrings(
    def,
    (str, segments) => {
      if (!hasTemplate(str)) return;
      const at = { path: formatPath(segments), segments };
      try {
        for (const seg of splitTemplate(str)) {
          if (seg.type !== 'expr') continue;
          try {
            compile(seg.source);
          } catch (err) {
            const e = err as ExpressionError;
            issues.push({
              ...at,
              expression: seg.source,
              message: e.reason ?? e.message,
              position: e.position,
            });
          }
        }
      } catch (err) {
        if (!(err instanceof TemplateError)) throw err;
        issues.push({ ...at, expression: str, message: err.message, position: err.position });
      }
    },
    opts,
  );
  return issues;
}

/** Every expression source in a definition (useful for reference scans such as `env.X`). */
export function collectExpressions(
  def: unknown,
  opts: WalkOptions = {},
): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  walkStrings(
    def,
    (str, segments) => {
      if (!hasTemplate(str)) return;
      try {
        for (const seg of splitTemplate(str))
          if (seg.type === 'expr') out.push({ path: formatPath(segments), source: seg.source });
      } catch {
        // malformed templates are reported by validateExpressions
      }
    },
    opts,
  );
  return out;
}

const USER_DATA_ROOTS = new Set(['params', 'inputs', 'row', 'rows', 'item', 'value']);
type AstNode = { type?: string; value?: unknown; steps?: AstNode[] } & Record<string, unknown>;

/** `params.q` → "params.q"; undefined for anything that is not a plain name/path. */
function pathKey(n: AstNode | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'name') return String(n.value);
  if (n.type === 'path' && n.steps?.every((s) => s.type === 'name'))
    return n.steps.map((s) => String(s.value)).join('.');
  return undefined;
}

const isUserData = (n: AstNode | undefined, trusted: ReadonlySet<string>): boolean => {
  if (!n) return false;
  const root =
    n.type === 'name'
      ? String(n.value)
      : n.type === 'path' && n.steps?.[0]?.type === 'name'
        ? String(n.steps[0].value)
        : undefined;
  if (!root || !USER_DATA_ROOTS.has(root)) return false;
  const key = pathKey(n);
  return !(key && trusted.has(key));
};

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
  const key = literal ? pathKey(n.lhs as AstNode) : undefined;
  return key ? [key] : [];
}

/** Walks an AST, extending `trusted` with allowlist guards for the `then` branch of conditionals. */
function someNode(
  node: unknown,
  trusted: ReadonlySet<string>,
  test: (n: AstNode, trusted: ReadonlySet<string>) => boolean,
): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((v) => someNode(v, trusted, test));
  const n = node as AstNode;
  if (test(n, trusted)) return true;
  if (n.type === 'condition') {
    const guarded = new Set([...trusted, ...allowlisted(n.condition)]);
    return (
      someNode(n.condition, trusted, test) ||
      someNode(n.then, guarded, test) ||
      someNode(n.else, trusted, test)
    );
  }
  return Object.values(n).some((v) => typeof v === 'object' && someNode(v, trusted, test));
}

/** `… & params.q & …` — user data concatenated as-is. */
const rawConcat = (ast: unknown, trusted: ReadonlySet<string>) =>
  someNode(
    ast,
    trusted,
    (n, t) =>
      n.type === 'binary' &&
      n.value === '&' &&
      (isUserData(n.lhs as AstNode, t) || isUserData(n.rhs as AstNode, t)),
  );

/** User data as the value itself: `params.q`, or a conditional / block whose result can be such a path. */
function yieldsUserData(node: unknown, trusted: ReadonlySet<string>): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as AstNode;
  if (isUserData(n, trusted)) return true;
  if (n.type === 'condition')
    return (
      yieldsUserData(n.then, new Set([...trusted, ...allowlisted(n.condition)])) ||
      yieldsUserData(n.else, trusted)
    );
  if (n.type === 'block' && Array.isArray(n.expressions))
    return yieldsUserData(n.expressions.at(-1), trusted);
  return false;
}

/** KQL text: a string at key `query` (resourceGraph / logAnalytics datasources and steps, `kql` probe checks). */
const isKqlQuery = (segments: readonly PathSegment[]) => segments[segments.length - 1] === 'query';

/** Params compiled server-side into safe KQL by the advanced filter builder (`filters.advanced` with `dialect: kql`). */
function compiledKqlParams(def: unknown): string[] {
  const adv = (def as { filters?: { advanced?: { dialect?: unknown; param?: unknown } } } | null)?.filters
    ?.advanced;
  return adv && adv.dialect === 'kql' && typeof adv.param === 'string' ? [`params.${adv.param}`] : [];
}

/**
 * Lint (§5.10, §7.9, R12): user data concatenated into `$filter` / `$search` without `$odata()` / `$odataSearch()`,
 * and user data (`params`, `inputs`, `row`, …) reaching a KQL `query` without `$kql()` — either concatenated with `&`
 * or interpolated straight into the query text (`where name == '${ params.q }'`). Wrapping the value in a helper
 * (`$kql`, `$guid`, `$number`, …), guarding it with a literal allowlist (`params.x in ['a', 'b'] ? … : …`), or a param
 * the advanced KQL filter builder compiles clears the warning. Returns warnings; expressions that do not compile are
 * skipped (validateExpressions reports them).
 */
export function lintExpressions(def: unknown, opts: WalkOptions = {}): ExpressionIssue[] {
  const issues: ExpressionIssue[] = [];
  const trustedKql: ReadonlySet<string> = new Set(compiledKqlParams(def));
  const none: ReadonlySet<string> = new Set();
  walkStrings(
    def,
    (str, segments) => {
      const key = segments[segments.length - 1];
      const odata = key === '$filter' || key === '$search';
      const kql = isKqlQuery(segments);
      if (!hasTemplate(str) || (!odata && !kql)) return;
      try {
        const parts = splitTemplate(str);
        const mixed = parts.some((p) => p.type === 'text' && p.value.trim() !== '');
        for (const seg of parts) {
          if (seg.type !== 'expr') continue;
          let ast: unknown;
          try {
            ast = compile(seg.source).ast();
          } catch {
            continue;
          }
          const at = { path: formatPath(segments), segments, expression: seg.source };
          if (odata && rawConcat(ast, none))
            issues.push({
              ...at,
              message: `User data is concatenated into ${key} without ${key === '$filter' ? '$odata()' : '$odataSearch()'}.`,
            });
          else if (kql && (rawConcat(ast, trustedKql) || (mixed && yieldsUserData(ast, trustedKql))))
            issues.push({
              ...at,
              message:
                'User data reaches the KQL query without $kql() (or another quoting helper such as $guid()).',
            });
        }
      } catch {
        // malformed templates are reported by validateExpressions
      }
    },
    opts,
  );
  return issues;
}
