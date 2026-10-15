import type { Param, Params } from '@adminforge/schemas';

/**
 * Page params ↔ URL search (§7.3). The URL is the source of truth: params are read leniently (a hand-edited link
 * never crashes the page — bad values fall back to the default and are reported), and only values that differ from
 * the default are written back, so links stay short.
 */

export type ParamValue = string | number | boolean | Array<string | number | boolean> | { from: string; to: string };

export interface ResolvedParams {
  /** Values for display and expression scope (`params`): URL value, else a literal default. */
  values: Record<string, unknown>;
  /** Values sent to the server (URL-provided, valid) — the server applies defaults itself. */
  send: Record<string, unknown>;
  /** Param name → what was wrong with the URL value. */
  issues: Record<string, string>;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isExpr = (v: unknown) => typeof v === 'string' && v.includes('${');

export const enumOptions = (p: Extract<Param, { type: 'enum' }>) =>
  p.values.map((o) => (typeof o === 'object' ? { value: o.value, label: o.label } : { value: o, label: String(o) }));

function matchEnum(p: Extract<Param, { type: 'enum' }>, v: unknown): string | number | boolean | undefined {
  for (const o of enumOptions(p)) if (o.value === v || String(o.value) === String(v)) return o.value;
  return undefined;
}

/** A literal default usable in the browser (expression and relative-date defaults are left to the server). */
export function literalDefault(p: Param): unknown {
  const d = (p as { default?: unknown }).default;
  if (d === undefined || isExpr(d)) return undefined;
  return d;
}

/** Coerces one raw URL value; returns [value] or [undefined, problem]. */
export function coerceParam(p: Param, raw: unknown): [unknown, string?] {
  if (raw === undefined || raw === null || raw === '') return [undefined];
  switch (p.type) {
    case 'string': {
      const s = String(raw);
      if (p.maxLength && s.length > p.maxLength) return [undefined, `is longer than ${p.maxLength} characters`];
      return [s];
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) return [undefined, 'is not a number'];
      if (p.min !== undefined && n < p.min) return [undefined, `is below ${p.min}`];
      if (p.max !== undefined && n > p.max) return [undefined, `is above ${p.max}`];
      return [n];
    }
    case 'boolean':
      if (raw === true || raw === 'true') return [true];
      if (raw === false || raw === 'false') return [false];
      return [undefined, 'is not true or false'];
    case 'enum': {
      if (p.multiple) {
        const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((v) => matchEnum(p, v));
        if (list.some((v) => v === undefined)) return [undefined, 'has a value that is not offered'];
        return [list];
      }
      const v = matchEnum(p, raw);
      return v === undefined ? [undefined, 'is not one of the offered values'] : [v];
    }
    case 'guid':
      return GUID.test(String(raw)) ? [String(raw)] : [undefined, 'is not a GUID'];
    case 'date':
      return [String(raw)];
    case 'dateRange':
      if (typeof raw === 'string' && /^P/.test(raw)) return [raw];
      if (typeof raw === 'object' && raw && typeof (raw as { from?: unknown }).from === 'string')
        return [{ from: (raw as { from: string }).from, to: String((raw as { to?: unknown }).to ?? '') || new Date().toISOString() }];
      return [undefined, 'is not a duration like P7D or a { from, to } range'];
    default: {
      // Entity pickers (user, group, device, app, resource, subscription).
      const multiple = (p as { multiple?: boolean }).multiple;
      if (multiple) return [(Array.isArray(raw) ? raw : String(raw).split(',')).map(String)];
      return [String(raw)];
    }
  }
}

export function resolveParams(declared: Params | undefined, search: Record<string, unknown>): ResolvedParams {
  const values: Record<string, unknown> = {};
  const send: Record<string, unknown> = {};
  const issues: Record<string, string> = {};
  for (const [name, p] of Object.entries(declared ?? {})) {
    const [v, problem] = coerceParam(p, search[name]);
    if (problem) issues[name] = `${p.label ?? name} ${problem}`;
    if (v !== undefined) {
      values[name] = v;
      send[name] = v;
    } else {
      const d = literalDefault(p);
      if (d !== undefined) values[name] = d;
    }
  }
  return { values, send, issues };
}

/** True when `value` equals the param's default (so the URL can drop it). */
export function isDefault(p: Param, value: unknown): boolean {
  const d = literalDefault(p);
  if (value === undefined || value === null || value === '') return d === undefined || d === '';
  if (d === undefined) return false;
  return JSON.stringify(d) === JSON.stringify(value) || String(d) === String(value);
}

/**
 * Search patch for new param values: defaults and blanks are removed from the URL. Keys that aren't declared params
 * (the query builder's filter) pass through as given.
 */
export function paramsToSearch(declared: Params | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(patch)) {
    const p = declared?.[name];
    if (!p) out[name] = value === '' ? undefined : value;
    else out[name] = isDefault(p, value) || (Array.isArray(value) && value.length === 0) ? undefined : value;
  }
  return out;
}

/** "All", "Any", "*" — enum values that mean "no filter" (shown as the facet's unselected state). */
export const isNeutralOption = (p: Param, value: unknown) =>
  p.type === 'enum' && !p.multiple && isDefault(p, value) && /^(all|any|\*)$/i.test(String(value));

export const DATE_RANGE_PRESETS: Record<string, string> = {
  PT1H: 'Last hour',
  PT24H: 'Last 24 hours',
  P1D: 'Last 24 hours',
  P7D: 'Last 7 days',
  P14D: 'Last 14 days',
  P30D: 'Last 30 days',
  P90D: 'Last 90 days',
};

export function dateRangeLabel(v: unknown): string {
  if (typeof v === 'string') return DATE_RANGE_PRESETS[v] ?? v;
  if (v && typeof v === 'object' && 'from' in v) {
    const r = v as { from: string; to: string };
    return `${r.from.slice(0, 10)} → ${r.to.slice(0, 10)}`;
  }
  return 'Any time';
}
