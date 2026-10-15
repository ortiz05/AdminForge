import type { WidgetDefinition } from '../../types';
import { ChartConfig } from './schema';
import { ChartWidget } from './Widget';

export const chartWidget: WidgetDefinition<ChartConfig> = {
  type: 'chart',
  schema: ChartConfig,
  component: ChartWidget,
  span: 6,
  needsData: true,
};
