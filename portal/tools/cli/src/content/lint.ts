/**
 * Content lint rules that the schema can't express: pure checks over one parsed definition, run by
 * `adminforge validate` (and therefore `publish`) through content/check.ts.
 *
 * - `bareDatasourceRefs`: a datasource's `when`/request/runner parameters naming another datasource without `ds.`.
 * - `datasourceOrderProblems`: `ds.<name>` used before that datasource is declared (or by itself).
 * - `scriptPinProblems`: a runner reference (`script` + `sha256`, in datasources, playbook steps and their
 *   compensations, schedules) whose pinned sha256 is not the sha256 of the file under portal/content/scripts — the
 *   runner refuses such a script at run time (§5.10), so validate fails first.
 * - `usersWriteProblems`: a Graph write (a `mode: write` step, a changing batch request, any compensation) naming a
 *   user after `/users/` — in its path or a body reference — by anything but `$guid(…)` or a literal GUID; the API
 *   refuses such a write at run time (S-15, execution/protected.ts), so validate fails first.
 *
 * Each returns plain records (where, what); check.ts turns them into `file:line path: message` errors. The rules stay
 * in the CLI rather than @adminforge/schemas because the expression rules need @adminforge/expressions'
 * `collectExpressions`, and schemas deliberately depends on nothing but yaml and zod. No I/O here: the script check is
 * handed a `sha256Of` lookup.
 */
import { collectExpressions, compile, splitTemplate } from '@adminforge/expressions';
import { formatPath } from '@adminforge/schemas';

/**
 * A datasource's `when`, request or runner parameters that name another datasource without `ds.` (`group.id` instead
 * of `ds.group.id`): there the name is undefined, so the datasource is always skipped or asks for nothing. (Widgets,
 * headers and actions do use bare names; transforms are left out because row fields can share a datasource's name.)
 */
export function bareDatasourceRefs(def: unknown): Array<{ path: string; name: string; datasource: string }> {
  const all = (def as { datasources?: Record<string, Record<string, unknown>> } | null)?.datasources;
  if (!all || typeof all !== 'object') return [];
  const names = Object.keys(all);
  const out: Array<{ path: string; name: string; datasource: string }> = [];
  for (const [ds, spec] of Object.entries(all)) {
    const scoped = Object.fromEntries(
      ['when', 'request', 'requests', 'parameters']
        .filter((k) => spec?.[k] !== undefined)
        .map((k) => [k, spec[k]]),
    );
    for (const e of collectExpressions(scoped)) {
      // String literals can mention a datasource's name harmlessly.
      const code = e.source.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""');
      for (const name of names)
        if (name !== ds && new RegExp(`(?<![\\w.$])${name}\\s*[.[]`).test(code))
          out.push({ path: `datasources.${ds}.${e.path}`, name, datasource: ds });
    }
  }
  return out;
}

/**
 * `ds.<name>` references to a datasource declared later in the file (or to itself). Authors list a datasource's
 * dependencies above it, which also rules out loops. (The runtime doesn't rely on this order — definitions published
 * while the Postgres column was jsonb lost it — so the executor follows the references instead.)
 */
export function datasourceOrderProblems(def: unknown): Array<{ datasource: string; message: string }> {
  const all = (def as { datasources?: Record<string, unknown> } | null)?.datasources;
  if (!all || typeof all !== 'object') return [];
  const names = Object.keys(all);
  const out: Array<{ datasource: string; message: string }> = [];
  for (const ds of names) {
    const refs = new Set<string>();
    for (const e of collectExpressions(all[ds]))
      for (const m of e.source.matchAll(/\bds\.([A-Za-z_][A-Za-z0-9_]*)/g))
        if (names.includes(m[1]!)) refs.add(m[1]!);
    for (const ref of refs) {
      if (ref === ds)
        out.push({ datasource: ds, message: `datasource "${ds}" uses its own result (ds.${ds}).` });
      else if (names.indexOf(ref) > names.indexOf(ds))
        out.push({
          datasource: ds,
          message: `datasource "${ds}" uses ds.${ref}, which is declared after it — declare the datasources it uses above it.`,
        });
    }
  }
  return out;
}

/** A runner reference whose pinned sha256 does not match its script file. */
export interface ScriptPinProblem {
  /** Path to the reference's `sha256` key (for `locate`). */
  segments: Array<string | number>;
  /** The same path, printable (`steps[1].sha256`, `datasources.mailbox.sha256`). */
  path: string;
  /** The `script` value: a path under portal/content/scripts. */
  script: string;
  /** The pinned value. */
  pinned: string;
  /** The file's sha256, or null when the file does not exist. */
  actual: string | null;
}

/**
 * Every runner reference (an object with string `script` and `sha256`) in `def` whose pin is not the file's sha256.
 * `sha256Of(script)` returns the sha256 of the file under portal/content/scripts, or null when there is none.
 */
export function scriptPinProblems(
  def: unknown,
  sha256Of: (script: string) => string | null,
): ScriptPinProblem[] {
  const out: ScriptPinProblem[] = [];
  const walk = (value: unknown, segments: Array<string | number>): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...segments, i]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const o = value as Record<string, unknown>;
    if (typeof o.script === 'string' && typeof o.sha256 === 'string') {
      const actual = sha256Of(o.script);
      if (actual !== o.sha256.toLowerCase()) {
        const at = [...segments, 'sha256'];
        out.push({ segments: at, path: formatPath(at), script: o.script, pinned: o.sha256, actual });
      }
    }
    for (const [k, v] of Object.entries(o)) walk(v, [...segments, k]);
  };
  walk(def, []);
  return out;
}

/** A Graph write that names a user by something other than an object id (S-15). */
export interface UsersWriteProblem {
  /** Path to the offending string (for `locate`). */
  segments: Array<string | number>;
  /** The same path, printable (`steps[2].request.path`). */
  path: string;
  message: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `/users/` or `/users(` (optionally `/users('`), with what follows in the same text. */
const USERS_AT = /(?:^|\/)users(\/|\('?)/gi;
const SAFE_METHODS = new Set(['GET', 'HEAD']);

interface AstNode {
  type?: string;
  value?: unknown;
  procedure?: AstNode;
  arguments?: AstNode[];
  lhs?: AstNode;
  rhs?: AstNode;
}

/** `$guid(…)` or `$encode($guid(…))`: the value is an object id by construction. */
function isGuidCall(node: AstNode | undefined): boolean {
  if (node?.type !== 'function' || node.procedure?.type !== 'variable') return false;
  if (node.procedure.value === 'guid') return true;
  return node.procedure.value === 'encode' && node.arguments?.length === 1 && isGuidCall(node.arguments[0]);
}

/**
 * Whether `text` names a user other than by id: after each `/users/` (or `/users(`), either a literal key that is a
 * GUID, or nothing — in which case `next` (what is concatenated after the text) must be `$guid(…)`. A bare
 * `/users` (the collection) names nobody.
 */
function textNamesUser(text: string, next: AstNode | undefined): boolean {
  for (const m of text.matchAll(USERS_AT)) {
    const rest = text.slice(m.index + m[0].length);
    const key = (m[1] === '/' ? /^[^/?#()]*/ : /^[^')]*/).exec(rest)![0];
    if (key !== '') {
      if (!GUID.test(key)) return true;
    } else if (rest === '' && !isGuidCall(next)) return true;
  }
  return false;
}

/** The operands of a `a & b & c` chain, left to right. */
function concatOperands(node: AstNode): AstNode[] {
  return node.type === 'binary' && node.value === '&'
    ? [...concatOperands(node.lhs ?? {}), ...concatOperands(node.rhs ?? {})]
    : [node];
}

/** Whether an expression builds a `/users/` reference from anything but `$guid(…)` (string literals and `&`). */
function astNamesUser(node: unknown, depth = 0): boolean {
  if (!node || typeof node !== 'object' || depth > 200) return false;
  if (Array.isArray(node)) return node.some((n) => astNamesUser(n, depth + 1));
  const n = node as AstNode;
  if (n.type === 'binary' && n.value === '&') {
    const parts = concatOperands(n);
    return parts.some((p, i) =>
      p.type === 'string' ? textNamesUser(String(p.value), parts[i + 1]) : astNamesUser(p, depth + 1),
    );
  }
  if (n.type === 'string') return textNamesUser(String(n.value), undefined);
  return Object.entries(n).some(([k, v]) => k !== 'position' && astNamesUser(v, depth + 1));
}

const compiled = (source: string): AstNode | undefined => {
  try {
    return compile(source).ast() as AstNode;
  } catch {
    return undefined; // validateExpressions reports expressions that don't compile
  }
};

/** Whether one templated string names a user by anything but an object id. */
function templateNamesUser(str: string): boolean {
  let parts;
  try {
    parts = splitTemplate(str);
  } catch {
    return false; // malformed templates are reported by validateExpressions
  }
  return parts.some((part, i) => {
    if (part.type === 'expr') return astNamesUser(compiled(part.source));
    const next = parts[i + 1];
    return textNamesUser(part.value, next?.type === 'expr' ? compiled(next.source) : undefined);
  });
}

/** Every string in a value, with its path. */
function strings(
  value: unknown,
  segments: Array<string | number>,
  out: Array<[Array<string | number>, string]>,
) {
  if (typeof value === 'string') out.push([segments, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, [...segments, i], out));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) strings(v, [...segments, k], out);
}

/**
 * Graph writes in `def` whose path or body names a user after `/users/` by anything but `$guid(…)` (optionally in
 * `$encode(…)`) or a literal GUID. Writes are `type: graph` steps with `mode: write`, the changing requests of a
 * `graphBatch` step with `mode: write`, and every `graph` / `graphBatch` compensation (always a write) — wherever they
 * sit (forEach steps, runbook sections). GET and HEAD requests and `mode: read` steps are lookups and may use a UPN.
 */
export function usersWriteProblems(def: unknown): UsersWriteProblem[] {
  const out: UsersWriteProblem[] = [];
  const check = (request: unknown, at: Array<string | number>) => {
    const r = request as { method?: unknown; path?: unknown; body?: unknown } | null;
    if (!r || typeof r !== 'object') return;
    if (SAFE_METHODS.has(String(r.method ?? 'GET').toUpperCase())) return;
    const found: Array<[Array<string | number>, string]> = [];
    strings(r.path, [...at, 'path'], found);
    strings(r.body, [...at, 'body'], found);
    for (const [segments, str] of found)
      if (templateNamesUser(str))
        out.push({
          segments,
          path: formatPath(segments),
          message:
            'a write names a user after /users/ by something other than an object id — pass it through $guid() (e.g. /users/${ $encode($guid(inputs.userId)) }); AdminForge refuses writes that name a user by sign-in name or address.',
        });
  };
  const visit = (value: unknown, segments: Array<string | number>, compensation = false): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, [...segments, i]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const o = value as Record<string, unknown>;
    const write = compensation || o.mode === 'write';
    if (write && o.type === 'graph') check(o.request, [...segments, 'request']);
    if (write && o.type === 'graphBatch' && o.requests && typeof o.requests === 'object')
      for (const [id, r] of Object.entries(o.requests as Record<string, unknown>))
        check(r, [...segments, 'requests', id]);
    for (const [k, v] of Object.entries(o))
      if (k !== 'request' && k !== 'requests') visit(v, [...segments, k], k === 'compensate');
  };
  visit(def, []);
  return out;
}
