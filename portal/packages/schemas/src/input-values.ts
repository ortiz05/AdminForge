import { z } from 'zod';
import { parseDuration } from './common';
import {
  EMAIL_RE,
  GUID_RE,
  HOSTNAME_RE,
  ISO_DURATION_RE,
  RELATIVE_DATE_RE,
  hasControlChars,
  isoTime,
  resolveDate,
  type ParamCheck,
} from './param-check';
import type { Param, Params } from './params';
import { testContentPattern } from './regex-safety';

/**
 * The *values* a run form collects from a playbook/runbook `inputs:` block (§7.7). One check, `checkInputValue`,
 * serves both sides (design review D-06): the engine's `validateInputs` applies it on the server (authoritative, with
 * defaults rendered first) and `inputsSchema` wraps it in zod for the run form in the browser, so the form and the API
 * say the same thing by construction.
 *
 * Inputs are required unless `required: false` or a literal `default` is given. Blank strings and empty arrays
 * count as "not given". Expression defaults (`${ … }`) are rendered by the server, so they make a field optional here.
 */

/** Longest text an input takes unless it declares `maxLength`. */
export const MAX_INPUT_STRING = 10_000;

/** Entity params pick directory or Azure objects; their value is the object id (or ids when `multiple`). */
export const ENTITY_PARAM_TYPES = ['user', 'group', 'device', 'app', 'resource', 'subscription'] as const;
export type EntityParamType = (typeof ENTITY_PARAM_TYPES)[number];

export const isEntityParam = (p: Param): p is Extract<Param, { type: EntityParamType }> =>
  (ENTITY_PARAM_TYPES as readonly string[]).includes(p.type);

const isExpression = (v: unknown) => typeof v === 'string' && v.includes('${');

/** A literal default the form can show; expression defaults are rendered by the server. */
export function literalDefault(p: Param): unknown {
  return p.default === undefined || isExpression(p.default) ? undefined : p.default;
}

/** Required unless `required: false` or any default (literal or expression) is declared. */
export function isInputRequired(p: Param): boolean {
  return p.required !== false && p.default === undefined;
}

/** Blank → undefined, so "not given" is one case. */
export function isBlankInput(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0)
  );
}

const optionValue = (o: unknown) =>
  o && typeof o === 'object' && 'value' in o ? (o as { value: unknown }).value : o;

const PATTERN_PROBLEM = {
  mismatch: 'Does not match the expected format.',
  too_long: 'Too long to check against the expected format.',
  invalid: 'The definition declares an invalid pattern.',
} as const;

function checkString(p: Extract<Param, { type: 'string' }>, v: unknown): ParamCheck {
  if (typeof v !== 'string') return { error: 'Expected text.' };
  // As for page params: values end up in request paths and bodies, where a stray TAB or LF changes their meaning.
  if (hasControlChars(v, p.multiline === true))
    return {
      error: p.multiline
        ? 'Contains control characters.'
        : 'Must be a single line without control characters.',
    };
  const max = p.maxLength ?? MAX_INPUT_STRING;
  if (v.length > max) return { error: `Must be at most ${max} characters.` };
  if (p.minLength !== undefined && v.trim().length < p.minLength)
    return { error: `Must be at least ${p.minLength} characters.` };
  if (p.pattern !== undefined) {
    const r = testContentPattern(p.pattern, v);
    if (r !== 'match') return { error: PATTERN_PROBLEM[r] };
  }
  const t = v.trim();
  switch (p.format) {
    case 'guid':
      return GUID_RE.test(t) ? { value: t.toLowerCase() } : { error: 'Expected a GUID.' };
    case 'email':
    case 'upn':
      return EMAIL_RE.test(t)
        ? { value: t }
        : {
            error:
              p.format === 'upn'
                ? 'Expected a user principal name like name@example.com.'
                : 'Expected an email address.',
          };
    case 'url':
      return /^https?:\/\/[^\s]+$/.test(t) ? { value: t } : { error: 'Expected an http(s) URL.' };
    case 'hostname':
      return HOSTNAME_RE.test(t) ? { value: t.toLowerCase() } : { error: 'Expected a host name.' };
    default:
      return { value: v };
  }
}

function checkNumber(p: Extract<Param, { type: 'number' }>, v: unknown): ParamCheck {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return { error: 'Expected a number.' };
  if (p.integer && !Number.isInteger(n)) return { error: 'Expected a whole number.' };
  if (p.min !== undefined && n < p.min) return { error: `Must be at least ${p.min}.` };
  if (p.max !== undefined && n > p.max) return { error: `Must be at most ${p.max}.` };
  return { value: n };
}

function checkEnum(p: Extract<Param, { type: 'enum' }>, v: unknown): ParamCheck {
  const allowed = p.values.map(optionValue);
  const one = (x: unknown) => allowed.some((a) => a === x || (typeof a !== 'string' && String(a) === x));
  const coerce = (x: unknown) => allowed.find((a) => a === x || String(a) === x);
  if (p.multiple) {
    const list = Array.isArray(v) ? v : [v];
    const bad = list.filter((x) => !one(x));
    return bad.length
      ? { error: `Not an allowed value: ${bad.map(String).join(', ')}.` }
      : { value: list.map(coerce) };
  }
  return one(v) ? { value: coerce(v) } : { error: `Expected one of: ${allowed.map(String).join(', ')}.` };
}

function checkDate(v: unknown, now: Date): ParamCheck {
  if (typeof v !== 'string') return { error: 'Expected a date.' };
  if (RELATIVE_DATE_RE.test(v)) {
    const d = resolveDate(v, now);
    return d ? { value: d } : { error: 'Expected an ISO date like 2026-01-31.' };
  }
  return Number.isNaN(Date.parse(v)) ? { error: 'Expected an ISO date like 2026-01-31.' } : { value: v };
}

function checkDateRange(v: unknown, now: Date): ParamCheck {
  if (typeof v === 'string' && ISO_DURATION_RE.test(v)) {
    const from = isoTime(now.getTime() - parseDuration(v));
    return from
      ? { value: { from, to: now.toISOString(), timespan: v } }
      : { error: 'Expected { from, to } or an ISO duration like P7D.' };
  }
  const r = v as { from?: unknown; to?: unknown } | null;
  if (!r || typeof r !== 'object' || typeof r.from !== 'string' || typeof r.to !== 'string')
    return { error: 'Expected { from, to } or an ISO duration like P7D.' };
  const from = Date.parse(r.from);
  const to = Date.parse(r.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return { error: 'Expected ISO dates in from/to.' };
  if (from > to) return { error: 'from must not be after to.' };
  return { value: { from: r.from, to: r.to, timespan: `${r.from}/${r.to}` } };
}

function checkEntity(p: Extract<Param, { type: EntityParamType }>, v: unknown): ParamCheck {
  const one = (x: unknown): ParamCheck => {
    if (typeof x !== 'string' || x.trim() === '' || x.length > 2048)
      return { error: `Expected a ${p.type} id.` };
    const s = x.trim();
    if (p.type === 'subscription' && !GUID_RE.test(s)) return { error: 'Expected a subscription id (GUID).' };
    if (p.type === 'resource' && !/^\/subscriptions\/[^/]+\//i.test(s))
      return { error: 'Expected an Azure resource id (/subscriptions/…).' };
    if ((p.type === 'group' || p.type === 'device' || p.type === 'app') && !GUID_RE.test(s))
      return { error: `Expected a ${p.type} object id (GUID).` };
    if (p.type === 'user' && !GUID_RE.test(s) && !EMAIL_RE.test(s))
      return { error: 'Expected a user object id (GUID) or user principal name.' };
    return { value: GUID_RE.test(s) ? s.toLowerCase() : s };
  };
  if (!p.multiple) return one(v);
  const list = Array.isArray(v) ? v : [v];
  if (p.maxItems !== undefined && list.length > p.maxItems) return { error: `At most ${p.maxItems} items.` };
  const out: unknown[] = [];
  for (const x of list) {
    const r = one(x);
    if ('error' in r) return r;
    out.push(r.value);
  }
  return { value: out };
}

/**
 * Checks and normalises one given (non-blank) input value: "42" → 42, "true" → true, GUIDs and host names lower-cased,
 * relative dates and ISO durations resolved against `now`. The engine runs it on every run; the browser's form
 * schema below runs the same function.
 */
export function checkInputValue(p: Param, v: unknown, now: Date): ParamCheck {
  switch (p.type) {
    case 'string':
      return checkString(p, v);
    case 'number':
      return checkNumber(p, v);
    case 'boolean':
      if (typeof v === 'boolean') return { value: v };
      if (v === 'true' || v === 'false') return { value: v === 'true' };
      return { error: 'Expected true or false.' };
    case 'enum':
      return checkEnum(p, v);
    case 'date':
      return checkDate(v, now);
    case 'dateRange':
      return checkDateRange(v, now);
    case 'guid':
      return typeof v === 'string' && GUID_RE.test(v.trim())
        ? { value: v.trim().toLowerCase() }
        : { error: 'Expected a GUID.' };
    default:
      return checkEntity(p, v);
  }
}

/**
 * Schema for one given (non-blank) value of a param, for the run form: `checkInputValue` decides; numbers and
 * booleans typed as text come out coerced, everything else as typed (the server normalises ids and resolves dates
 * when the run starts, so a form left open doesn't freeze "now").
 */
export function inputValueSchema(p: Param): z.ZodType {
  return z.unknown().transform((v, ctx) => {
    const r = checkInputValue(p, v, new Date());
    if ('error' in r) {
      ctx.addIssue({ code: 'custom', message: r.error });
      return z.NEVER;
    }
    return p.type === 'number' || p.type === 'boolean' ? r.value : v;
  });
}

export interface InputsSchemaOptions {
  /** Keys validated elsewhere (bulk runs: supplied per item) — left out of the schema. */
  omit?: readonly string[];
}

/**
 * An object schema for a whole run form. Unknown keys are dropped (the server refuses them), blank values become
 * `undefined`, and a missing required value fails with "<label> is required." on that field.
 */
export function inputsSchema(
  params: Params | undefined,
  opts: InputsSchemaOptions = {},
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, p] of Object.entries(params ?? {})) {
    if (opts.omit?.includes(name)) continue;
    const value = inputValueSchema(p);
    const required = isInputRequired(p);
    shape[name] = z.preprocess(
      (v) => (isBlankInput(v) ? undefined : v),
      required
        ? z
            .any()
            .refine((v) => v !== undefined, { message: `${p.label ?? name} is required.`, abort: true })
            .pipe(value as z.ZodType<unknown, unknown> as z.ZodType<NonNullable<unknown>>)
        : value.optional(),
    );
  }
  return z.object(shape) as unknown as z.ZodType<Record<string, unknown>>;
}

/** Field → first message, from a failed `inputsSchema(...).safeParse`. */
export function inputErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? '');
    out[field] ??= issue.message;
  }
  return out;
}
