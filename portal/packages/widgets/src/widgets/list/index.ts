import type { WidgetDefinition } from '../../types';
import { ListConfig } from './schema';
import { ListWidget } from './Widget';

export const listWidget: WidgetDefinition<ListConfig> = {
  type: 'list',
  schema: ListConfig,
  component: ListWidget,
  span: 6,
  needsData: true,
};
