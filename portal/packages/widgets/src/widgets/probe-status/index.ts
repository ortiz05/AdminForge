import type { WidgetDefinition } from '../../types';
import { ProbeStatusConfig } from './schema';
import { ProbeStatusWidget } from './Widget';

export const probeStatusWidget: WidgetDefinition<ProbeStatusConfig> = {
  type: 'probeStatus',
  schema: ProbeStatusConfig,
  component: ProbeStatusWidget,
  span: 12,
  needsData: false,
};
