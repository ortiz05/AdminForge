import { renderString, type Scope } from '@adminforge/expressions';
import { parseDuration, type Param, type Params } from '@adminforge/schemas';
import { AppError } from '../errors';

export interface ParamIssue {
  param: string;
  message: string;
}

/** 400 with every problem listed (the client renders them next to the filter controls). */
export class InvalidParams extends AppError {
  constructor(readonly issues: ParamIssue[]) {
    super(
      400,
      'invalid_params',
      `Invalid parameters: ${issues.map((i) => `${i.param}: ${i.message}`).join('; ')}`,
      {
        hint: 'Check the filter values and try again.',
      },
    );
    this.name = 'InvalidParams';
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^(?=.{1,253}$)([A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9-]{1,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const RELATIVE = /^(today|now|([+-])(\d+)([hdwmy]))$/;
const MAX_STRING = 4096;
const MAX_ITEMS = 1000;
const UNIT_MS = {
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  m: 30 * 86_400_000,
  y: 365 * 86_400_000,
} as const;

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** `today`, `now`, `-30d`, `+7d`, `-12h` (m = 30 days, y = 365 days) or an ISO date → ISO string. */
export function resolveDate(value: string, now: Date): string | undefined {
  const rel = RELATIVE.exec(value);
  if (rel) {
    if (rel[1] === 'now') return now.toISOString();
    if (rel[1] === 'today')
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const ms = Number(rel[3]) * UNIT_MS[rel[4] as keyof typeof UNIT_MS];
    return new Date(now.getTime() + (rel[2] === '-' ? -ms : ms)).toISOString();
  }
  if (!ISO_DATE.test(value)) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface DateRangeValue {
  from: string;
  to: string;
  /** ISO 8601 interval `from/to` (Log Analytics `timespan`). */
  timespan: string;
}

function dateRange(value: unknown, now: Date): DateRangeValue | string {
  let from: string | undefined;
  let to: string | undefined;
  if (typeof value === 'string' && /^P/.test(value)) {
    let ms: number;
    try {
      ms = parseDuration(value);
    } catch {
      return 'expected an ISO duration like P7D or { from, to }';
    }
    to = now.toISOString();
    from = new Date(now.getTime() - ms).toISOString();
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as { from?: unknown; to?: unknown };
    from = typeof v.from === 'string' ? resolveDate(v.from, now) : undefined;
    to =
      typeof v.to === 'string' ? resolveDate(v.to, now) : v.to === undefined ? now.toISOString() : undefined;
    if (!from || !to) return 'expected { from, to } as ISO dates';
  } else return 'expected an ISO duration like P7D or { from, to }';
  if (from > to) return '`from` is after `to`';
  return { from, to, timespan: `${from}/${to}` };
}

const optionValues = (p: Extract<Param, { type: 'enum' }>) =>
  p.values.map((o) => (typeof o === 'object' ? o.value : o));

/** Matches the declared enum value (URLs deliver "30" for 30, "true" for true). */
function enumValue(p: Extract<Param, { type: 'enum' }>, v: unknown): string | number | boolean | undefined {
  for (const opt of optionValues(p)) if (opt === v || String(opt) === String(v)) return opt;
  return undefined;
}

function checkOne(name: string, p: Param, v: unknown, now: Date, issues: ParamIssue[]): unknown {
  const bad = (message: string) => {
    issues.push({ param: name, message });
    return undefined;
  };
  switch (p.type) {
    case 'string': {
      if (typeof v !== 'string' && typeof v !== 'number') return bad('expected text');
      const s = String(v);
      if (s.length > (p.maxLength ?? MAX_STRING))
        return bad(`at most ${p.maxLength ?? MAX_STRING} characters`);
      if (p.minLength !== undefined && s.length < p.minLength)
        return bad(`at least ${p.minLength} characters`);
      if (p.pattern) {
        let re: RegExp | undefined;
        try {
          re = new RegExp(`^(?:${p.pattern})$`, 'u');
        } catch {
          re = undefined;
        }
        if (re && !re.test(s)) return bad('does not match the expected format');
      }
      if (s && p.format === 'guid' && !GUID.test(s)) return bad('expected a GUID');
      if (s && (p.format === 'email' || p.format === 'upn') && !EMAIL.test(s))
        return bad(`expected ${p.format === 'upn' ? 'a user principal name' : 'an email address'}`);
      if (s && p.format === 'hostname' && !HOST.test(s)) return bad('expected a host name');
      if (s && p.format === 'url' && !/^https?:\/\/\S+$/.test(s)) return bad('expected an http(s) URL');
      return s;
    }
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) return bad('expected a number');
      if (p.integer && !Number.isInteger(n)) return bad('expected a whole number');
      if (p.min !== undefined && n < p.min) return bad(`at least ${p.min}`);
      if (p.max !== undefined && n > p.max) return bad(`at most ${p.max}`);
      return n;
    }
    case 'boolean':
      if (v === true || v === 'true') return true;
      if (v === false || v === 'false') return false;
      return bad('expected true or false');
    case 'enum': {
      const list = p.multiple ? (Array.isArray(v) ? v : String(v).split(',')) : [v];
      if (!p.multiple && Array.isArray(v)) return bad('expected one value');
      if (list.length > MAX_ITEMS) return bad(`at most ${MAX_ITEMS} values`);
      const out: Array<string | number | boolean> = [];
      for (const item of list) {
        const m = enumValue(p, item);
        if (m === undefined)
          return bad(`"${String(item).slice(0, 60)}" is not one of ${optionValues(p).join(', ')}`);
        out.push(m);
      }
      return p.multiple ? out : out[0];
    }
    case 'date': {
      const d = typeof v === 'string' ? resolveDate(v, now) : undefined;
      if (!d) return bad('expected an ISO date or today, now, -30d');
      return d;
    }
    case 'dateRange': {
      const r = dateRange(v, now);
      if (typeof r === 'string') return bad(r);
      if (p.max) {
        try {
          if (Date.parse(r.to) - Date.parse(r.from) > parseDuration(p.max))
            return bad(`the range may span at most ${p.max}`);
        } catch {
          // invalid max is a content problem caught by validation
        }
      }
      return r;
    }
    case 'guid':
      if (typeof v !== 'string' || !GUID.test(v.trim())) return bad('expected a GUID');
      return v.trim().toLowerCase();
    default: {
      // Entity pickers (user, group, device, app, resource, subscription): object ids / resource ids.
      const list = Array.isArray(v) ? v : [v];
      if (!p.multiple && Array.isArray(v)) return bad('expected one value');
      if (list.length > (p.maxItems ?? MAX_ITEMS)) return bad(`at most ${p.maxItems ?? MAX_ITEMS} items`);
      for (const item of list)
        if (typeof item !== 'string' || !item.trim() || item.length > 1024) return bad('expected an id');
      return p.multiple ? list.map((s) => (s as string).trim()) : (list[0] as string).trim();
    }
  }
}

/**
 * Validates page params against their declarations (§7.3) and fills defaults. Unknown names are rejected; values are
 * coerced the way URLs deliver them ("30" → 30, "true" → true). `default` expressions see `now`, `user` and `env`.
 */
export async function resolveParams(
  declared: Params | undefined,
  input: Record<string, unknown> | undefined,
  scope: Scope & { now: string },
): Promise<Record<string, unknown>> {
  const decl = declared ?? {};
  const raw = input ?? {};
  const now = new Date(scope.now);
  const issues: ParamIssue[] = [];
  for (const name of Object.keys(raw))
    if (!Object.hasOwn(decl, name)) issues.push({ param: name, message: 'unknown parameter' });
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(decl)) {
    let v: unknown = Object.hasOwn(raw, name) ? raw[name] : undefined;
    if (isEmpty(v) && p.default !== undefined) {
      v = p.default;
      if (typeof v === 'string' && v.includes('${')) {
        try {
          v = await renderString(v, scope);
        } catch (err) {
          issues.push({ param: name, message: `default could not be evaluated: ${(err as Error).message}` });
          continue;
        }
      }
    }
    if (isEmpty(v)) {
      if (p.required) issues.push({ param: name, message: 'is required' });
      // Text params keep "" so expressions can test them (`params.q ? …`).
      if (p.type === 'string' && v === '') out[name] = '';
      continue;
    }
    const checked = checkOne(name, p, v, now, issues);
    if (checked !== undefined) out[name] = checked;
  }
  if (issues.length) throw new InvalidParams(issues);
  return out;
}

/** The first date-range param's interval (default Log Analytics timespan), if any. */
export function defaultTimespan(
  declared: Params | undefined,
  values: Record<string, unknown>,
): string | undefined {
  for (const [name, p] of Object.entries(declared ?? {})) {
    if (p.type !== 'dateRange') continue;
    const v = values[name] as DateRangeValue | undefined;
    if (v?.timespan) return v.timespan;
  }
  return undefined;
}
