import type { StatusGridConfig } from './schema';

/** Story data for the statusGrid widget (Microsoft 365 service health). */
export const statusGridFixtures = {
  health: {
    config: {
      widget: 'statusGrid',
      title: 'Service health',
      data: 'health.value',
      label: 'service',
      status: 'status',
      map: {
        serviceOperational: ['ok', 'Healthy'],
        serviceDegradation: ['warn', 'Degraded'],
        serviceInterruption: ['crit', 'Interrupted'],
      },
      default: ['info', 'Advisory'],
    } satisfies StatusGridConfig,
    rows: [
      { service: 'Exchange Online', status: 'serviceDegradation' },
      { service: 'Microsoft Teams', status: 'serviceOperational' },
      { service: 'SharePoint Online', status: 'serviceOperational' },
      { service: 'Microsoft Entra', status: 'serviceOperational' },
      { service: 'Microsoft Intune', status: 'extendedRecovery' },
      { service: 'OneDrive for Business', status: 'serviceInterruption' },
    ],
  },
};
