import { z } from 'zod';
import { Template } from '@adminforge/schemas';
import { DataRef, StatusEntrySchema, ValueFormat, blockShape } from '../../lib/schema-common';

export const KEY_VALUE_KINDS = [
  'text',
  'id',
  'status',
  'enum',
  'datetime',
  'date',
  'relativeTime',
  'boolean',
  'number',
  'bytes',
  'percent',
  'tags',
  'link',
  'code',
] as const;

/** `status` and `enum` map entries have different shapes (as in table columns); say which one belongs where. */
function checkFieldMap(f: { kind?: string; map?: Record<string, unknown> }, ctx: z.RefinementCtx) {
  for (const [key, entry] of Object.entries(f.map ?? {})) {
    if (f.kind === 'enum' && typeof entry !== 'string')
      ctx.addIssue({
        code: 'custom',
        path: ['map', key],
        message: `An enum field maps each value to its label (${key}: <label>). Tones belong to kind: status, for values that say whether something is fine.`,
      });
    if (f.kind !== 'enum' && typeof entry === 'string')
      ctx.addIssue({
        code: 'custom',
        path: ['map', key],
        message: `A status field maps each value to [tone, label]. "${key}" has only a label: use kind: enum for plain labels.`,
      });
  }
}

export const KeyValueField = z
  .strictObject({
    field: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(KEY_VALUE_KINDS).optional(),
    /**
     * Raw value → what the field shows. `status`: `[tone, label]` or `{ tone, label }`, for a value that is fine or
     * not; `enum`: the label of a category (`Member: Member`, `"null": Cloud`). Keys are the value as text; text
     * values also match case-insensitively.
     */
    map: z.record(z.string(), z.union([z.string().min(1), StatusEntrySchema])).optional(),
    format: ValueFormat.optional(),
    /**
     * `link` fields: target (template; scope `value`, `row` = the object). Without it the value itself is the target —
     * taken literally, never evaluated — when it is an external URL (http(s), mailto).
     */
    href: Template.optional(),
  })
  .superRefine(checkFieldMap);

/** Properties of one object (an entity's overview) as label/value pairs (docs/widgets.md › keyValue). */
export const KeyValueConfig = z.looseObject({
  widget: z.literal('keyValue'),
  ...blockShape,
  data: DataRef,
  fields: z.array(KeyValueField).min(1),
  /** Label/value columns on wide screens (default 2; the inspector always uses 1). */
  columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});
export type KeyValueConfig = z.infer<typeof KeyValueConfig>;
export type KeyValueFieldConfig = z.infer<typeof KeyValueField>;
