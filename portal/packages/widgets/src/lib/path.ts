/**
 * Dot paths into data (`signInActivity.lastSignInDateTime`, `value[0].id`, `counts.members`): the readers live in
 * @adminforge/schemas so exports resolve a column exactly as the table renders it. Missing segments resolve to
 * undefined; nothing throws.
 */
export { getPath, splitDataRef, splitPath } from '@adminforge/schemas';

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
