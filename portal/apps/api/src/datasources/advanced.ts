import { advancedOpsFor, DEFAULT_ADVANCED_PARAM, type AdvancedField, type AdvancedOp, type FilterBar } from '@adminforge/schemas';
import { z } from 'zod';
import { resolveDate, type ParamIssue } from './params';

/**
 * The query builder's filter (`filters.advanced`, R9) arrives as structured data — never as OData/KQL text — and is
 * compiled here into a safe expression. Templates only ever see the compiled string as `${ advanced }`; the raw
 * value is not in the expression scope (and the schema rejects definitions that reference it).
 *
 * Wire format (request `params[<filters.advanced.param>]`, default `adv`): a group
 *   { "all": [ <clause>, … ] }   or   { "any": [ <clause>, … ] }
 * where a clause is a condition { "field", "op", "value"? } or (one level deep) another group of conditions.
 * Accepted as a JSON object, a JSON string, or base64url-encoded JSON (what the URL carries).
 */

export const MAX_CONDITIONS = 20;
export const MAX_IN_VALUES = 50;
const MAX_STRING = 256;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const OData_PROPERTY = /^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/;
const KQL_PROPERTY = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const Scalar = z.union([z.string(), z.number(), z.boolean()]);
const Condition = z.strictObject({
  field: z.string().min(1).max(100),
  op: z.string().min(1).max(20),
  value: z.union([Scalar, z.array(Scalar).max(MAX_IN_VALUES), z.null()]).optional(),
});
const Inner = z.union([z.strictObject({ all: z.array(Condition).max(MAX_CONDITIONS) }), z.strictObject({ any: z.array(Condition).max(MAX_CONDITIONS) })]);
const Clause = z.union([Condition, Inner]);
/** Root group: conditions and at most one level of nested groups (nesting ≤ 2). */
export const AdvancedFilterInput = z.union([z.strictObject({ all: z.array(Clause).max(MAX_CONDITIONS) }), z.strictObject({ any: z.array(Clause).max(MAX_CONDITIONS) })]);
export type AdvancedFilterInput = z.infer<typeof AdvancedFilterInput>;

export type AdvancedValue = string | number | boolean | Array<string | number | boolean> | null;
/** A validated condition: field/op checked against the declaration, value normalised to its type. */
export interface AdvancedCondition {
  field: AdvancedField;
  op: AdvancedOp;
  value: AdvancedValue;
}
export interface AdvancedGroup {
  join: 'and' | 'or';
  clauses: Array<AdvancedCondition | AdvancedGroup>;
}

export class AdvancedFilterError extends Error {
  constructor(readonly issues: ParamIssue[]) {
    super(issues.map((i) => i.message).join('; '));
  }
}

const isGroup = (c: AdvancedCondition | AdvancedGroup): c is AdvancedGroup => 'join' in c;

/** Object, JSON string or base64url JSON → parsed value (undefined = no filter). */
export function decodeAdvanced(raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (text.startsWith('{')) return JSON.parse(text);
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(text)) throw new SyntaxError('not JSON or base64url JSON');
  return JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
}

function checkValue(f: AdvancedField, op: AdvancedOp, value: unknown, now: Date): { ok: true; value: AdvancedValue } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message: `${f.field} ${op}: ${message}` });
  if (op === 'isEmpty') return value === undefined || value === null || value === true ? { ok: true, value: null } : bad('takes no value');
  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0) return bad(`expects a list of 1–${MAX_IN_VALUES} values`);
    const out: Array<string | number | boolean> = [];
    for (const v of value) {
      const one = checkValue(f, 'eq', v, now);
      if (!one.ok) return bad(one.message.replace(/^.*?: /, ''));
      out.push(one.value as string | number | boolean);
    }
    return { ok: true, value: out };
  }
  if (Array.isArray(value)) return bad('expects a single value');
  switch (f.type) {
    case 'string':
      if (typeof value !== 'string') return bad('expects text');
      if (value.length > MAX_STRING) return bad(`at most ${MAX_STRING} characters`);
      if (CONTROL.test(value)) return bad('control characters are not allowed');
      return { ok: true, value };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? { ok: true, value } : bad('expects a number');
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : bad('expects true or false');
    case 'date': {
      const d = typeof value === 'string' ? resolveDate(value, now) : undefined;
      return d ? { ok: true, value: d } : bad('expects an ISO date or today, now, -30d');
    }
    case 'guid':
      return typeof value === 'string' && GUID.test(value.trim()) ? { ok: true, value: value.trim().toLowerCase() } : bad('expects a GUID');
    case 'enum': {
      const hit = (f.values ?? []).find((v) => v === value || String(v) === String(value));
      return hit !== undefined ? { ok: true, value: hit } : bad(`expects one of ${(f.values ?? []).join(', ')}`);
    }
  }
}

/**
 * Validates the raw filter against the page's declared fields: unknown fields or operators, wrong value types,
 * nesting deeper than 2 and more than 20 conditions are rejected (AdvancedFilterError with every problem).
 */
export function parseAdvanced(spec: NonNullable<FilterBar['advanced']>, raw: unknown, now: Date): AdvancedGroup | undefined {
  const param = spec.param ?? DEFAULT_ADVANCED_PARAM;
  let decoded: unknown;
  try {
    decoded = decodeAdvanced(raw);
  } catch {
    throw new AdvancedFilterError([{ param, message: 'must be the query builder filter as JSON ({ "all" | "any": [...] })' }]);
  }
  if (decoded === undefined) return undefined;
  const parsed = AdvancedFilterInput.safeParse(decoded);
  if (!parsed.success) {
    throw new AdvancedFilterError([{ param, message: `is not a valid filter (${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')})` }]);
  }
  const fields = new Map(spec.fields.map((f) => [f.field, f]));
  const issues: ParamIssue[] = [];
  let count = 0;
  const group = (g: { all: unknown[] } | { any: unknown[] }): AdvancedGroup => {
    const join = 'all' in g ? 'and' : 'or';
    const items = ('all' in g ? g.all : g.any) as Array<z.infer<typeof Clause>>;
    const clauses: AdvancedGroup['clauses'] = [];
    for (const c of items) {
      if ('all' in c || 'any' in c) {
        const inner = group(c);
        if (inner.clauses.length) clauses.push(inner);
        continue;
      }
      count++;
      const f = fields.get(c.field);
      if (!f) {
        issues.push({ param, message: `unknown field "${c.field.slice(0, 60)}"` });
        continue;
      }
      const ops = advancedOpsFor(f);
      if (!(ops as readonly string[]).includes(c.op)) {
        issues.push({ param, message: `${f.field} does not support "${c.op.slice(0, 20)}" (use ${ops.join(', ')})` });
        continue;
      }
      const v = checkValue(f, c.op as AdvancedOp, c.value, now);
      if (!v.ok) issues.push({ param, message: v.message });
      else clauses.push({ field: f, op: c.op as AdvancedOp, value: v.value });
    }
    return { join, clauses };
  };
  const root = group(parsed.data);
  if (count > MAX_CONDITIONS) issues.push({ param, message: `at most ${MAX_CONDITIONS} conditions` });
  if (issues.length) throw new AdvancedFilterError(issues);
  return root.clauses.length ? root : undefined;
}

// ── Compilation ─────────────────────────────────────────────────────────────

/** OData string literal: O'Brien → 'O''Brien' (same quoting as $odata()). */
export const odataString = (s: string) => `'${s.replaceAll("'", "''")}'`;
/** KQL string literal: backslash and quote escaped, control characters dropped. */
// eslint-disable-next-line no-control-regex
export const kqlString = (s: string) => `'${s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const property = (f: AdvancedField, dialect: 'odata' | 'kql') => {
  const p = f.property ?? f.field;
  if (!(dialect === 'odata' ? OData_PROPERTY : KQL_PROPERTY).test(p)) throw new Error(`Field ${f.field} cannot be compiled to ${dialect} (property ${p}).`);
  return p;
};

function odataLiteral(f: AdvancedField, v: string | number | boolean): string {
  if (f.type === 'number') return String(v);
  if (f.type === 'boolean') return v ? 'true' : 'false';
  if (f.type === 'date') return new Date(String(v)).toISOString();
  if (f.type === 'enum' && typeof v !== 'string') return String(v);
  return odataString(String(v));
}

function kqlLiteral(f: AdvancedField, v: string | number | boolean): string {
  if (f.type === 'number') return String(v);
  if (f.type === 'boolean') return v ? 'true' : 'false';
  if (f.type === 'date') return `datetime(${new Date(String(v)).toISOString()})`;
  if (f.type === 'enum' && typeof v !== 'string') return String(v);
  return kqlString(String(v));
}

const ODATA_CMP: Partial<Record<AdvancedOp, string>> = { eq: 'eq', ne: 'ne', gt: 'gt', ge: 'ge', lt: 'lt', le: 'le' };

function odataCondition(c: AdvancedCondition): string {
  const p = property(c.field, 'odata');
  const lit = (v: unknown) => odataLiteral(c.field, v as string | number | boolean);
  switch (c.op) {
    case 'isEmpty':
      return `${p} eq null`;
    case 'in':
      return `${p} in (${(c.value as Array<string | number | boolean>).map(lit).join(', ')})`;
    case 'startsWith':
      return `startswith(${p}, ${lit(c.value)})`;
    case 'contains':
      return `contains(${p}, ${lit(c.value)})`;
    default:
      return `${p} ${ODATA_CMP[c.op]} ${lit(c.value)}`;
  }
}

const KQL_CMP: Partial<Record<AdvancedOp, string>> = { gt: '>', ge: '>=', lt: '<', le: '<=' };
const textual = (f: AdvancedField) => f.type === 'string' || f.type === 'guid' || (f.type === 'enum' && (f.values ?? []).every((v) => typeof v === 'string'));

function kqlCondition(c: AdvancedCondition): string {
  const p = property(c.field, 'kql');
  const lit = (v: unknown) => kqlLiteral(c.field, v as string | number | boolean);
  const text = textual(c.field);
  switch (c.op) {
    case 'isEmpty':
      return `isempty(${p})`;
    case 'in':
      return `${p} ${text ? 'in~' : 'in'} (${(c.value as Array<string | number | boolean>).map(lit).join(', ')})`;
    case 'startsWith':
      return `${p} startswith ${lit(c.value)}`;
    case 'contains':
      return `${p} contains ${lit(c.value)}`;
    case 'eq':
      return `${p} ${text ? '=~' : '=='} ${lit(c.value)}`;
    case 'ne':
      return `${p} ${text ? '!~' : '!='} ${lit(c.value)}`;
    default:
      return `${p} ${KQL_CMP[c.op]} ${lit(c.value)}`;
  }
}

/**
 * The filter as an OData `$filter` clause or a KQL `where` predicate. Always parenthesised when it has more than one
 * condition, so `… and ${ advanced }` / `| where ${ advanced }` keep their meaning.
 */
export function compileAdvanced(g: AdvancedGroup, dialect: 'odata' | 'kql'): string {
  const cond = dialect === 'odata' ? odataCondition : kqlCondition;
  const render = (x: AdvancedGroup | AdvancedCondition): string => {
    if (!isGroup(x)) return cond(x);
    const parts = x.clauses.map(render);
    return parts.length === 1 ? parts[0]! : `(${parts.join(` ${x.join} `)})`;
  };
  return render(g);
}

/** Which dialect a datasource's templates get: OData for Graph, KQL for Resource Graph / Log Analytics. */
export function dialectFor(source: string): 'odata' | 'kql' | undefined {
  if (source === 'graph' || source === 'graphBatch') return 'odata';
  if (source === 'resourceGraph' || source === 'logAnalytics') return 'kql';
  return undefined;
}

/** The request param that carries the builder's filter for a page (undefined when the page has no query builder). */
export const advancedParamOf = (filters: FilterBar | undefined): string | undefined => (filters?.advanced ? (filters.advanced.param ?? DEFAULT_ADVANCED_PARAM) : undefined);

/** The validated filter in wire form (audit records, saved state). */
export function describeAdvanced(g: AdvancedGroup): AdvancedFilterInput {
  const one = (x: AdvancedGroup | AdvancedCondition): unknown =>
    isGroup(x) ? { [x.join === 'and' ? 'all' : 'any']: x.clauses.map(one) } : { field: x.field.field, op: x.op, ...(x.value !== null ? { value: x.value } : {}) };
  return one(g) as AdvancedFilterInput;
}
