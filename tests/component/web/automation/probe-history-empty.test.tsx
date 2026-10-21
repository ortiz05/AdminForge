import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import type { MockHandler } from '../../../support/web/mock-handler';
import { renderApp } from './render';

// D-17 follow-up: when the probe drawer has no history chart, it says the real reason. A failed run (an error, a
// timeout) records no measurement, so a latency probe that failed all day has results but nothing to draw — that is
// not a pass-or-fail check. Only a probe without thresholds is pass or fail.

const NOW = Date.now();
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

type Point = { ts: string; status: string; metric: number | null };
const probe = (key: string, title: string, thresholds: Record<string, unknown>, series: Point[]) => ({
  key,
  title,
  kind: 'http',
  group: 'exchange',
  summary: null,
  remedy: 'Check the service health, then run the probe again.',
  link: null,
  latest: series.length ? { ...series[series.length - 1]!, unit: 'ms', message: 'Timed out.' } : null,
  series,
  thresholds,
});
const LATENCY = { warn: 1500, crit: 5000, unit: 'ms', worse: 'higher' };
const PASS_FAIL = { warn: null, crit: null, unit: null, worse: 'higher' };
const PROBES = [
  probe('probes.owa-failing', 'Outlook on the web (failing)', LATENCY, [
    { ts: at(6), status: 'crit', metric: null },
    { ts: at(1), status: 'crit', metric: null },
  ]),
  probe('probes.dns-pass-fail', 'MX record (pass or fail)', PASS_FAIL, [
    { ts: at(6), status: 'ok', metric: null },
    { ts: at(1), status: 'ok', metric: null },
  ]),
  probe('probes.owa-one', 'Outlook on the web (one result)', LATENCY, [
    { ts: at(1), status: 'ok', metric: 210 },
  ]),
  probe('probes.owa-two-one-measured', 'Outlook on the web (two results, one measured)', LATENCY, [
    { ts: at(6), status: 'crit', metric: null },
    { ts: at(1), status: 'ok', metric: 210 },
  ]),
  probe('probes.owa-never', 'Outlook on the web (never run)', LATENCY, []),
];
const handlers: MockHandler[] = [
  ({ method, path }) => {
    if (method === 'GET' && path === '/api/probes') return { body: { items: PROBES } };
    const m = /^\/api\/probes\/([^/]+)\/results$/.exec(path);
    if (method === 'GET' && m) {
      const p = PROBES.find((x) => x.key === decodeURIComponent(m[1]!))!;
      return { body: { items: [...p.series].reverse().map((x) => ({ ...x, unit: 'ms', message: null })) } };
    }
    return undefined;
  },
];

async function history(title: string) {
  renderApp({ path: '/monitoring', handlers });
  const main = await screen.findByRole('main');
  const name = new RegExp(`^${title.replace(/[()]/g, '\\$&')}`);
  await userEvent.click(await within(main).findByRole('button', { name }));
  const drawer = await screen.findByRole('dialog', { name: title });
  return within(drawer).findByRole('region', { name: 'Last 24 hours' });
}

describe('probe history without a chart says why', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a measured probe whose results all failed: no measurements, see Recent problems', async () => {
    const h = await history('Outlook on the web (failing)');
    expect(await within(h).findByText('No measurements in the last 24 hours')).toBeInTheDocument();
    expect(h).toHaveTextContent(/Recent problems/);
    expect(h).not.toHaveTextContent(/passes or fails/);
  });

  it('a pass-or-fail check (no thresholds) has nothing to chart', async () => {
    const h = await history('MX record (pass or fail)');
    expect(await within(h).findByText('Nothing to chart')).toBeInTheDocument();
    expect(h).toHaveTextContent(/passes or fails/);
  });

  it.each(['Outlook on the web (one result)', 'Outlook on the web (two results, one measured)'])(
    'one measured result so far — %s: the chart starts with the second',
    async (title) => {
      const h = await history(title);
      expect(await within(h).findByText('Not enough results to chart yet')).toBeInTheDocument();
      expect(h).toHaveTextContent(/two measured results/);
    },
  );

  it('never run: results appear after the first run', async () => {
    const h = await history('Outlook on the web (never run)');
    expect(await within(h).findByText('No results in the last 24 hours')).toBeInTheDocument();
    expect(h).toHaveTextContent(/after the first run/);
    expect(within(h).queryByRole('figure')).toBeNull();
  });
});
