import type { z } from 'zod';
import { registerWidgetSchema } from '@adminforge/schemas';
import { ActionBarConfig } from './widgets/action-bar/schema';
import { ChartConfig } from './widgets/chart/schema';
import { KeyValueConfig } from './widgets/key-value/schema';
import { KpiConfig } from './widgets/kpi/schema';
import { LicenceGateConfig } from './widgets/licence-gate/schema';
import { ListConfig } from './widgets/list/schema';
import { MarkdownConfig } from './widgets/markdown/schema';
import { ProbeStatusConfig } from './widgets/probe-status/schema';
import { StatusGridConfig } from './widgets/status-grid/schema';
import { TableConfig } from './widgets/table/schema';
import { TimelineConfig } from './widgets/timeline/schema';

/**
 * Config schemas for every widget in docs/widgets.md, keyed by `widget:` type. No React here, so the CLI, the API
 * and content tests can validate pages without loading components.
 */
export const WIDGET_SCHEMAS = {
  kpi: KpiConfig,
  table: TableConfig,
  chart: ChartConfig,
  list: ListConfig,
  keyValue: KeyValueConfig,
  statusGrid: StatusGridConfig,
  timeline: TimelineConfig,
  markdown: MarkdownConfig,
  actionBar: ActionBarConfig,
  licenceGate: LicenceGateConfig,
  probeStatus: ProbeStatusConfig,
} as const satisfies Record<string, z.ZodType>;

export type WidgetType = keyof typeof WIDGET_SCHEMAS;
export const WIDGET_TYPES = Object.keys(WIDGET_SCHEMAS) as WidgetType[];

let registered = false;

/** Plugs every widget schema into @adminforge/schemas, so page validation checks widget config too. Idempotent. */
export function registerWidgetSchemas(): void {
  if (registered) return;
  registered = true;
  for (const [type, schema] of Object.entries(WIDGET_SCHEMAS)) registerWidgetSchema(type, schema);
}

registerWidgetSchemas();

export {
  ActionBarConfig,
  ChartConfig,
  KeyValueConfig,
  KpiConfig,
  LicenceGateConfig,
  ListConfig,
  MarkdownConfig,
  ProbeStatusConfig,
  StatusGridConfig,
  TableConfig,
  TimelineConfig,
};
