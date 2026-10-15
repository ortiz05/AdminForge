import type { WidgetDefinition } from '../../types';
import { MarkdownConfig } from './schema';
import { MarkdownWidget } from './Widget';

export const markdownWidget: WidgetDefinition<MarkdownConfig> = {
  type: 'markdown',
  schema: MarkdownConfig,
  component: MarkdownWidget,
  span: 12,
  needsData: false,
};
