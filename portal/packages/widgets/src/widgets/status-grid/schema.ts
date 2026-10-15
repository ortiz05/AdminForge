import { z } from 'zod';
import { Template } from '@adminforge/schemas';
import { DataRef, FieldOrTemplate, StatusEntrySchema, StatusMapSchema, blockShape } from '../../lib/schema-common';

/** A grid of named things and their state (service health, probes) (docs/widgets.md › statusGrid). */
export const StatusGridConfig = z.looseObject({
  widget: z.literal('statusGrid'),
  ...blockShape,
  data: DataRef,
  /** Field with the tile's name. */
  label: z.string().min(1),
  /** Field with the raw state. */
  status: z.string().min(1),
  map: StatusMapSchema.optional(),
  default: StatusEntrySchema.optional(),
  /** Second line (field or template). */
  detail: FieldOrTemplate.optional(),
  href: Template.optional(),
  /** `severity` (default) puts the worst first; `none` keeps data order. */
  sort: z.enum(['severity', 'none']).optional(),
});
export type StatusGridConfig = z.infer<typeof StatusGridConfig>;
