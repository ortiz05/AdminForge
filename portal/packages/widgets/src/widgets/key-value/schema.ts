import { z } from 'zod';
import { Template } from '@adminforge/schemas';
import { DataRef, StatusMapSchema, ValueFormat, blockShape } from '../../lib/schema-common';

export const KEY_VALUE_KINDS = [
  'text',
  'id',
  'status',
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

export const KeyValueField = z.strictObject({
  field: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(KEY_VALUE_KINDS).optional(),
  /** `status` fields: raw value → [tone, label]. */
  map: StatusMapSchema.optional(),
  format: ValueFormat.optional(),
  /** `link` fields: target (template; scope `value`, `row` = the object). Defaults to the value when it is a URL. */
  href: Template.optional(),
});

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
