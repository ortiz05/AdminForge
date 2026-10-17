import { screen, within } from '@testing-library/react';
import { WIDGETS, type ProbeStatusConfig, type ProbeSummary } from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { ready, renderWidget, spyRuntime } from './helpers';

// probeStatus with `group:` shows every probe of one service (the probe's `group`) — a workload dashboard's own
// synthetic checks — worst first, and counts only those in its header pill.
const Probes = WIDGETS.probeStatus!.component;
const config = WIDGETS.probeStatus!.schema.parse({
  widget: 'probeStatus',
  title: 'Synthetic checks',
  group: 'exchange',
}) as ProbeStatusConfig;

const probe = (key: string, title: string, group: string | null, status: ProbeSummary['status']) =>
  ({ key, title, group, status, metric: 120, unit: 'ms', lastRunAt: null }) satisfies ProbeSummary;
const all: ProbeSummary[] = [
  probe('probes.exchange-autodiscover-service', 'Exchange Autodiscover', 'exchange', 'ok'),
  probe('probes.exchange-mail-flow', 'Mail flow', 'exchange', 'warn'),
  probe('probes.teams-channels', 'Teams channels', 'teams', 'crit'),
  probe('probes.loose', 'Ungrouped', null, 'crit'),
];

describe('probeStatus with a group', () => {
  it('lists only that service’s probes, worst first, and counts only them', async () => {
    const { runtime } = spyRuntime({ useProbes: () => ({ status: 'ready', probes: all }) });
    renderWidget(Probes, config, ready(undefined), runtime);
    const list = screen.getByRole('list', { name: 'Synthetic checks' });
    const rows = within(list).getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Mail flow'),
      expect.stringContaining('Exchange Autodiscover'),
    ]);
    expect(screen.queryByText('Teams channels')).toBeNull();
    expect(screen.getByText('1 degraded')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('says there is nothing yet when the service has no probes', () => {
    const { runtime } = spyRuntime({
      useProbes: () => ({ status: 'ready', probes: all.filter((p) => p.group !== 'exchange') }),
    });
    renderWidget(Probes, config, ready(undefined), runtime);
    expect(screen.getByText('No probe results yet')).toBeInTheDocument();
  });

  it('doesn’t say "All passing" before anything has run', () => {
    const fresh = all.map((p) => ({ ...p, status: 'unknown' as const }));
    const { runtime } = spyRuntime({ useProbes: () => ({ status: 'ready', probes: fresh }) });
    renderWidget(Probes, config, ready(undefined), runtime);
    expect(screen.getByText('No results yet')).toBeInTheDocument();
    expect(screen.queryByText('All passing')).toBeNull();
  });
});
