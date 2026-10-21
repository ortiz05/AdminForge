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
