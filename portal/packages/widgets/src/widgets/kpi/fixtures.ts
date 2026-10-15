import type { KpiConfig } from './schema';

/** Story data for the kpi widget. */
export const kpiFixtures = {
  members: {
    config: { widget: 'kpi', data: 'counts.members', label: 'Members' } satisfies KpiConfig,
    value: 12408,
  },
  disabled: {
    config: {
      widget: 'kpi',
      data: 'counts.disabled',
      label: 'Disabled',
      status: "${ value > 0 ? 'warn' : 'ok' }",
    } satisfies KpiConfig,
    value: 23,
  },
  noMfa: {
    config: {
      widget: 'kpi',
      data: 'mfa.ratio',
      label: 'Without MFA',
      format: 'percent',
      delta: 'mfa.delta',
      deltaGood: 'down',
      deltaFormat: 'percent',
      deltaPeriod: 'vs last week',
      href: '/p/identity.users?mfa=none',
    } satisfies KpiConfig,
    value: 0.042,
    delta: -0.006,
  },
};
