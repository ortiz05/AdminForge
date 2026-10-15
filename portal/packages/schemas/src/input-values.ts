import { z } from 'zod';
import type { Param, Params } from './params';

/**
 * Zod schemas for the *values* a run form collects from a playbook/runbook `inputs:` block (§7.7). The browser uses
 * them to validate the generated form before anything is sent; the engine re-validates on the server (its
 * `validateInputs` is authoritative). Messages match the engine's so the form and the API say the same thing.
 *
 * Inputs are required unless `required: false` or a literal `default` is given. Blank strings and empty arrays
 * count as "not given". Expression defaults (`${ … }`) are rendered by the server, so they make a field optional here.
 */

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HOSTNAME_RE =
  /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const RELATIVE_RE = /^(today|now|[+-]\d+[hdwmy])$/;
const ISO_DURATION_RE = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const MAX_STRING = 10_000;

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

function stringValue(p: Extract<Param, { type: 'string' }>): z.ZodType {
  return z.string({ error: 'Expected text.' }).superRefine((raw, ctx) => {
    const v = raw.trim();
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (raw.length > (p.maxLength ?? MAX_STRING))
      return fail(`Must be at most ${p.maxLength ?? MAX_STRING} characters.`);
    if (p.minLength !== undefined && v.length < p.minLength)
      return fail(`Must be at least ${p.minLength} characters.`);
    if (p.pattern !== undefined) {
      let re: RegExp | undefined;
      try {
        re = new RegExp(p.pattern);
      } catch {
        return fail('The definition declares an invalid pattern.');
      }
      if (!re.test(raw)) return fail('Does not match the expected format.');
    }
    if (p.format === 'guid' && !GUID_RE.test(v)) fail('Expected a GUID.');
    if (p.format === 'email' && !EMAIL_RE.test(v)) fail('Expected an email address.');
    if (p.format === 'upn' && !EMAIL_RE.test(v))
      fail('Expected a user principal name like name@example.com.');
    if (p.format === 'url' && !/^https?:\/\/[^\s]+$/.test(v)) fail('Expected an http(s) URL.');
    if (p.format === 'hostname' && !HOSTNAME_RE.test(v)) fail('Expected a host name.');
  });
}

function numberValue(p: Extract<Param, { type: 'number' }>): z.ZodType {
  return z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
    z
      .number({ error: 'Expected a number.' })
      .refine(Number.isFinite, 'Expected a number.')
      .refine((n) => !p.integer || Number.isInteger(n), 'Expected a whole number.')
      .refine((n) => p.min === undefined || n >= p.min, `Must be at least ${p.min}.`)
      .refine((n) => p.max === undefined || n <= p.max, `Must be at most ${p.max}.`),
  );
}

function enumValue(p: Extract<Param, { type: 'enum' }>): z.ZodType {
  const allowed = p.values.map(optionValue);
  const ok = (x: unknown) => allowed.some((a) => a === x || String(a) === x);
  if (p.multiple)
    return z.array(z.unknown(), { error: 'Choose one or more values.' }).superRefine((list, ctx) => {
      const bad = list.filter((x) => !ok(x));
      if (bad.length)
        ctx.addIssue({ code: 'custom', message: `Not an allowed value: ${bad.map(String).join(', ')}.` });
    });
  return z.unknown().refine(ok, `Expected one of: ${allowed.map(String).join(', ')}.`);
}

const dateValue = z
  .string({ error: 'Expected a date.' })
  .refine(
    (v) => RELATIVE_RE.test(v) || !Number.isNaN(Date.parse(v)),
    'Expected an ISO date like 2026-01-31.',
  );

const dateRangeValue = z.union(
  [
    z.string().regex(ISO_DURATION_RE),
    z
      .object({ from: z.string(), to: z.string() })
      .refine(
        (r) => !Number.isNaN(Date.parse(r.from)) && !Number.isNaN(Date.parse(r.to)),
        'Expected ISO dates in from/to.',
      )
      .refine((r) => Date.parse(r.from) <= Date.parse(r.to), 'from must not be after to.'),
  ],
  { error: 'Expected { from, to } or an ISO duration like P7D.' },
);

function entityId(type: EntityParamType): z.ZodType<string> {
  return z
    .string({ error: `Expected a ${type} id.` })
    .trim()
    .min(1, `Expected a ${type} id.`)
    .max(2048, `Expected a ${type} id.`)
    .superRefine((s, ctx) => {
      const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
      if (type === 'subscription' && !GUID_RE.test(s)) fail('Expected a subscription id (GUID).');
      if (type === 'resource' && !/^\/subscriptions\/[^/]+\//i.test(s))
        fail('Expected an Azure resource id (/subscriptions/…).');
      if ((type === 'group' || type === 'device' || type === 'app') && !GUID_RE.test(s))
        fail(`Expected a ${type} object id (GUID).`);
      if (type === 'user' && !GUID_RE.test(s) && !EMAIL_RE.test(s))
        fail('Expected a user object id (GUID) or user principal name.');
    });
}

/** Schema for one given (non-blank) value of a param. */
export function inputValueSchema(p: Param): z.ZodType {
  switch (p.type) {
    case 'string':
      return stringValue(p);
    case 'number':
      return numberValue(p);
    case 'boolean':
      return z.preprocess(
        (v) => (v === 'true' ? true : v === 'false' ? false : v),
        z.boolean({ error: 'Expected true or false.' }),
      );
    case 'enum':
      return enumValue(p);
    case 'date':
      return dateValue;
    case 'dateRange':
      return dateRangeValue;
    case 'guid':
      return z.string({ error: 'Expected a GUID.' }).trim().regex(GUID_RE, 'Expected a GUID.');
    default: {
      const one = entityId(p.type);
      if (!p.multiple) return one;
      const list = z.array(one, { error: `Expected a list of ${p.type} ids.` });
      return p.maxItems === undefined ? list : list.max(p.maxItems, `At most ${p.maxItems} items.`);
    }
  }
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
