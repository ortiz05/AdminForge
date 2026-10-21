import { compile, ExpressionError } from './evaluate';
import { analyse, CLEAN, join, level, pathKey, RAW, TEXT, type Shape, type Taint } from './taint';
import { hasTemplate, splitTemplate, TemplateError, wholeExpression } from './template';

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

/**
 * Scope roots whose values come from the person or the tenant: page params, playbook and runbook inputs, rows, items,
 * a transform's `value` (and the name a `forEach` gives its item). `ds` is worked out per datasource.
 */
const USER_DATA_ROOTS = ['params', 'inputs', 'row', 'rows', 'item', 'value'];

/** `forEach.as` names anywhere in a definition: user data inside the loop, like `item`. */
function forEachNames(def: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'forEach' && typeof o.as === 'string') out.add(o.as);
      Object.values(o).forEach(visit);
    }
  };
  visit(def);
  return [...out];
}

/** What an expression yields in `scope`; an expression that does not compile counts as user data. */
function expressionTaint(source: string, scope: Taint): Taint {
  try {
    return analyse(compile(source).ast(), scope).taint;
  } catch {
    return RAW;
  }
}

/** A template's value: a whole `${ … }` keeps its type (and its fields), mixed text is text. */
function templateTaint(str: string, scope: Taint): Taint {
  if (!hasTemplate(str)) return CLEAN;
  try {
    const parts = splitTemplate(str);
    const whole = wholeExpression(parts);
    if (whole !== undefined) return expressionTaint(whole, scope);
    return parts.reduce<Taint>(
      (acc, p) => (p.type === 'expr' ? join(acc, level(expressionTaint(p.source, scope))) : acc),
      CLEAN,
    );
  } catch {
    return RAW;
  }
}

/** A static datasource's `data`, rendered like any template (objects keep their fields). */
function dataTaint(value: unknown, scope: Taint): Taint {
  if (typeof value === 'string') return templateTaint(value, scope);
  if (Array.isArray(value)) return value.reduce<Taint>((acc, v) => join(acc, dataTaint(v, scope)), CLEAN);
  if (value && typeof value === 'object') {
    const fields = new Map<string, Taint>();
    for (const [k, v] of Object.entries(value)) fields.set(k, dataTaint(v, scope));
    return { fields, rest: CLEAN };
  }
  return CLEAN;
}

/**
 * The scope an expression of `def` sees, as taint: the user-data roots, and `ds` — per datasource (S-13), what its
 * result can carry: a Microsoft response is tenant data (like `value` in its transform); a static datasource is its
 * rendered `data`; a transform is what it makes of either. Worked out on demand; a datasource that depends on itself
 * counts as user data.
 */
function scopeTaint(def: unknown): Shape {
  const roots = new Map<string, Taint>();
  for (const name of [...USER_DATA_ROOTS, ...forEachNames(def)]) roots.set(name, RAW);
  const declared = (def as { datasources?: unknown } | null)?.datasources;
  const datasources =
    declared && typeof declared === 'object' && !Array.isArray(declared)
      ? (declared as Record<string, unknown>)
      : {};
  const done = new Map<string, Taint>();
  const busy = new Set<string>();
  const ds: Shape = {
    fields: done,
    rest: CLEAN,
    keys: () => Object.keys(datasources),
    resolve: (name) => {
      if (!Object.hasOwn(datasources, name)) return undefined;
      if (busy.has(name)) return RAW;
      busy.add(name);
      try {
        const d = (datasources[name] ?? {}) as { source?: unknown; data?: unknown; transform?: unknown };
        let result: Taint = d.source === 'static' ? dataTaint(d.data, scope) : RAW;
        if (typeof d.transform === 'string' && hasTemplate(d.transform))
          result = templateTaint(d.transform, {
            fields: new Map([...scope.fields, ['value', result]]),
            rest: CLEAN,
          });
        done.set(name, result);
        return result;
      } finally {
        busy.delete(name);
      }
    },
  };
  const scope: Shape = { fields: new Map([...roots, ['ds', ds]]), rest: CLEAN };
  return scope;
}

/** Param types whose value is an object id or a resource id the server checked (S-13: a whole path may be one). */
const ID_PARAM_TYPES = new Set(['guid', 'user', 'group', 'device', 'app', 'resource', 'subscription']);

/** `params.x` / `inputs.x` declared as a single guid or entity id (or a string with `format: guid`). */
function idParam(def: unknown, ast: unknown): boolean {
  const [root, name, ...rest] = pathKey(ast)?.split('.') ?? [];
  if (!name || rest.length || (root !== 'params' && root !== 'inputs')) return false;
  const declared = (def as Record<string, unknown> | null)?.[root] as Record<string, unknown> | undefined;
  const p =
    declared && Object.hasOwn(declared, name) ? (declared[name] as Record<string, unknown> | null) : null;
  if (!p || typeof p !== 'object' || typeof p.type !== 'string') return false;
  return (ID_PARAM_TYPES.has(p.type) && p.multiple !== true) || (p.type === 'string' && p.format === 'guid');
}

/** A user-data path (`params.kql`) and nothing else. */
const userDataPath = (ast: unknown) => USER_DATA_ROOTS.includes(pathKey(ast)?.split('.')[0] ?? '');

/** The explicit opt-in for a KQL query the person types whole (S-13). */
export const USER_QUERY_OPT_IN = '/* adminforge: user-query */';
const optedIn = (source: string) => /^\/\*\s*adminforge:\s*user-query\s*\*\//.test(source);

/**
 * KQL text: a string at key `query` (resourceGraph / logAnalytics datasources and steps, `kql` probe checks), or the
 * `Query` of a request body (Graph `POST /security/runHuntingQuery` — Defender advanced hunting).
 */
const isKqlQuery = (segments: readonly PathSegment[]) => {
  const key = segments[segments.length - 1];
  return key === 'query' || (key === 'Query' && segments[segments.length - 2] === 'body');
};

/**
 * OData system query options whose text Microsoft parses as an expression (`$filter`, `$search`, `$orderby`, and
 * `$expand`, which nests its own `$filter` / `$search`).
 */
const ODATA_OPTIONS: Record<string, string> = {
  $filter: '$filter',
  $search: '$search',
  $orderby: '$orderby',
  $expand: '$expand',
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
  $expand: "$odata() (or a literal allowlist: params.x in ['a', 'b'] ? … : …)",
};

/** Params compiled server-side into safe KQL by the advanced filter builder (`filters.advanced` with `dialect: kql`). */
function compiledKqlParams(def: unknown): string[] {
  const adv = (def as { filters?: { advanced?: { dialect?: unknown; param?: unknown } } } | null)?.filters
    ?.advanced;
  return adv && adv.dialect === 'kql' && typeof adv.param === 'string' ? [`params.${adv.param}`] : [];
}

/**
 * Lint (§5.10, §7.9, R12): user data reaching a query without an encoder. User data is what the person or the tenant
 * controls — `params`, `inputs`, `row`, `rows`, `item`, a transform's `value`, a `forEach` item, and a datasource's
 * result (`ds.<name>`, per field) — followed through functions, lambdas, `$map`, block variables and the rest
 * (taint.ts). Flagged:
 *   - OData `$filter` / `$search` / `$orderby` / `$expand` text (query or request body) with user data in it, without
 *     `$odata()` / `$odataSearch()` — concatenated with `&`, interpolated (`startswith(displayName,'${ params.q }')`)
 *     or as the whole value (a raw filter param; advanced filters are compiled server-side instead);
 *   - a KQL `query` with user data in it without `$kql()`; a whole query taken from a param needs the explicit opt-in
 *     comment `adminforge: user-query` at the start of the expression (USER_QUERY_OPT_IN — the person then runs the
 *     KQL they typed, with their own access);
 *   - a request `path` / `url` with user data in it without `$encode()` (`/users/${ params.id }`); a whole path or url
 *     may come straight from a param only when it is a single guid or entity id (`type: guid`, `resource`, …).
 * The encoders (`$odata`, `$odataSearch`, `$kql`, `$encode`, `$guid`), functions returning a number, a boolean or a
 * date (`$number`, `$count`, `$daysAgo`, …), a literal allowlist (`params.x in ['a', 'b'] ? … : …`), a param the
 * advanced KQL filter builder compiles, and — inside a quoted OData or KQL literal, not in a path — a character
 * allowlist without quotes (`$replace(params.q, /[^A-Za-z0-9 ._-]/, '')`) clear it. Returns warnings; expressions that
 * do not compile are skipped (validateExpressions reports them).
 */
export function lintExpressions(def: unknown, opts: WalkOptions = {}): ExpressionIssue[] {
  const issues: ExpressionIssue[] = [];
  const trustedKql: ReadonlySet<string> = new Set(compiledKqlParams(def));
  const none: ReadonlySet<string> = new Set();
  let scope: Shape | undefined;
  walkStrings(
    def,
    (str, segments) => {
      const key = segments[segments.length - 1];
      const odata = odataOption(segments);
      const kql = isKqlQuery(segments);
      const pathLike = key === 'path' || key === 'url';
      if (!hasTemplate(str) || (!odata && !kql && !pathLike)) return;
      let parts;
      try {
        parts = splitTemplate(str);
      } catch {
        return; // malformed templates are reported by validateExpressions
      }
      const whole = wholeExpression(parts) !== undefined;
      for (const seg of parts) {
        if (seg.type !== 'expr') continue;
        let ast: unknown;
        try {
          ast = compile(seg.source).ast();
        } catch {
          continue;
        }
        scope ??= scopeTaint(def);
        const found = analyse(ast, scope, kql ? trustedKql : none);
        const carries = level(found.taint);
        const at = { path: formatPath(segments), segments, expression: seg.source };
        if (odata) {
          // Unlike a path or KQL text, an OData option is never user data as a whole either: that would be a raw
          // filter param (advanced filters are compiled server-side instead).
          if (carries >= RAW)
            issues.push({
              ...at,
              message: `User data is ${found.concat >= RAW ? 'concatenated into' : 'placed in'} ${odata.key} without ${ODATA_HELPER[odata.option]}.`,
            });
        } else if (kql) {
          if (carries >= RAW && !(whole && optedIn(seg.source) && userDataPath(ast)))
            issues.push({
              ...at,
              message: `User data reaches the KQL query without $kql() (or another quoting helper such as $guid()).${
                whole && userDataPath(ast)
                  ? ` A query the person types whole needs the explicit opt-in ${USER_QUERY_OPT_IN} at the start of the expression.`
                  : ''
              }`,
            });
        } else if (carries >= TEXT && !(whole && idParam(def, ast)))
          issues.push({
            ...at,
            message: `User data is placed in the ${key} without $encode() (or another helper such as $guid()).${
              whole
                ? ` A whole ${key} may come straight from a param only when it is a guid or an entity id (type: guid, resource, subscription, …).`
                : ''
            }`,
          });
      }
    },
    opts,
  );
  return issues;
}
