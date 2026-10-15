import type { WidgetDefinition } from '../../types';
import { TimelineConfig } from './schema';
import { TimelineWidget } from './Widget';

export const timelineWidget: WidgetDefinition<TimelineConfig> = {
  type: 'timeline',
  schema: TimelineConfig,
  component: TimelineWidget,
  span: 6,
  needsData: true,
};
