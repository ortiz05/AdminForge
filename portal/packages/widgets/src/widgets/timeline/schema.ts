import { z } from 'zod';
import { DataRef, FieldOrTemplate, FieldStatus, blockShape } from '../../lib/schema-common';

/** Ordered events (audit, sign-ins, run history) (docs/widgets.md › timeline). */
export const TimelineConfig = z.looseObject({
  widget: z.literal('timeline'),
  ...blockShape,
  data: DataRef,
  /** Timestamp field. */
  ts: z.string().min(1),
  /** Item title: a field or template. (Here `title` is per event, so the panel heading is `heading`.) */
  title: FieldOrTemplate,
  /** Panel heading. */
  heading: z.string().optional(),
  detail: FieldOrTemplate.optional(),
  status: FieldStatus.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type TimelineConfig = z.infer<typeof TimelineConfig>;
