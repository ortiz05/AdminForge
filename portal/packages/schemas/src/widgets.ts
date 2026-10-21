import { z } from 'zod';
import { DefinitionId, IconName, Identifier, exprOr } from './common';

/**
 * Widget blocks (§7.4). Each block is a passthrough object with a required `widget` key; widget-specific config schemas
 * live in @adminforge/widgets and plug in through `registerWidgetSchema`. The table pieces (columns, row/bulk actions,
 * inspect) are defined here because list pages, saved views and exports depend on them (R9).
 */

export const StatusTone = z.enum(['ok', 'warn', 'crit', 'info', 'neutral']);
export type StatusTone = z.infer<typeof StatusTone>;

/** Default words for a bare tone (a status value that already is ok|warn|crit|info|neutral). */
export const STATUS_TONE_LABEL: Record<StatusTone, string> = {
  ok: 'Healthy',
  warn: 'Needs review',
  crit: 'Action needed',
  info: 'Info',
  neutral: 'No data',
};

export const isStatusTone = (v: unknown): v is StatusTone =>
  typeof v === 'string' && (StatusTone.options as readonly string[]).includes(v);

export const COLUMN_KINDS = [
  'text',
  'identity',
  'status',
  'enum',
  'relativeTime',
  'datetime',
  'date',
  'number',
  'percent',
  'bytes',
  'boolean',
  'guid',
  'tags',
  'link',
  'code',
] as const;
export const ColumnKind = z.enum(COLUMN_KINDS);

export const ColumnFilterType = z.enum(['text', 'facet', 'range', 'date']);
export type ColumnFilterType = z.infer<typeof ColumnFilterType>;

const StatusEntry = z.union([
  z.tuple([StatusTone, z.string()]),
  z.strictObject({ tone: StatusTone, label: z.string() }),
]);
export type ColumnMapEntry = string | readonly [StatusTone, string] | { tone: StatusTone; label: string };

/** Raw value → map key: booleans and numbers by their text, null/undefined as "null". */
export const columnMapKey = (v: unknown): string =>
  v === undefined || v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/**
 * The `map` entry for a raw value — exact key first, then text values case-insensitively. The table (widgets) and
 * the export (API) both look values up here, so a file says what the column shows.
 */
export function columnMapEntry(
  map: Readonly<Record<string, ColumnMapEntry>>,
  value: unknown,
): ColumnMapEntry | undefined {
  const key = columnMapKey(value);
  if (Object.hasOwn(map, key)) return map[key];
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  const ci = Object.keys(map).find((k) => k.toLowerCase() === lower);
  return ci === undefined ? undefined : map[ci];
}

/** The words of a map entry. */
export const columnMapLabel = (e: ColumnMapEntry): string =>
  typeof e === 'string' ? e : Array.isArray(e) ? e[1] : (e as { label: string }).label;

/**
 * A `tags` cell's chips: a list as-is, an object (Azure tags `{ env: 'prod' }`) as `env: prod`, a single value as one
 * chip. The table draws these and the export joins them with "; ".
 */
export function tagList(v: unknown): string[] {
  if (v == null || v === '') return [];
  if (Array.isArray(v))
    return v.map((x) => (x != null && typeof x === 'object' ? JSON.stringify(x) : String(x))).filter(Boolean);
  if (typeof v === 'object')
    return Object.entries(v).map(([k, val]) => (val == null || val === '' ? k : `${k}: ${String(val)}`));
  return [String(v)];
}

/** `status` and `enum` map entries have different shapes; say which one belongs where. */
function checkColumnMap(col: { kind?: string; map?: Record<string, unknown> }, ctx: z.RefinementCtx) {
  for (const [key, entry] of Object.entries(col.map ?? {})) {
    if (col.kind === 'status' && typeof entry === 'string')
      ctx.addIssue({
        code: 'custom',
        path: ['map', key],
        message: `A status column maps each value to [tone, label]. "${key}" has only a label: use kind: enum for plain labels.`,
      });
    if (col.kind === 'enum' && typeof entry !== 'string')
      ctx.addIssue({
        code: 'custom',
        path: ['map', key],
        message: `An enum column maps each value to its label (${key}: <label>). Tones belong to kind: status, for values that say whether something is fine.`,
      });
  }
}

export const TableColumn = z
  .looseObject({
    /** Dot path into the row, e.g. `signInActivity.lastSignInDateTime`. */
    field: z.string().min(1),
    label: z.string().min(1),
    kind: ColumnKind.optional(),
    /** Second line for `identity` columns (e.g. userPrincipalName). */
    secondary: z.string().optional(),
    /**
     * Raw value → what the cell shows. `status` columns: `[tone, label]` or `{ tone, label }`; `enum` columns: the
     * label (`AzureAd: Entra joined`). Keys are the value as text (`"true"`, `"30"`, `"null"` for a missing value);
     * text values also match case-insensitively.
     */
    map: z.record(z.string(), z.union([z.string(), StatusEntry])).optional(),
    sortable: z.boolean().optional(),
    /** Column filter; bind to a page param with `{ type, param }` to filter server-side, otherwise rows are filtered client-side. */
    filter: z
      .union([ColumnFilterType, z.strictObject({ type: ColumnFilterType, param: Identifier.optional() })])
      .optional(),
    /** Hidden by default (available in the column chooser and exports). */
    hidden: z.boolean().optional(),
    width: z.number().int().positive().optional(),
    align: z.enum(['start', 'center', 'end']).optional(),
    /** Cell link: page key + params (templated with `row`). */
    link: z
      .strictObject({ page: DefinitionId, params: z.record(z.string(), z.unknown()).optional() })
      .optional(),
    /** Text-like columns: up to two lines, then an ellipsis (messages, descriptions); the full text on hover. */
    wrap: z.boolean().optional(),
  })
  .superRefine(checkColumnMap);
export type TableColumn = z.infer<typeof TableColumn>;

/** Launch a playbook for one row (scope: `row`) or open an external deep link. */
export const RowAction = z
  .strictObject({
    playbook: DefinitionId.optional(),
    href: z.string().optional(),
    label: z.string().min(1).optional(),
    icon: IconName.optional(),
    /** Playbook inputs, templated with `row`. */
    inputs: z.record(z.string(), z.unknown()).optional(),
    /** Offer the action only when true (scope: `row`). */
    when: exprOr(z.boolean()).optional(),
  })
  .refine((a) => (a.playbook ? !a.href : !!a.href), {
    message: 'A row action needs exactly one of playbook or href',
  });
export type RowAction = z.infer<typeof RowAction>;

/**
 * Bulk actions run a playbook once per selected row (R9). `forEach.inputs` is templated per row (scope: `row`);
 * playbook inputs not mapped there are asked once in the bulk dialog and shared by every item.
 */
export const BulkAction = z.strictObject({
  playbook: DefinitionId,
  label: z.string().min(1),
  icon: IconName.optional(),
  forEach: z.strictObject({
    inputs: z.record(z.string(), z.unknown()),
    concurrency: z.number().int().min(1).max(10).default(5),
  }),
  maxItems: z.number().int().min(1).max(1000).default(100),
  /** Offer the action only when true (scope: `rows` = selection). */
  when: exprOr(z.boolean()).optional(),
});
export type BulkAction = z.infer<typeof BulkAction>;

/** Opens the entity page in the inspector drawer (`?inspect=…`). Params are templated with `row`. */
export const Inspect = z.strictObject({
  page: DefinitionId,
  params: z.record(z.string(), z.unknown()).optional(),
});
export type Inspect = z.infer<typeof Inspect>;

/** Fields every widget block understands; anything else is widget-specific config. */
export const WidgetBlockBase = z.looseObject({
  widget: z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'Expected a widget type like table or kpi'),
  /** Stable id (saved views, "pin to My dashboard" uses `pageKey#id`). */
  id: Identifier.optional(),
  title: z.string().optional(),
  /** Columns on the 12-column grid. */
  span: z.number().int().min(1).max(12).optional(),
  rows: z.number().int().min(1).max(12).optional(),
  /** Datasource path, e.g. `users.value` or `counts.members`. */
  data: z.string().optional(),
  when: exprOr(z.boolean()).optional(),
});

export const TableWidgetConfig = z.looseObject({
  widget: z.literal('table'),
  columns: z.array(TableColumn).min(1),
  rowKey: z.string().min(1).optional(),
  selection: z.enum(['none', 'single', 'multi']).optional(),
  rowActions: z.array(RowAction).optional(),
  bulkActions: z.array(BulkAction).optional(),
  inspect: Inspect.optional(),
  /** Free-text search over loaded rows when no server-side search param is bound. */
  search: z.boolean().optional(),
  pageSize: z.number().int().min(10).max(1000).optional(),
  emptyText: z.string().optional(),
});
export type TableWidgetConfig = z.infer<typeof TableWidgetConfig>;

const widgetSchemas = new Map<string, z.ZodType>([['table', TableWidgetConfig]]);

/** Lets @adminforge/widgets validate its own config types inside page definitions. */
export function registerWidgetSchema(type: string, schema: z.ZodType): void {
  widgetSchemas.set(type, schema);
}
export function widgetSchema(type: string): z.ZodType | undefined {
  return widgetSchemas.get(type);
}

export const WidgetBlock = WidgetBlockBase.superRefine((block, ctx) => {
  const schema = widgetSchemas.get(block.widget);
  if (!schema) return;
  const r = schema.safeParse(block);
  if (!r.success)
    for (const issue of r.error.issues)
      ctx.addIssue({ code: 'custom', message: issue.message, path: [...issue.path] });
});
export type WidgetBlock = z.infer<typeof WidgetBlockBase>;

/** Header actions (no row in scope). */
export const PageAction = RowAction;

/** Status expression helper type for KPI-like widgets: `${ value > 0 ? 'warn' : 'ok' }`. */
export const ToneOrExpr = exprOr(StatusTone);
