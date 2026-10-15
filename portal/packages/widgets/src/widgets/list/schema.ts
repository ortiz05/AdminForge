import { z } from 'zod';
import { Template } from '@adminforge/schemas';
import { DataRef, FieldOrTemplate, FieldStatus, ValueFormat, blockShape } from '../../lib/schema-common';

/** A short ranked list (incidents, recent changes) with status and drill-down (docs/widgets.md › list). */
export const ListConfig = z.looseObject({
  widget: z.literal('list'),
  ...blockShape,
  data: DataRef,
  /** Field or template for the main line. */
  primary: FieldOrTemplate,
  secondary: FieldOrTemplate.optional(),
  secondaryFormat: ValueFormat.optional(),
  status: FieldStatus.optional(),
  /** Row link (template; scope `row`). */
  href: Template.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ListConfig = z.infer<typeof ListConfig>;
