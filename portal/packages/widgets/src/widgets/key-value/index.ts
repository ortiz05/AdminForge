import type { WidgetDefinition } from '../../types';
import { KeyValueConfig } from './schema';
import { KeyValueWidget } from './Widget';

export const keyValueWidget: WidgetDefinition<KeyValueConfig> = {
  type: 'keyValue',
  schema: KeyValueConfig,
  component: KeyValueWidget,
  span: 12,
  needsData: true,
};
