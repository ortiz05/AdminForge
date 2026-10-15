import { z } from 'zod';
import { DefinitionId, Expr, IconName, Identifier, StatusTone, exprOr } from '@adminforge/schemas';
import { VALUE_FORMATS } from './format';

/** `<datasource>` or `<datasource>.<path>`. */
export const DataRef = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*([.[][^\s]*)?$/,
    'Expected a datasource reference like users.value or counts.members',
  );

export const ValueFormat = z.enum(VALUE_FORMATS);

/** `[tone, label]` or `{ tone, label }`. */
export const StatusEntrySchema = z.union([
  z.tuple([StatusTone, z.string().min(1)]),
  z.strictObject({ tone: StatusTone, label: z.string().min(1) }),
]);
/** Raw value (as text: "true", "false", "high", "null") → status. */
export const StatusMapSchema = z.record(z.string(), StatusEntrySchema);

/** `{ field, map, default? }` — a row field turned into status + label. */
export const FieldStatus = z.strictObject({
  field: z.string().min(1),
  map: StatusMapSchema.optional(),
  default: StatusEntrySchema.optional(),
});

/** A field path, or a template with `${ … }` (scope: `row`, `params`, datasources). */
export const FieldOrTemplate = z.string().min(1);

/** Opens a playbook (inputs templated) or a link. */
export const ActionSpec = z
  .strictObject({
    label: z.string().min(1),
    playbook: DefinitionId.optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    href: z.string().min(1).optional(),
    /** Opens in a new tab (Entra/Azure portals). Inferred for http(s) links. */
    external: z.boolean().optional(),
    icon: IconName.optional(),
    when: exprOr(z.boolean()).optional(),
  })
  .refine((a) => Boolean(a.playbook) !== Boolean(a.href), {
    message: 'An action needs exactly one of playbook or href',
  });
export type ActionSpec = z.infer<typeof ActionSpec>;

/** `{ title, body?, action? }` shown when the data is empty (§6.9: invite action). */
export const EmptySpec = z.strictObject({
  title: z.string().min(1),
  body: z.string().optional(),
  action: ActionSpec.optional(),
});
export type EmptySpec = z.infer<typeof EmptySpec>;

/** Keys every widget understands (docs/widgets.md "Common keys"). Widget schemas spread this. */
export const blockShape = {
  id: Identifier.optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  span: z.number().int().min(1).max(12).optional(),
  rows: z.number().int().min(1).max(12).optional(),
  when: exprOr(z.boolean()).optional(),
  empty: EmptySpec.optional(),
};

export { Expr };
