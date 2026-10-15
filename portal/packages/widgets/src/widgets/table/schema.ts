import { z } from 'zod';
import { TableWidgetConfig } from '@adminforge/schemas';
import { DataRef, blockShape } from '../../lib/schema-common';

/**
 * The admin list (R9). Columns, row/bulk actions, inspect and selection come from @adminforge/schemas (pages,
 * saved views and exports depend on them); this adds the display keys.
 */
export const TableConfig = TableWidgetConfig.extend({
  ...blockShape,
  data: DataRef,
  /** Initial sort when the URL has none. */
  sort: z.strictObject({ field: z.string().min(1), desc: z.boolean().optional() }).optional(),
  /** Grid height in px before it scrolls (default 560; 360 inside the inspector). */
  maxHeight: z.number().int().min(160).max(2000).optional(),
});
export type TableConfig = z.infer<typeof TableConfig>;
export type TableColumnConfig = TableConfig['columns'][number];
