import type { WidgetDefinition } from '../../types';
import { KpiConfig } from './schema';
import { KpiWidget } from './Widget';

export const kpiWidget: WidgetDefinition<KpiConfig> = {
  type: 'kpi',
  schema: KpiConfig,
  component: KpiWidget,
  span: 3,
  needsData: true,
};
