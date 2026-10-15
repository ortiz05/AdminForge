import { HOUR, MIN, ago } from '../../lib/fixtures';
import type { ProbeSummary } from '../../types';
import type { ProbeStatusConfig } from './schema';

const history = (base: number, n = 12) =>
  Array.from({ length: n }, (_, i) => ({ ts: ago((n - i) * HOUR), status: 'ok' as const, metric: base + ((i * 37) % 90) }));

/** Story data for the probeStatus widget. */
export const probeStatusFixtures = {
  reachability: {
    config: {
      widget: 'probeStatus',
      title: 'Reachability',
      probes: ['probes.graph-reachability', 'probes.arm-reachability', 'probes.token-exchange'],
    } satisfies ProbeStatusConfig,
    probes: [
      { key: 'probes.graph-reachability', title: 'Microsoft Graph reachability', status: 'ok', metric: 182, unit: 'ms', lastRunAt: ago(12 * MIN), durationMs: 190, history: history(150) },
      { key: 'probes.arm-reachability', title: 'Azure Resource Manager reachability', status: 'warn', metric: 1840, unit: 'ms', message: 'Latency 1.8 s is above the 1.5 s warning threshold.', lastRunAt: ago(12 * MIN), durationMs: 1850, history: history(900) },
      { key: 'probes.token-exchange', title: 'Token acquisition · Exchange Online', status: 'error', metric: null, message: 'AADSTS7000215: Invalid client secret provided. Rotate the automation identity credential.', lastRunAt: ago(12 * MIN), durationMs: 420, history: [] },
    ] satisfies ProbeSummary[],
  },
};
