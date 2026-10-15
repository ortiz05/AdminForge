import type { WidgetDefinition } from '../../types';
import { TableConfig } from './schema';
import { TableWidget } from './Widget';

export const tableWidget: WidgetDefinition<TableConfig> = {
  type: 'table',
  schema: TableConfig,
  component: TableWidget,
  span: 12,
  needsData: true,
};
