/**
 * Data paths (`signInActivity.lastSignInDateTime`, `value[0].id`, `counts.members`) — one reader for the browser
 * (widgets) and the API (exports, scheduled report files), so a column that renders also exports the same value
 * (design review D-06). Missing segments resolve to undefined and nothing throws; only own properties are read, so a
 * path like `constructor` or `__proto__` never reaches the prototype.
 */

type Segment = string | number;

const SEGMENT = /[^.[\]]+|\[(\d+)\]/g;
const cache = new Map<string, Segment[]>();

/** `value[0].id` → `['value', 0, 'id']` (cached; paths come from content, a bounded set). */
export function splitPath(path: string): Segment[] {
  const hit = cache.get(path);
  if (hit) return hit;
  const out: Segment[] = [];
  for (const m of path.matchAll(SEGMENT)) out.push(m[1] !== undefined ? Number(m[1]) : m[0]);
  if (cache.size > 500) cache.clear();
  cache.set(path, out);
  return out;
}

/** The value at `path` (a path string or pre-split segments); no path → the value itself. */
export function getPath(value: unknown, path: string | readonly Segment[] | undefined): unknown {
  if (path === undefined || path === '') return value;
  let cur: unknown = value;
  for (const seg of typeof path === 'string' ? splitPath(path) : path) {
    if (cur == null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<Segment, unknown>)[seg];
  }
  return cur;
}

/** A widget's or export's `data` reference: `users.value` → `{ root: 'users', rest: 'value' }`. */
export function splitDataRef(ref: string): { root: string; rest: string } {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.(.*)|(\[.*))?$/.exec(ref.trim());
  if (!m) return { root: ref, rest: '' };
  return { root: m[1]!, rest: m[2] ?? m[3] ?? '' };
}

/**
 * The paths `export.data` may name: itself when it is a plain path, else each quoted path in its `${ … }` template
 * (`'registrations.value'`). A template's rendered path must be one of these (`exportTable`, `planExport`): a param can
 * choose between the paths a page declares, never build one.
 */
export function exportDataPaths(data: string): string[] {
  if (!data.includes('${')) return [data];
  return [...data.matchAll(/(['"])([A-Za-z_][A-Za-z0-9_]*[.[][^'"]*)\1/g)].map((m) => m[2]!);
}

/**
 * The table an export takes its columns from (the browser sends that table's visible columns): without `export.data`,
 * the first table; else the table bound to `ref` — the path `export.data` names, rendered for the current params — or,
 * when no table is, the one bound to a `source: static` view of that datasource (its `data` or `transform` reads
 * `ds.<name>`: a table capped for the browser whose export has every row, docs/content-recipes.md). None while `ref`
 * isn't a path.
 */
export function exportTable<T extends { widget?: unknown; data?: unknown }>(
  blocks: readonly T[],
  datasources: Record<string, { source?: unknown; data?: unknown; transform?: unknown }> | undefined,
  data: string | undefined,
  ref: unknown,
): T | undefined {
  const tables = blocks.filter((b) => b.widget === 'table');
  if (!data) return tables[0];
  if (typeof ref !== 'string' || !exportDataPaths(data).includes(ref)) return undefined;
  const direct = tables.find((t) => t.data === ref);
  if (direct) return direct;
  const { root } = splitDataRef(ref);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(root)) return undefined;
  const readsRoot = new RegExp(`\\bds\\.${root}\\b`);
  return tables.find((t) => {
    if (typeof t.data !== 'string') return false;
    const view = datasources?.[splitDataRef(t.data).root];
    if (view?.source !== 'static') return false;
    return [view.data, view.transform].some((s) => typeof s === 'string' && readsRoot.test(s));
  });
}
