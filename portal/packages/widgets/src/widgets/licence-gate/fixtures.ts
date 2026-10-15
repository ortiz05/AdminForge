import type { LicenceGateConfig } from './schema';

/** Story data for the licenceGate widget. */
export const licenceGateFixtures = {
  intune: {
    config: {
      widget: 'licenceGate',
      feature: 'intune',
      body: 'managed devices and their compliance',
    } satisfies LicenceGateConfig,
    feature: { available: false, label: 'Microsoft Intune', sku: 'Microsoft Intune Plan 1 (INTUNE_A)' },
  },
};
