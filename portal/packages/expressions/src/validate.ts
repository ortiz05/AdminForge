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

/** `$eval(…)` anywhere in an expression (disabled at runtime: it would run code taken from data). */
function callsEval(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(callsEval);
  const n = node as { type?: string; value?: unknown };
  if (n.type === 'variable' && n.value === 'eval') return true;
  return Object.values(node).some((v) => typeof v === 'object' && callsEval(v));
}

/** A variable named like AdminForge's internal bindings (`$__afDeadline`, `$__afOrderBy`, …): reserved. */
function usesInternal(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(usesInternal);
  const n = node as { type?: string; value?: unknown };
  if (n.type === 'variable' && typeof n.value === 'string' && n.value.startsWith('__af')) return true;
  return Object.values(node).some((v) => typeof v === 'object' && usesInternal(v));
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
            const ast = compile(seg.source).ast();
            if (callsEval(ast))
              issues.push({
                ...at,
                expression: seg.source,
                message: '$eval is not available in AdminForge expressions.',
              });
            if (usesInternal(ast))
              issues.push({
                ...at,
                expression: seg.source,
                message: 'Variables starting with $__af are reserved for AdminForge itself.',
              });
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

/** The encoders that make user data safe in a query (their result is never user data). */
const ENCODERS = new Set(['odata', 'odataSearch', 'kql', 'encode', 'guid']);

/**
 * The root scope (`$`, `$$`) or a wildcard / descendant (`*`, `**`) — or a path starting with one: it reaches
 * `params`, `inputs`, `row` and the rest without naming them (`$.*.q`, `**.q`, `$.params.q`).
 */
function reachesScope(n: AstNode | undefined, aliases: ReadonlySet<string> = new Set()): boolean {
  if (!n) return false;
  if (n.type === 'variable' && (n.value === '' || n.value === '$' || aliases.has(String(n.value))))
    return true;
  if (n.type === 'wildcard' || n.type === 'descendant') return true;
  // A path starting with anything built from the scope: `$lookup($$, 'params').q`, `$sift($, …).params.q`.
  if (n.type === 'path') return !!n.steps?.length && fromScope(n.steps[0], aliases);
  // A block is what its last expression is, with the variables it binds from the scope: `($).params.q`,
  // `($p := $; $p.params.q)`.
  if (n.type === 'block' && Array.isArray(n.expressions) && n.expressions.length) {
    const exprs = n.expressions as AstNode[];
    const inner = new Set(aliases);
    for (const e of exprs.slice(0, -1))
      if (
        e.type === 'bind' &&
        (e.lhs as AstNode | undefined)?.type === 'variable' &&
        fromScope(e.rhs as AstNode, inner)
      )
        inner.add(String((e.lhs as AstNode).value));
    return fromScope(exprs[exprs.length - 1], inner);
  }
  return false;
}

/** `$each($, …)`, `$join($sift($, …))`, `$lookup($$, 'params')`: built from the scope, through any non-encoder. */
function fromScope(n: AstNode | undefined, aliases: ReadonlySet<string> = new Set()): boolean {
  if (!n) return false;
  if (reachesScope(n, aliases)) return true;
  if (n.type !== 'function' || !Array.isArray(n.arguments)) return false;
  const name = (n.procedure as AstNode | undefined)?.value;
  return (
    typeof name === 'string' &&
    !ENCODERS.has(name) &&
    (n.arguments as AstNode[]).some((a) => fromScope(a, aliases))
  );
}

const isUserData = (n: AstNode | undefined, trusted: ReadonlySet<string>): boolean => {
  if (!n) return false;
  if (fromScope(n)) return true;
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

/**
 * KQL text: a string at key `query` (resourceGraph / logAnalytics datasources and steps, `kql` probe checks), or the
 * `Query` of a request body (Graph `POST /security/runHuntingQuery` — Defender advanced hunting).
 */
const isKqlQuery = (segments: readonly PathSegment[]) => {
  const key = segments[segments.length - 1];
  return key === 'query' || (key === 'Query' && segments[segments.length - 2] === 'body');
};

/** OData system query options whose text Microsoft parses as an expression (`$filter`, `$search`, `$orderby`). */
const ODATA_OPTIONS: Record<string, string> = {
  $filter: '$filter',
  $search: '$search',
  $orderby: '$orderby',
};
/** Their unprefixed spellings inside a request body (Intune report exports, `getXxxReport` actions, …). */
const ODATA_BODY_OPTIONS: Record<string, string> = {
  filter: '$filter',
  search: '$search',
  orderby: '$orderby',
};

/**
 * The OData option a string is the text of (or an item of, e.g. `orderBy: ['name asc']`): a `$filter` / `$search` /
 * `$orderby` key anywhere (request query, ARM query, a body), or `filter` / `search` / `orderBy` inside a request
 * `body`. Widget settings such as `filter: facet` or `search: true` are not in a body and stay out of scope.
 */
function odataOption(segments: readonly PathSegment[]): { key: string; option: string } | undefined {
  let i = segments.length - 1;
  while (i >= 0 && typeof segments[i] === 'number') i--;
  const key = segments[i];
  if (typeof key !== 'string') return undefined;
  if (Object.hasOwn(ODATA_OPTIONS, key)) return { key, option: ODATA_OPTIONS[key]! };
  const lower = key.toLowerCase();
  if (Object.hasOwn(ODATA_BODY_OPTIONS, lower) && segments.slice(0, i).includes('body'))
    return { key, option: ODATA_BODY_OPTIONS[lower]! };
  return undefined;
}

const ODATA_HELPER: Record<string, string> = {
  $filter: '$odata() (or another quoting helper such as $guid() or $number())',
  $search: '$odataSearch()',
  $orderby: "a literal allowlist (params.x in ['a', 'b'] ? … : …)",
};

/** Params compiled server-side into safe KQL by the advanced filter builder (`filters.advanced` with `dialect: kql`). */
function compiledKqlParams(def: unknown): string[] {
  const adv = (def as { filters?: { advanced?: { dialect?: unknown; param?: unknown } } } | null)?.filters
    ?.advanced;
  return adv && adv.dialect === 'kql' && typeof adv.param === 'string' ? [`params.${adv.param}`] : [];
}

/**
 * Lint (§5.10, §7.9, R12): user data (`params`, `inputs`, `row`, …) reaching OData `$filter` / `$search` /
 * `$orderby` text (query or request body) without `$odata()` / `$odataSearch()` — either concatenated with `&` or
 * interpolated straight into the text (`startswith(displayName,'${ params.q }')`) —, user data reaching a KQL `query`
 * without `$kql()` (the same two forms), and user data placed inside a request `path` / `url`
 * (`/users/${ params.id }`) without `$encode()`. Wrapping the value in a helper (`$odata`, `$kql`, `$guid`, `$number`,
 * …), guarding it with a literal allowlist (`params.x in ['a', 'b'] ? … : …`), or a param the advanced KQL filter
 * builder compiles clears the warning. Returns warnings; expressions that do not compile are skipped
 * (validateExpressions reports them).
 */
export function lintExpressions(def: unknown, opts: WalkOptions = {}): ExpressionIssue[] {
  const issues: ExpressionIssue[] = [];
  const trustedKql: ReadonlySet<string> = new Set(compiledKqlParams(def));
  const none: ReadonlySet<string> = new Set();
  walkStrings(
    def,
    (str, segments) => {
      const key = segments[segments.length - 1];
      const odata = odataOption(segments);
      const kql = isKqlQuery(segments);
      const pathLike = key === 'path' || key === 'url';
      if (!hasTemplate(str) || (!odata && !kql && !pathLike)) return;
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
              message: `User data is concatenated into ${odata.key} without ${ODATA_HELPER[odata.option]}.`,
            });
          // Unlike a path or KQL text, an OData option is never user data as a whole either: that would be a raw
          // filter param (advanced filters are compiled server-side instead).
          else if (odata && yieldsUserData(ast, none))
            issues.push({
              ...at,
              message: `User data is placed in ${odata.key} without ${ODATA_HELPER[odata.option]}.`,
            });
          else if (kql && (rawConcat(ast, trustedKql) || (mixed && yieldsUserData(ast, trustedKql))))
            issues.push({
              ...at,
              message:
                'User data reaches the KQL query without $kql() (or another quoting helper such as $guid()).',
            });
          else if (pathLike && (rawConcat(ast, none) || (mixed && yieldsUserData(ast, none))))
            issues.push({
              ...at,
              message: `User data is placed in the ${key} without $encode() (or another helper such as $guid()).`,
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
