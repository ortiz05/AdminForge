/**
 * The small part of the renderer's URL handling the shell needs on first load: the inspector's
 * `?inspect=page:<key>&i.<param>=…` and the /p/$key search sanitiser. (Table state lives in url-state.ts.)
 */

export const INSPECT_PREFIX = 'i.';

export interface InspectState {
  page: string;
  params: Record<string, unknown>;
}

/** `?inspect=page:identity.user&i.id=…` → { page, params }. Other `inspect` forms (user:<id>) return null. */
export function readInspect(search: Record<string, unknown>): InspectState | null {
  const v = search.inspect;
  if (typeof v !== 'string' || !v.startsWith('page:')) return null;
  const page = v.slice(5);
  if (!/^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(page)) return null;
  const params: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(search)) if (k.startsWith(INSPECT_PREFIX)) params[k.slice(INSPECT_PREFIX.length)] = val;
  return { page, params };
}

/** Search updater: open the inspector on an entity page (replacing whatever it showed). */
export function withInspect(prev: Record<string, unknown>, target: InspectState): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(prev)) if (!k.startsWith(INSPECT_PREFIX) && k !== 'itab') next[k] = v;
  next.inspect = `page:${target.page}`;
  for (const [k, v] of Object.entries(target.params)) if (v !== undefined && v !== null && v !== '') next[`${INSPECT_PREFIX}${k}`] = v;
  return next;
}

/** Search updater: close the inspector. */
export function withoutInspect(prev: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(prev)) if (!k.startsWith(INSPECT_PREFIX) && k !== 'inspect' && k !== 'itab') next[k] = v;
  return next;
}

/** Validates the generic search object of /p/$key (lengths and shapes only; params are coerced per page). */
export function sanitizeSearch(search: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(search)) {
    if (++n > 120 || k.length > 120) break;
    if (typeof v === 'string') out[k] = v.slice(0, 64 * 1024);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 200).filter((x) => ['string', 'number', 'boolean'].includes(typeof x));
    else if (v && typeof v === 'object') out[k] = v;
  }
  return out;
}
