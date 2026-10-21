import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import type { MockHandler } from '../../../support/web/mock-handler';
import { axeViolations } from '../../axe';
import { renderApp } from './render';

// D-17: the probe drawer showed "What to do" while the probe was healthy, and drew a history chart from a single
// point (one 00:00 tick). The remedy is for degraded and failing results only — a healthy or not-yet-run probe keeps
// the link to where its items are; fewer than two results is an empty state, not a chart. D-15: tile messages wrap
// to two lines instead of one, and the "checked … ago" time is never cut.

const NOW = Date.now();
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const LONG =
  'Sign-in failures at 12.4 % over the last hour, above the 10 % critical threshold; most are error 50126 from one range.';

const base = {
  kind: 'graphCount',
  group: 'identity',
  summary:
    'Counts the enabled SAML enterprise applications whose signing certificate expires within 30 days.',
  remedy: 'Create a new certificate, upload it to the application, then make it active.',
  link: { label: 'Open SAML certificate expiry', href: '/p/identity.saml-certificate-expiry' },
  thresholds: { warn: 1, unit: 'items', worse: 'higher' },
};
const point = (h: number, status: string, metric: number | null) => ({
  ts: at(h),
  status,
  metric,
  unit: 'items',
  message: null,
  details: null,
});

const PROBES = {
  // Healthy, with a single result in the last 24 hours.
  healthy: {
    ...base,
    key: 'probes.saml-healthy',
    title: 'SAML certificates (healthy)',
    latest: { ts: at(1), metric: 0, status: 'ok', unit: 'items', message: '0 items counted; warn ≥ 1.' },
    series: [{ ts: at(1), metric: 0, status: 'ok' }],
  },
  // Never run.
  unknown: {
    ...base,
    key: 'probes.saml-unknown',
    title: 'SAML certificates (not run)',
    latest: null,
    series: [],
  },
  // Failing, with a history to chart and a long message.
  failing: {
    ...base,
    key: 'probes.saml-failing',
    title: 'SAML certificates (failing)',
    latest: { ts: at(1), metric: 4, status: 'crit', unit: 'items', message: LONG },
    series: [
      { ts: at(7), metric: 0, status: 'ok' },
      { ts: at(4), metric: 2, status: 'warn' },
      { ts: at(1), metric: 4, status: 'crit' },
    ],
  },
};
const RESULTS: Record<string, unknown[]> = {
  'probes.saml-healthy': [point(1, 'ok', 0)],
  'probes.saml-unknown': [],
  'probes.saml-failing': [point(1, 'crit', 4), point(4, 'warn', 2), point(7, 'ok', 0)],
};
const handlers: MockHandler[] = [
  ({ method, path }) => {
    if (method === 'GET' && path === '/api/probes') return { body: { items: Object.values(PROBES) } };
    const m = /^\/api\/probes\/([^/]+)\/results$/.exec(path);
    if (method === 'GET' && m) return { body: { items: RESULTS[decodeURIComponent(m[1]!)] ?? [] } };
    return undefined;
  },
];

async function openDetail(title: string) {
  renderApp({ path: '/monitoring', handlers });
  const main = await screen.findByRole('main');
  const name = new RegExp(`^${title.replace(/[()]/g, '\\$&')}`);
  await userEvent.click(await within(main).findByRole('button', { name }));
  return screen.findByRole('dialog', { name: title });
}

describe('probe detail while healthy, and with little history', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a healthy probe keeps the link to its items but not the remedy', async () => {
    const drawer = await openDetail(PROBES.healthy.title);
    expect(within(drawer).queryByRole('region', { name: 'What to do' })).toBeNull();
    expect(within(drawer).queryByText(base.remedy)).toBeNull();
    const checks = within(drawer).getByRole('region', { name: 'What this checks' });
    expect(checks).toHaveTextContent(base.summary);
    expect(within(checks).getByRole('link', { name: base.link.label })).toHaveAttribute(
      'href',
      base.link.href,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('one result is an empty state that says when the chart starts, not a one-point chart', async () => {
    const drawer = await openDetail(PROBES.healthy.title);
    expect(await within(drawer).findByText('Not enough results to chart yet')).toBeInTheDocument();
    expect(within(drawer).getByText(/two measured results/)).toBeInTheDocument();
    expect(within(drawer).queryByRole('figure')).toBeNull();
  });

  it('a probe that has not run has no remedy and no chart', async () => {
    const drawer = await openDetail(PROBES.unknown.title);
    expect(within(drawer).queryByText(base.remedy)).toBeNull();
    expect(within(drawer).getByRole('link', { name: base.link.label })).toBeInTheDocument();
    expect(await within(drawer).findByText('No results in the last 24 hours')).toBeInTheDocument();
    expect(within(drawer).queryByRole('figure')).toBeNull();
  });

  it('a failing probe says what to do, with the link, and charts its history', async () => {
    const drawer = await openDetail(PROBES.failing.title);
    const next = within(drawer).getByRole('region', { name: 'What to do' });
    expect(next).toHaveTextContent(base.remedy);
    expect(within(next).getByRole('link', { name: base.link.label })).toBeInTheDocument();
    // The link is offered once.
    expect(within(drawer).getAllByRole('link', { name: base.link.label })).toHaveLength(1);
    expect(await within(drawer).findByRole('figure', { name: /last 24 hours/ })).toBeInTheDocument();
  });
});

describe('probe tiles never cut what matters', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a failing message wraps to two lines (all of it on hover), and the time is never truncated', async () => {
    renderApp({ path: '/monitoring', handlers });
    const main = await screen.findByRole('main');
    const tile = await within(main).findByRole('button', { name: /^SAML certificates \(failing\)/ });
    const message = within(tile).getByText(LONG);
    expect(message).toHaveClass('line-clamp-2');
    expect(message).not.toHaveClass('truncate');
    expect(message).toHaveAttribute('title', LONG);
    const checked = within(tile).getByText(/^checked .+ ago$/);
    expect(checked).toHaveClass('whitespace-nowrap');
    expect(checked.closest('.truncate')).toBeNull();
  });
});
