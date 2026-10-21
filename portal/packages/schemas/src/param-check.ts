import { parseDuration } from './common';
import type { AdvancedField } from './page';
import type { Param } from './params';
import { MAX_PATTERN_INPUT, testContentPattern } from './regex-safety';

/**
 * Page params and query-builder values, checked the same way in the browser and the API (design review D-06): the
 * API is authoritative (`datasources/params.ts` turns these results into a 400 `invalid_params`), the browser runs the
 * same checks on the URL so a hand-edited link is reported next to its control before anything is sent. Pure and
 * synchronous; defaults (which may be expressions) are the callers' business.
 *
 * Messages are predicates written to follow the param's label ("Top must be at most 999") or name
 * (`top: must be at most 999`).
 */

export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** RFC 1123 host name: labels of 1–63 letters, digits and hyphens (not at either end), 253 characters in all. */
export const HOSTNAME_RE =
  /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
/** `today`, `now`, `-30d`, `+7d`, `-12h` (m = 30 days, y = 365 days). */
export const RELATIVE_DATE_RE = /^(today|now|([+-])(\d+)([hdwmy]))$/;
export const ISO_DURATION_RE = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const HTTP_URL_RE = /^https?:\/\/\S+$/;

/** Longest text a page param takes unless it declares `maxLength`. */
export const MAX_PARAM_STRING = MAX_PATTERN_INPUT;
/** Most values a multi-value param takes unless it declares `maxItems`. */
export const MAX_PARAM_ITEMS = 1000;

const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, m: 30 * 86_400_000, y: 365 * 86_400_000 };

/** C0 controls and DEL; with `allowLines`, TAB, LF and CR are allowed (multi-line text). */
export function hasControlChars(s: string, allowLines = false): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (allowLines && (c === 0x09 || c === 0x0a || c === 0x0d)) continue;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Furthest a Date reaches from 1970 either way; past it `toISOString()` throws. */
const MAX_TIME = 8.64e15;

/** The ISO string for a time in ms, or undefined when no Date can hold it (`-999999999d`, `P300000Y`). */
export function isoTime(ms: number): string | undefined {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME ? new Date(ms).toISOString() : undefined;
}

/** `today`, `now`, `-30d`, `+7d`, `-12h` or an ISO date → ISO string (undefined when it is neither). */
export function resolveDate(value: string, now: Date): string | undefined {
  const rel = RELATIVE_DATE_RE.exec(value);
  if (rel) {
    if (rel[1] === 'now') return now.toISOString();
    if (rel[1] === 'today')
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const ms = Number(rel[3]) * UNIT_MS[rel[4] as keyof typeof UNIT_MS];
    return isoTime(now.getTime() + (rel[2] === '-' ? -ms : ms));
  }
  if (!ISO_DATE_RE.test(value)) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface DateRangeValue {
  from: string;
  to: string;
  /** ISO 8601 interval `from/to` (Log Analytics `timespan`). */
  timespan: string;
}

/** A checked value, or what is wrong with it. */
export type ParamCheck = { value: unknown } | { error: string };

function dateRange(value: unknown, now: Date): DateRangeValue | string {
  let from: string | undefined;
  let to: string | undefined;
  if (typeof value === 'string' && /^P/.test(value)) {
    let ms: number;
    try {
      ms = parseDuration(value);
    } catch {
      return 'must be an ISO duration like P7D or { from, to }';
    }
    to = now.toISOString();
    from = isoTime(now.getTime() - ms);
    if (!from) return 'must be an ISO duration like P7D or { from, to }';
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as { from?: unknown; to?: unknown };
    from = typeof v.from === 'string' ? resolveDate(v.from, now) : undefined;
    to =
      typeof v.to === 'string' ? resolveDate(v.to, now) : v.to === undefined ? now.toISOString() : undefined;
    if (!from || !to) return 'must be { from, to } as ISO dates';
  } else return 'must be an ISO duration like P7D or { from, to }';
  if (from > to) return 'starts after it ends';
  return { from, to, timespan: `${from}/${to}` };
}

const optionValues = (p: Extract<Param, { type: 'enum' }>) =>
  p.values.map((o) => (typeof o === 'object' ? o.value : o));

/** The declared enum value a raw one stands for (URLs deliver "30" for 30, "true" for true). */
export function enumOptionValue(
  p: Extract<Param, { type: 'enum' }>,
  v: unknown,
): string | number | boolean | undefined {
  for (const opt of optionValues(p)) if (opt === v || String(opt) === String(v)) return opt;
  return undefined;
}

const PATTERN_PROBLEM = {
  mismatch: 'does not match the expected format',
  too_long: `is too long to check against its format (at most ${MAX_PATTERN_INPUT} characters)`,
  invalid: "can't be checked: the page declares a format AdminForge doesn't accept",
} as const;

function checkText(p: Extract<Param, { type: 'string' }>, v: unknown): ParamCheck {
  if (typeof v !== 'string' && typeof v !== 'number') return { error: 'must be text' };
  const s = String(v);
  // fetch drops TAB/LF/CR from URLs before resolving `..`: a value like ".\t." would become a dot segment there.
  if (hasControlChars(s, p.multiline === true))
    return {
      error: p.multiline ? 'contains control characters' : 'must be a single line without control characters',
    };
  const max = p.maxLength ?? MAX_PARAM_STRING;
  if (s.length > max) return { error: `must be at most ${max} characters` };
  if (p.minLength !== undefined && s.length < p.minLength)
    return { error: `must be at least ${p.minLength} characters` };
  if (p.pattern !== undefined) {
    const r = testContentPattern(p.pattern, s);
    if (r !== 'match') return { error: PATTERN_PROBLEM[r] };
  }
  if (s && p.format === 'guid' && !GUID_RE.test(s)) return { error: 'must be a GUID' };
  if (s && (p.format === 'email' || p.format === 'upn') && !EMAIL_RE.test(s))
    return { error: `must be ${p.format === 'upn' ? 'a user principal name' : 'an email address'}` };
  if (s && p.format === 'hostname' && !HOSTNAME_RE.test(s)) return { error: 'must be a host name' };
  if (s && p.format === 'url' && !HTTP_URL_RE.test(s)) return { error: 'must be an http(s) URL' };
  return { value: s };
}

/**
 * Checks and coerces one given (non-empty) page-param value (§7.3): "30" → 30, "true" → true, dates and ranges
 * resolved against `now`, GUIDs lower-cased, ids trimmed. Multi-value enums also take comma-separated text.
 */
export function checkParam(p: Param, v: unknown, now: Date): ParamCheck {
  switch (p.type) {
    case 'string':
      return checkText(p, v);
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) return { error: 'must be a number' };
      if (p.integer && !Number.isInteger(n)) return { error: 'must be a whole number' };
      if (p.min !== undefined && n < p.min) return { error: `must be at least ${p.min}` };
      if (p.max !== undefined && n > p.max) return { error: `must be at most ${p.max}` };
      return { value: n };
    }
    case 'boolean':
      if (v === true || v === 'true') return { value: true };
      if (v === false || v === 'false') return { value: false };
      return { error: 'must be true or false' };
    case 'enum': {
      if (!p.multiple && Array.isArray(v)) return { error: 'must be one value' };
      const list = p.multiple ? (Array.isArray(v) ? v : String(v).split(',')) : [v];
      if (list.length > MAX_PARAM_ITEMS) return { error: `must have at most ${MAX_PARAM_ITEMS} values` };
      const out: Array<string | number | boolean> = [];
      for (const item of list) {
        const m = enumOptionValue(p, item);
        if (m === undefined)
          return { error: `"${String(item).slice(0, 60)}" is not one of ${optionValues(p).join(', ')}` };
        out.push(m);
      }
      return { value: p.multiple ? out : out[0] };
    }
    case 'date': {
      const d = typeof v === 'string' ? resolveDate(v, now) : undefined;
      return d ? { value: d } : { error: 'must be an ISO date or today, now, -30d' };
    }
    case 'dateRange': {
      const r = dateRange(v, now);
      if (typeof r === 'string') return { error: r };
      if (p.max) {
        try {
          if (Date.parse(r.to) - Date.parse(r.from) > parseDuration(p.max))
            return { error: `may span at most ${p.max}` };
        } catch {
          // An invalid max is a content problem that validation reports.
        }
      }
      return { value: r };
    }
    case 'guid':
      if (typeof v !== 'string' || !GUID_RE.test(v.trim())) return { error: 'must be a GUID' };
      return { value: v.trim().toLowerCase() };
    default: {
      // Entity pickers (user, group, device, app, resource, subscription): object ids or resource ids.
      if (!p.multiple && Array.isArray(v)) return { error: 'must be one value' };
      const list = Array.isArray(v) ? v : [v];
      const max = p.maxItems ?? MAX_PARAM_ITEMS;
      if (list.length > max) return { error: `must have at most ${max} items` };
      for (const item of list)
        if (typeof item !== 'string' || !item.trim() || item.length > 1024 || hasControlChars(item))
          return { error: 'must be an id' };
      return { value: p.multiple ? list.map((s) => (s as string).trim()) : (list[0] as string).trim() };
    }
  }
}

/** Longest text a query-builder condition takes. */
export const MAX_ADVANCED_STRING = 256;

/**
 * Checks one query-builder value (R9) against its declared field: the API compiles only values that pass, and the
 * builder in the browser runs the same check while the person types. Dates resolve to ISO strings; GUIDs are
 * lower-cased. Messages follow `<field> <op>: ` on the API.
 */
export function checkAdvancedValue(
  f: Pick<AdvancedField, 'type' | 'values'>,
  value: unknown,
  now: Date,
): ParamCheck {
  switch (f.type) {
    case 'string':
      if (typeof value !== 'string') return { error: 'expects text' };
      if (value.length > MAX_ADVANCED_STRING) return { error: `at most ${MAX_ADVANCED_STRING} characters` };
      if (hasControlChars(value)) return { error: 'control characters are not allowed' };
      return { value };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? { value } : { error: 'expects a number' };
    case 'boolean':
      return typeof value === 'boolean' ? { value } : { error: 'expects true or false' };
    case 'date': {
      const d = typeof value === 'string' ? resolveDate(value, now) : undefined;
      return d ? { value: d } : { error: 'expects an ISO date or today, now, -30d' };
    }
    case 'guid':
      return typeof value === 'string' && GUID_RE.test(value.trim())
        ? { value: value.trim().toLowerCase() }
        : { error: 'expects a GUID' };
    case 'enum': {
      const hit = (f.values ?? []).find((v) => v === value || String(v) === String(value));
      return hit !== undefined ? { value: hit } : { error: `expects one of ${(f.values ?? []).join(', ')}` };
    }
  }
}
