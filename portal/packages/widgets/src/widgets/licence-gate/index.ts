import type { WidgetDefinition } from '../../types';
import { LicenceGateConfig } from './schema';
import { LicenceGateWidget } from './Widget';

export const licenceGateWidget: WidgetDefinition<LicenceGateConfig> = {
  type: 'licenceGate',
  schema: LicenceGateConfig,
  component: LicenceGateWidget,
  span: 12,
  needsData: false,
};
