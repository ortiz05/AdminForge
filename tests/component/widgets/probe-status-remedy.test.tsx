import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WIDGETS, type ProbeStatusConfig, type ProbeSummary } from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { ready, renderWidget, spyRuntime } from './helpers';

// A dashboard's probeStatus row, opened, says what to do when the check warns or fails (the probe's remedy) and links
// to its full result on Synthetic monitoring (what it found, its history).
const Probes = WIDGETS.probeStatus!.component;
const config = WIDGETS.probeStatus!.schema.parse({
  widget: 'probeStatus',
  title: 'Synthetic checks',
  group: 'exchange',
}) as ProbeStatusConfig;
const base = {
  group: 'exchange',
  metric: 95,
  unit: 's',
  lastRunAt: null,
  remedy: 'Run a message trace for the test message in the Exchange admin center.',
  href: '/monitoring?probe=probes.exchange-mail-flow',
};
const probes: ProbeSummary[] = [
  {
    ...base,
    key: 'probes.exchange-mail-flow',
    title: 'Mail flow',
    status: 'crit',
    message: 'Not delivered in 90 s.',
  },
  {
    ...base,
    key: 'probes.exchange-outlook-web',
    title: 'Outlook on the web',
    status: 'ok',
    href: '/monitoring?probe=probes.exchange-outlook-web',
  },
];

describe('probeStatus remedy', () => {
  it('shows what to do on a failing row and links to its full result', async () => {
    const { runtime } = spyRuntime({ useProbes: () => ({ status: 'ready', probes }) });
    renderWidget(Probes, config, ready(undefined), runtime);
    const list = screen.getByRole('list', { name: 'Synthetic checks' });
    const row = within(list).getByRole('button', { name: /Mail flow/ });
    await userEvent.click(row);
    const detail = document.getElementById(row.getAttribute('aria-controls')!)!;
    expect(within(detail).getByText(/Run a message trace for the test message/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'What it found and its history' })).toHaveAttribute(
      'href',
      '/monitoring?probe=probes.exchange-mail-flow',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('keeps the remedy off a passing row', async () => {
    const { runtime } = spyRuntime({ useProbes: () => ({ status: 'ready', probes }) });
    renderWidget(Probes, config, ready(undefined), runtime);
    const row = screen.getByRole('button', { name: /Outlook on the web/ });
    await userEvent.click(row);
    const detail = document.getElementById(row.getAttribute('aria-controls')!)!;
    expect(detail).toBeVisible();
    expect(within(detail).queryByText(/What to do/)).toBeNull();
    expect(within(detail).getByRole('link', { name: 'What it found and its history' })).toHaveAttribute(
      'href',
      '/monitoring?probe=probes.exchange-outlook-web',
    );
  });
});
