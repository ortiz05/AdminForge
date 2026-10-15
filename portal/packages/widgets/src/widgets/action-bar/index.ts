import type { WidgetDefinition } from '../../types';
import { ActionBarConfig } from './schema';
import { ActionBarWidget } from './Widget';

export const actionBarWidget: WidgetDefinition<ActionBarConfig> = {
  type: 'actionBar',
  schema: ActionBarConfig,
  component: ActionBarWidget,
  span: 12,
  needsData: false,
};
