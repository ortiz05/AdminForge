import { renderTemplate } from '@adminforge/expressions';
import type { Param, Params } from '@adminforge/schemas';

/**
 * Validates run inputs against a playbook/runbook `inputs:` block (§7.7): required unless `required: false` or a
 * default is given; defaults applied (expression defaults see `now` and `env`); values coerced where unambiguous
 * ("42" → 42, "true" → true); unknown keys refused so nothing unexpected reaches expressions.
 */

export interface InputIssue {
  field: string;
  message: string;
}

export type InputValidation =
  { ok: true; values: Record<string, unknown> } | { ok: false; errors: InputIssue[] };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HOSTNAME =
  /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const RELATIVE = /^(today|now|[+-]\d+[hdwmy])$/;
const ISO_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const MAX_STRING = 10_000;
const DAY = 86_400_000;

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function relativeDate(token: string, now: Date): string {
  if (token === 'now') return now.toISOString();
  if (token === 'today')
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const m = /^([+-])(\d+)([hdwmy])$/.exec(token)!;
  const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  const unit = { h: 3_600_000, d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY }[
    m[3] as 'h' | 'd' | 'w' | 'm' | 'y'
  ];
  return new Date(now.getTime() + n * unit).toISOString();
}

function isoDurationMs(v: string): number {
  const m =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      v,
    );
  if (!m) return 0;
  const [, y, mo, w, d, h, mi, s] = m.map((x) => (x === undefined ? 0 : Number(x)));
  return ((((y! * 365 + mo! * 30 + w! * 7 + d!) * 24 + h!) * 60 + mi!) * 60 + s!) * 1000;
}

const optionValue = (o: unknown) =>
  o && typeof o === 'object' && 'value' in o ? (o as { value: unknown }).value : o;

type Check = { value: unknown } | { error: string };

function checkString(p: Extract<Param, { type: 'string' }>, v: unknown): Check {
  if (typeof v !== 'string') return { error: 'Expected text.' };
  if (v.length > (p.maxLength ?? MAX_STRING))
    return { error: `Must be at most ${p.maxLength ?? MAX_STRING} characters.` };
  if (p.minLength !== undefined && v.trim().length < p.minLength)
    return { error: `Must be at least ${p.minLength} characters.` };
  if (p.pattern !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(p.pattern);
    } catch {
      return { error: 'The definition declares an invalid pattern.' };
    }
    if (!re.test(v)) return { error: 'Does not match the expected format.' };
  }
  switch (p.format) {
    case 'guid':
      return GUID.test(v.trim()) ? { value: v.trim().toLowerCase() } : { error: 'Expected a GUID.' };
    case 'email':
    case 'upn':
      return EMAIL.test(v.trim())
        ? { value: v.trim() }
        : {
            error:
              p.format === 'upn'
                ? 'Expected a user principal name like name@example.com.'
                : 'Expected an email address.',
          };
    case 'url':
      return /^https?:\/\/[^\s]+$/.test(v.trim())
        ? { value: v.trim() }
        : { error: 'Expected an http(s) URL.' };
    case 'hostname':
      return HOSTNAME.test(v.trim()) ? { value: v.trim().toLowerCase() } : { error: 'Expected a host name.' };
    default:
      return { value: v };
  }
}

function checkNumber(p: Extract<Param, { type: 'number' }>, v: unknown): Check {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return { error: 'Expected a number.' };
  if (p.integer && !Number.isInteger(n)) return { error: 'Expected a whole number.' };
  if (p.min !== undefined && n < p.min) return { error: `Must be at least ${p.min}.` };
  if (p.max !== undefined && n > p.max) return { error: `Must be at most ${p.max}.` };
  return { value: n };
}

function checkBoolean(v: unknown): Check {
  if (typeof v === 'boolean') return { value: v };
  if (v === 'true' || v === 'false') return { value: v === 'true' };
  return { error: 'Expected true or false.' };
}

function checkEnum(p: Extract<Param, { type: 'enum' }>, v: unknown): Check {
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

function checkDate(v: unknown, now: Date): Check {
  if (typeof v !== 'string') return { error: 'Expected a date.' };
  if (RELATIVE.test(v)) return { value: relativeDate(v, now) };
  return Number.isNaN(Date.parse(v)) ? { error: 'Expected an ISO date like 2026-01-31.' } : { value: v };
}

function checkDateRange(v: unknown, now: Date): Check {
  if (typeof v === 'string' && ISO_DURATION.test(v)) {
    return {
      value: {
        from: new Date(now.getTime() - isoDurationMs(v)).toISOString(),
        to: now.toISOString(),
        timespan: v,
      },
    };
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

function checkEntity(
  p: Extract<Param, { type: 'user' | 'group' | 'device' | 'app' | 'resource' | 'subscription' }>,
  v: unknown,
): Check {
  const one = (x: unknown): Check => {
    if (typeof x !== 'string' || x.trim() === '' || x.length > 2048)
      return { error: `Expected a ${p.type} id.` };
    const s = x.trim();
    if (p.type === 'subscription' && !GUID.test(s)) return { error: 'Expected a subscription id (GUID).' };
    if (p.type === 'resource' && !/^\/subscriptions\/[^/]+\//i.test(s))
      return { error: 'Expected an Azure resource id (/subscriptions/…).' };
    if ((p.type === 'group' || p.type === 'device' || p.type === 'app') && !GUID.test(s))
      return { error: `Expected a ${p.type} object id (GUID).` };
    if (p.type === 'user' && !GUID.test(s) && !EMAIL.test(s))
      return { error: 'Expected a user object id (GUID) or user principal name.' };
    return { value: GUID.test(s) ? s.toLowerCase() : s };
  };
  if (p.multiple) {
    const list = Array.isArray(v) ? v : [v];
    if (p.maxItems !== undefined && list.length > p.maxItems)
      return { error: `At most ${p.maxItems} items.` };
    const out: unknown[] = [];
    for (const x of list) {
      const r = one(x);
      if ('error' in r) return r;
      out.push(r.value);
    }
    return { value: out };
  }
  return one(v);
}

function check(p: Param, v: unknown, now: Date): Check {
  switch (p.type) {
    case 'string':
      return checkString(p, v);
    case 'number':
      return checkNumber(p, v);
    case 'boolean':
      return checkBoolean(v);
    case 'enum':
      return checkEnum(p, v);
    case 'date':
      return checkDate(v, now);
    case 'dateRange':
      return checkDateRange(v, now);
    case 'guid':
      return typeof v === 'string' && GUID.test(v.trim())
        ? { value: v.trim().toLowerCase() }
        : { error: 'Expected a GUID.' };
    default:
      return checkEntity(p, v);
  }
}

export interface ValidateInputsOptions {
  now?: Date;
  env?: Record<string, unknown>;
  /** Page params are optional unless `required: true`; inputs (default) are required unless `required: false`. */
  kind?: 'inputs' | 'params';
}

export async function validateInputs(
  params: Params | undefined,
  raw: unknown,
  opts: ValidateInputsOptions = {},
): Promise<InputValidation> {
  const now = opts.now ?? new Date();
  const errors: InputIssue[] = [];
  const values: Record<string, unknown> = {};
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw)))
    return { ok: false, errors: [{ field: '', message: 'Inputs must be an object.' }] };
  const given = (raw ?? {}) as Record<string, unknown>;
  const declared = params ?? {};
  for (const key of Object.keys(given))
    if (!Object.hasOwn(declared, key)) errors.push({ field: key, message: 'Unknown input.' });
  for (const [name, p] of Object.entries(declared)) {
    let v = given[name];
    if (isBlank(v) || (Array.isArray(v) && v.length === 0)) {
      v = undefined;
      if (p.default !== undefined) {
        try {
          v =
            typeof p.default === 'string' && p.default.includes('${')
              ? await renderTemplate(p.default, { now: now.toISOString(), env: opts.env ?? {} })
              : p.default;
        } catch (err) {
          errors.push({ field: name, message: `Default could not be evaluated: ${(err as Error).message}` });
          continue;
        }
      }
    }
    if (v === undefined || v === null) {
      const required = opts.kind === 'params' ? p.required === true : p.required !== false;
      if (required) errors.push({ field: name, message: `${p.label ?? name} is required.` });
      continue;
    }
    const r = check(p, v, now);
    if ('error' in r) errors.push({ field: name, message: r.error });
    else values[name] = r.value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, values };
}
