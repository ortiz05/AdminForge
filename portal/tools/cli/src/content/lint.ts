/**
 * Content lint rules that the schema can't express: pure checks over one parsed definition, run by
 * `adminforge validate` (and therefore `publish`) through content/check.ts.
 *
 * - `bareDatasourceRefs`: a datasource's `when`/request/runner parameters naming another datasource without `ds.`.
 * - `datasourceOrderProblems`: `ds.<name>` used before that datasource is declared (or by itself).
 * - `scriptPinProblems`: a runner reference (`script` + `sha256`, in datasources, playbook steps and their
 *   compensations, schedules) whose pinned sha256 is not the sha256 of the file under portal/content/scripts — the
 *   runner refuses such a script at run time (§5.10), so validate fails first.
 *
 * Each returns plain records (where, what); check.ts turns them into `file:line path: message` errors. The rules stay
 * in the CLI rather than @adminforge/schemas because the expression rules need @adminforge/expressions'
 * `collectExpressions`, and schemas deliberately depends on nothing but yaml and zod. No I/O here: the script check is
 * handed a `sha256Of` lookup.
 */
import { collectExpressions } from '@adminforge/expressions';
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
 * dependencies above it, which also rules out loops. (The runtime doesn't rely on this order: published definitions are
 * stored in Postgres, which doesn't keep key order, so the executor follows the references instead.)
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
