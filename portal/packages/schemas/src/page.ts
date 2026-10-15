import { z } from 'zod';
import { Identifier, NavPlacement, Template, envelopeShape } from './common';
import { Datasources } from './datasource';
import { Params } from './params';
import { PageAction, WidgetBlock } from './widgets';

/**
 * Pages, dashboards and reports (§7.3, §6.6, R9). They share one shape; `kind` and `template` differ.
 * Expression scope inside a page: `params`, `user`, `env`, `now`, datasource results by name, plus `row` / `rows` /
 * `value` where a widget provides them.
 */

/** Query-builder operators (R9). */
export const ADVANCED_OPS = ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'startsWith', 'contains', 'in', 'isEmpty'] as const;
export const AdvancedOp = z.enum(ADVANCED_OPS);
export type AdvancedOp = z.infer<typeof AdvancedOp>;
export const ADVANCED_FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'guid', 'enum'] as const;

/** Operators each field type may declare, and the defaults when `operators` is omitted. */
export const ADVANCED_OPS_BY_TYPE: Record<(typeof ADVANCED_FIELD_TYPES)[number], { allowed: readonly AdvancedOp[]; defaults: readonly AdvancedOp[] }> = {
  string: { allowed: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'startsWith', 'contains', 'in', 'isEmpty'], defaults: ['eq', 'ne', 'startsWith', 'in'] },
  number: { allowed: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'in', 'isEmpty'], defaults: ['eq', 'ne', 'gt', 'ge', 'lt', 'le'] },
  boolean: { allowed: ['eq', 'ne', 'isEmpty'], defaults: ['eq'] },
  date: { allowed: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'isEmpty'], defaults: ['ge', 'le'] },
  guid: { allowed: ['eq', 'ne', 'in', 'isEmpty'], defaults: ['eq', 'in'] },
  enum: { allowed: ['eq', 'ne', 'in', 'isEmpty'], defaults: ['eq', 'in'] },
};

/** The request param that carries the builder's filter when `filters.advanced.param` is omitted. */
export const DEFAULT_ADVANCED_PARAM = 'adv';

/** A field the query builder offers. The client sends `field`; the server compiles `property`. */
export const AdvancedField = z.strictObject({
  /** Name the client uses in conditions. */
  field: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letters, digits and _ only'),
  label: z.string().min(1),
  type: z.enum(ADVANCED_FIELD_TYPES),
  /** Graph property path (`signInActivity/lastSignInDateTime`) or KQL column (`properties.state`); default: `field`. */
  property: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*([./][A-Za-z_][A-Za-z0-9_]*)*$/, 'Expected a property path like signInActivity/lastSignInDateTime or properties.state')
    .optional(),
  /** enum: the allowed values. */
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1).optional(),
  /** Allowed operators (default per type: see ADVANCED_OPS_BY_TYPE). */
  operators: z.array(AdvancedOp).min(1).optional(),
});
export type AdvancedField = z.infer<typeof AdvancedField>;

/** Operators a declared field accepts. */
export const advancedOpsFor = (f: Pick<AdvancedField, 'type' | 'operators'>): readonly AdvancedOp[] => f.operators ?? ADVANCED_OPS_BY_TYPE[f.type].defaults;

/**
 * Filter bar (R9). Facets default to params with `facet: true`. `advanced` is the query builder: the client sends a
 * structured filter (`{ all|any: [{ field, op, value }] }`) in the request param `param` (default `adv`, NOT declared
 * under params); the server validates it against `fields` and compiles it — OData for Graph datasources, KQL for
 * Resource Graph / Log Analytics — into `${ advanced }`. Templates never see the raw value.
 */
export const FilterBar = z.strictObject({
  /** Param bound to the free-text search box. */
  search: Identifier.optional(),
  /** Params rendered as facet chips, in this order. */
  facets: z.array(Identifier).optional(),
  advanced: z
    .strictObject({
      /** odata / kql: compiled server-side into `${ advanced }`; client: the browser filters loaded rows. */
      dialect: z.enum(['odata', 'kql', 'client']),
      /** Request param carrying the structured filter (default `adv`). Must not be declared under params. */
      param: Identifier.optional(),
      fields: z.array(AdvancedField).min(1).max(50),
    })
    .optional(),
});
export type FilterBar = z.infer<typeof FilterBar>;

/** Export of the full result set (all pages, streamed server-side and audited). */
export const ExportSpec = z.strictObject({
  formats: z.array(z.enum(['csv', 'xlsx'])).min(1),
  /** Template; the extension is added. */
  fileName: Template.optional(),
  /** Datasource path to export, e.g. `users.value` (default: the first table's `data`). */
  data: z.string().min(1).optional(),
  /** `visible` = the user's current columns; `all` = every declared column. */
  columns: z.enum(['visible', 'all']).optional(),
  maxRows: z.number().int().min(1).max(1_000_000).optional(),
});
export type ExportSpec = z.infer<typeof ExportSpec>;

/** Saved views (personal and shared param + column sets) and built-in views shipped with the page. */
export const SavedViewsSpec = z.strictObject({
  enabled: z.boolean().default(true),
  shared: z.boolean().default(true),
  /** Built-in, read-only views. */
  presets: z.array(z.strictObject({ name: z.string().min(1), params: z.record(z.string(), z.unknown()), columns: z.array(z.string()).optional() })).optional(),
});
export type SavedViewsSpec = z.infer<typeof SavedViewsSpec>;

export const EntityHeader = z.strictObject({
  title: Template,
  subtitle: Template.optional(),
  /** Tone or `${ … }` returning ok|warn|crit|info|neutral. */
  status: Template.optional(),
  statusLabel: Template.optional(),
  /** Id chips (copyable), e.g. `{ Object id: ${ user.value.id } }`. */
  ids: z.record(z.string(), Template).optional(),
});

export const Tab = z.strictObject({
  id: Identifier,
  label: z.string().min(1),
  layout: z.array(WidgetBlock),
});

const pageShape = {
  ...envelopeShape,
  nav: NavPlacement.optional(),
  params: Params.optional(),
  datasources: Datasources.optional(),
  layout: z.array(WidgetBlock).optional(),
  /** Entity template: tabs under the identity header. */
  tabs: z.array(Tab).optional(),
  header: EntityHeader.optional(),
  actions: z.array(PageAction).optional(),
  filters: FilterBar.optional(),
  export: ExportSpec.optional(),
  savedViews: SavedViewsSpec.optional(),
  /** Auto-refresh interval in seconds. */
  refresh: z.number().int().min(15).optional(),
};

/** The query builder's raw value never reaches templates: not declared as a param, never referenced as one. */
function checkAdvanced(def: { params?: Params; filters?: FilterBar } & Record<string, unknown>, ctx: z.RefinementCtx) {
  const adv = def.filters?.advanced;
  if (!adv) return;
  const name = adv.param ?? DEFAULT_ADVANCED_PARAM;
  if (def.params && name in def.params)
    ctx.addIssue({
      code: 'custom',
      path: ['params', name],
      message: `"${name}" carries the query builder's filter: don't declare it under params. Use \${ advanced } (the server-compiled filter) in requests.`,
    });
  const { filters: _f, ...rest } = def;
  const reads = new RegExp(`\\bparams\\s*\\.\\s*${name}\\b|\\bparams\\s*\\[\\s*['"]${name}['"]\\s*\\]|\\$lookup\\(\\s*params\\s*,\\s*['"]${name}['"]`);
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(rest);
  if (strings.some((x) => reads.test(x)))
    ctx.addIssue({
      code: 'custom',
      path: ['filters', 'advanced', 'param'],
      message: `Expressions must not read params.${name} (the raw builder input). Use \${ advanced }, which the server compiles safely.`,
    });
  const seen = new Set<string>();
  adv.fields.forEach((f, i) => {
    if (seen.has(f.field)) ctx.addIssue({ code: 'custom', path: ['filters', 'advanced', 'fields', i, 'field'], message: `Duplicate field "${f.field}".` });
    seen.add(f.field);
    if (f.type === 'enum' && !f.values?.length) ctx.addIssue({ code: 'custom', path: ['filters', 'advanced', 'fields', i, 'values'], message: 'enum fields need values.' });
    const allowed = ADVANCED_OPS_BY_TYPE[f.type].allowed;
    f.operators?.forEach((op, j) => {
      if (!allowed.includes(op))
        ctx.addIssue({ code: 'custom', path: ['filters', 'advanced', 'fields', i, 'operators', j], message: `${op} does not apply to ${f.type} fields (use ${allowed.join(', ')}).` });
    });
    if (adv.dialect === 'odata' && f.property?.includes('.'))
      ctx.addIssue({ code: 'custom', path: ['filters', 'advanced', 'fields', i, 'property'], message: 'OData property paths use / (e.g. signInActivity/lastSignInDateTime).' });
    if (adv.dialect === 'kql' && f.property?.includes('/'))
      ctx.addIssue({ code: 'custom', path: ['filters', 'advanced', 'fields', i, 'property'], message: 'KQL columns use . (e.g. properties.state).' });
  });
}

function checkPage(def: { params?: Params; datasources?: Datasources; layout?: unknown[]; tabs?: unknown[]; filters?: FilterBar; export?: ExportSpec }, ctx: z.RefinementCtx) {
  const params = def.params ?? {};
  const need = (name: string | undefined, path: (string | number)[]) => {
    if (name && !(name in params)) ctx.addIssue({ code: 'custom', path, message: `Unknown param "${name}". Declare it under params.` });
  };
  need(def.filters?.search, ['filters', 'search']);
  def.filters?.facets?.forEach((f, i) => need(f, ['filters', 'facets', i]));
  checkAdvanced(def, ctx);
  const exportDs = def.export?.data?.split(/[.[]/)[0];
  if (exportDs && !(exportDs in (def.datasources ?? {})))
    ctx.addIssue({ code: 'custom', path: ['export', 'data'], message: `Unknown datasource "${exportDs}".` });
  if (!def.layout?.length && !def.tabs?.length) ctx.addIssue({ code: 'custom', path: ['layout'], message: 'Add at least one widget to layout (or tabs).' });
}

export const Page = z
  .strictObject({
    kind: z.literal('page'),
    ...pageShape,
    template: z.enum(['list-detail', 'entity', 'dashboard', 'settings']),
  })
  .superRefine(checkPage);
export type Page = z.infer<typeof Page>;

export const Dashboard = z
  .strictObject({
    kind: z.literal('dashboard'),
    ...pageShape,
    template: z.literal('dashboard').default('dashboard'),
  })
  .superRefine(checkPage);
export type Dashboard = z.infer<typeof Dashboard>;

export const Report = z
  .strictObject({
    kind: z.literal('report'),
    ...pageShape,
    template: z.literal('report').default('report'),
    export: ExportSpec,
  })
  .superRefine(checkPage);
export type Report = z.infer<typeof Report>;

export type PageLike = Page | Dashboard | Report;
