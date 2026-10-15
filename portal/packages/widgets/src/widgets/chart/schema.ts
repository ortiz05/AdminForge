import { z } from 'zod';
import { DataRef, ValueFormat, blockShape } from '../../lib/schema-common';

export const CHART_TYPES = ['line', 'area', 'bar', 'stackedBar', 'donut', 'heatGrid'] as const;

/**
 * One y-axis, at most six series (more fold into "Other"), donut ≤ 6 slices, and a Table toggle on every chart
 * (docs/widgets.md › chart). donut: `x` = slice label, `y` = value. heatGrid: `x` = column, `series` = row, `y` = value.
 */
export const ChartConfig = z
  .looseObject({
    widget: z.literal('chart'),
    ...blockShape,
    type: z.enum(CHART_TYPES),
    data: DataRef,
    x: z.string().min(1),
    y: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(12)]),
    /** Split rows into series by this field (instead of a list of y fields). */
    series: z.string().min(1).optional(),
    format: ValueFormat.optional(),
    stack: z.boolean().optional(),
    /** Display names for y fields or series values. */
    labels: z.record(z.string(), z.string()).optional(),
    /** Header of the category column in the table view. */
    xLabel: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.type === 'heatGrid' && !c.series)
      ctx.addIssue({ code: 'custom', path: ['series'], message: 'heatGrid needs `series` (the row field).' });
    if ((c.type === 'donut' || c.type === 'heatGrid') && Array.isArray(c.y) && c.y.length > 1)
      ctx.addIssue({ code: 'custom', path: ['y'], message: `${c.type} takes one y field.` });
  });
export type ChartConfig = z.infer<typeof ChartConfig>;
