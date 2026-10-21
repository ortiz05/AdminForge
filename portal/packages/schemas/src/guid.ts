/**
 * The one GUID check (organization review O-07): Entra object and application ids, tenant, subscription and workspace
 * ids, run, view and approval ids. The hyphenated 8-4-4-4-12 form in either case, nothing around it: no braces, no
 * `urn:uuid:`, no surrounding white space (callers that accept typed input trim first).
 *
 * - `isGuid(value)` — the check; false for anything that isn't a string (no coercion).
 * - `GUID_RE` — the same check as an anchored regex, for `z.string().regex(GUID_RE)`.
 * - `GUID_PATTERN` — the unanchored source, for patterns that embed a GUID (a GUID in text, an alternation). Both
 *   cases are spelled out, so it needs no `i` flag: zod schemas emit it into JSON Schema, whose patterns take none.
 *
 * Browser-safe (on `@adminforge/schemas/browser`). `tests/guards/guid-literal.test.ts` keeps the pattern written out
 * here only; `@adminforge/connectors` keeps its own copy (it has no internal dependencies).
 */
export const GUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export const GUID_RE = new RegExp(`^${GUID_PATTERN}$`);

/**
 * What `isGuid` narrows to. Not plain `string`: a guard for `string` would narrow a string that fails the check to
 * `never`; this one leaves it a `string`.
 */
export type GuidString = `${string}-${string}-${string}-${string}-${string}`;

export function isGuid(value: unknown): value is GuidString {
  return typeof value === 'string' && GUID_RE.test(value);
}
