import {
  inputErrors,
  inputsSchema,
  inputValueSchema,
  literalDefault,
  type Param,
  type Params,
} from '@adminforge/schemas';

/** Form state: raw control values keyed by input name. */
export type FormValues = Record<string, unknown>;

/** "userId" → "User id", "lifetimeMinutes" → "Lifetime minutes". */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const labelOf = (key: string, p: Param) => p.label ?? humanize(key);

/**
 * Starting values: literal defaults, overlaid with the inputs from the link. Keys the playbook doesn't declare are
 * dropped (the server refuses them) and reported.
 */
export function initialValues(
  params: Params,
  given: Record<string, unknown>,
  omit: readonly string[] = [],
): { values: FormValues; unknown: string[] } {
  const values: FormValues = {};
  for (const [name, p] of Object.entries(params)) {
    if (omit.includes(name)) continue;
    const d = literalDefault(p);
    if (d !== undefined) values[name] = d;
    if (given[name] !== undefined) values[name] = given[name];
  }
  const unknown = Object.keys(given).filter((k) => !Object.hasOwn(params, k));
  return { values, unknown };
}

export interface ValidationResult {
  ok: boolean;
  /** Coerced values ready to submit (only when ok). */
  values: Record<string, unknown>;
  errors: Record<string, string>;
}

/** zod-validates the form (client side; the engine re-validates). */
export function validateForm(
  params: Params,
  values: FormValues,
  omit: readonly string[] = [],
): ValidationResult {
  const result = inputsSchema(params, { omit }).safeParse(values);
  if (result.success) {
    const clean = Object.fromEntries(Object.entries(result.data).filter(([, v]) => v !== undefined));
    return { ok: true, values: clean, errors: {} };
  }
  return { ok: false, values: {}, errors: inputErrors(result.error) };
}

/** Order-insensitive JSON, so a preview can be matched to the inputs it ran with. */
export function stableJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return JSON.stringify(norm(value));
}

/** Visible inputs (hidden ones still travel with the run). */
export const visibleInputs = (params: Params, omit: readonly string[] = []) =>
  Object.entries(params).filter(([name, p]) => !p.hidden && !omit.includes(name));

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Object ids compare case-insensitively and numbers typed as text equal numbers (the server coerces both). */
const normInput = (v: unknown): unknown =>
  typeof v === 'string' && GUID_RE.test(v.trim())
    ? v.trim().toLowerCase()
    : Array.isArray(v)
      ? v.map(normInput)
      : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
        ? Number(v)
        : v;

/** True when every input the form sends has the same value in the run (server-side defaults may add more). */
export function previewMatches(sent: Record<string, unknown>, ran: Record<string, unknown>): boolean {
  return Object.entries(sent).every(([k, v]) => stableJson(normInput(v)) === stableJson(normInput(ran[k])));
}

const RESERVED_PARAMS = new Set([
  'run',
  'inputs',
  'items',
  'preview',
  'playbook',
  'inspect',
  'itab',
  'view',
  'tab',
]);

export interface Prefill {
  values: FormValues;
  /** Plain-words problems with the link (bad values are left out, never silently used). */
  problems: string[];
}

/**
 * Prefill for a run form from a URL: `?inputs=<base64url JSON>` (playbooks/url.ts encoding) and/or plain params named
 * like the declared inputs (`?userId=<guid>`; plain params win). Each value is checked with the input's zod schema
 * first; invalid ones are dropped and reported. Multi-value inputs accept a list or comma-separated text.
 */
export function prefillFromSearch(
  params: Params,
  search: Record<string, unknown>,
  decode: (text: unknown) => unknown,
): Prefill {
  const problems: string[] = [];
  let encoded: Record<string, unknown> = {};
  if (search.inputs !== undefined) {
    const decoded = decode(search.inputs);
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded))
      encoded = decoded as Record<string, unknown>;
    else problems.push('The prefilled inputs in the link could not be read.');
  }
  const unknown = Object.keys(encoded).filter((k) => !Object.hasOwn(params, k));
  if (unknown.length)
    problems.push(
      `The link included inputs this runbook doesn’t take (${unknown.join(', ')}); they were left out.`,
    );

  const values: FormValues = {};
  for (const [name, p] of Object.entries(params)) {
    let v = !RESERVED_PARAMS.has(name) && search[name] !== undefined ? search[name] : encoded[name];
    if (v === undefined || v === null || v === '') continue;
    const multi = ('multiple' in p && p.multiple) === true;
    if (multi && typeof v === 'string')
      v = v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    if (typeof v === 'number' || typeof v === 'boolean')
      v = p.type === 'string' || p.type === 'guid' ? String(v) : v;
    const r = inputValueSchema(p).safeParse(v);
    if (r.success) values[name] = typeof r.data === 'string' || Array.isArray(r.data) ? v : r.data;
    else
      problems.push(
        `The link’s ${labelOf(name, p)} wasn’t used: ${r.error.issues[0]?.message ?? 'not valid'}`,
      );
  }
  return { values, problems };
}
