import type { WidgetDefinition } from '../../types';
import { StatusGridConfig } from './schema';
import { StatusGridWidget } from './Widget';

export const statusGridWidget: WidgetDefinition<StatusGridConfig> = {
  type: 'statusGrid',
  schema: StatusGridConfig,
  component: StatusGridWidget,
  span: 12,
  needsData: true,
};
