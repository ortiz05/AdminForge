import { z } from 'zod';
import { StatusTone, Template, exprOr } from '@adminforge/schemas';
import { DataRef, ValueFormat, blockShape } from '../../lib/schema-common';

/** One number with optional status, delta, trend and drill-down (docs/widgets.md › kpi). */
export const KpiConfig = z.looseObject({
  widget: z.literal('kpi'),
  ...blockShape,
  /** A number, or an object whose `value` field (or `field`) is the number. */
  data: DataRef,
  label: z.string().min(1),
  /** Field inside an object result (default `value`). */
  field: z.string().min(1).optional(),
  format: ValueFormat.optional(),
  unit: z.string().optional(),
  /** Tone or `${ … }` returning one (scope: `value`, `params`, datasources). */
  status: exprOr(StatusTone).optional(),
  /** Words next to the status icon (default by tone: Healthy, Needs review, Action needed…). */
  statusLabel: Template.optional(),
  /** Datasource path of a signed change, e.g. counts.membersDelta. */
  delta: DataRef.optional(),
  deltaFormat: ValueFormat.optional(),
  /** Which direction is good news (default up). */
  deltaGood: z.enum(['up', 'down']).optional(),
  /** "vs last week". */
  deltaPeriod: z.string().optional(),
  /** Datasource path of a number[] drawn as a sparkline. */
  trend: DataRef.optional(),
  /** Context under the value (template). */
  hint: Template.optional(),
  /** Drill-down link (template; scope includes `value`). */
  href: Template.optional(),
});
export type KpiConfig = z.infer<typeof KpiConfig>;
