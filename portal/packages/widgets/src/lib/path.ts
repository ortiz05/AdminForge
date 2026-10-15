/**
 * Dot paths into data (`signInActivity.lastSignInDateTime`, `value[0].id`, `counts.members`).
 * Missing segments resolve to undefined; nothing throws.
 */
const SEGMENT = /[^.[\]]+|\[(\d+)\]/g;

const cache = new Map<string, Array<string | number>>();

export function splitPath(path: string): Array<string | number> {
  const hit = cache.get(path);
  if (hit) return hit;
  const out: Array<string | number> = [];
  for (const m of path.matchAll(SEGMENT)) out.push(m[1] !== undefined ? Number(m[1]) : m[0]);
  if (cache.size > 500) cache.clear();
  cache.set(path, out);
  return out;
}

export function getPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const seg of splitPath(path)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

/** `users.value` → { root: 'users', rest: 'value' }. */
export function splitDataRef(ref: string): { root: string; rest: string } {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.(.*)|(\[.*))?$/.exec(ref.trim());
  if (!m) return { root: ref, rest: '' };
  return { root: m[1]!, rest: m[2] ?? m[3] ?? '' };
}

/** "lastSignInDateTime" → "Last sign in date time"; "userType" → "User type". */
export function humanize(field: string): string {
  const last = field.split('.').pop() ?? field;
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Rows from a value: arrays as-is, `{ value: [...] }` (Graph collections) unwrapped, anything else empty. */
export function asRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.value)) return value.value.filter(isRecord);
  return [];
}
