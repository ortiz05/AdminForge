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

/** Filter bar (R9). Facets default to params with `facet: true`; `advanced` is the query builder, compiled server-side. */
export const FilterBar = z.strictObject({
  /** Param bound to the free-text search box. */
  search: Identifier.optional(),
  /** Params rendered as facet chips, in this order. */
  facets: z.array(Identifier).optional(),
  advanced: z
    .strictObject({
      /** odata → `$filter` text; kql → a `where` clause; client → filters loaded rows. Values are always quoted safely. */
      dialect: z.enum(['odata', 'kql', 'client']),
      /** Param that receives the compiled filter string (declare it as a hidden string param). */
      param: Identifier.optional(),
      fields: z
        .array(
          z.strictObject({
            field: z.string().min(1),
            label: z.string().min(1),
            type: z.enum(['string', 'number', 'boolean', 'date', 'guid', 'enum']),
            values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
            operators: z.array(z.enum(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'startsWith', 'contains', 'in', 'isEmpty'])).optional(),
          }),
        )
        .min(1),
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

function checkPage(def: { params?: Params; datasources?: Datasources; layout?: unknown[]; tabs?: unknown[]; filters?: FilterBar; export?: ExportSpec }, ctx: z.RefinementCtx) {
  const params = def.params ?? {};
  const need = (name: string | undefined, path: (string | number)[]) => {
    if (name && !(name in params)) ctx.addIssue({ code: 'custom', path, message: `Unknown param "${name}". Declare it under params.` });
  };
  need(def.filters?.search, ['filters', 'search']);
  def.filters?.facets?.forEach((f, i) => need(f, ['filters', 'facets', i]));
  need(def.filters?.advanced?.param, ['filters', 'advanced', 'param']);
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
