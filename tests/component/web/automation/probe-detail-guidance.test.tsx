import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import type { MockHandler } from '../../../support/web/mock-handler';
import { axeViolations } from '../../axe';
import { renderApp } from './render';

// A degraded probe's detail says what it found (the rows behind the result), what to do and where to act, and what
// the check is for — so engineers don't go looking. Rows were read with application permissions: a viewer who isn't
// an Operator sees why they're missing instead.
const NOW = Date.now();
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const PROBE = {
  key: 'probes.saml-certificates-expiring',
  title: 'SAML signing certificates expiring within 30 days',
  kind: 'graphCount',
  group: 'identity',
  summary:
    'Counts the enabled SAML enterprise applications whose newest signing certificate expires within 30 days.',
  remedy: 'Create a new certificate, upload it to the application, then make it active.',
  link: { label: 'Open SAML certificate expiry', href: '/p/identity.saml-certificate-expiry' },
  latest: { ts: at(1), metric: 1, status: 'warn', unit: 'items', message: '1 item counted; warn ≥ 1.' },
  series: [
    { ts: at(7), metric: 0, status: 'ok' },
    { ts: at(1), metric: 1, status: 'warn' },
  ],
  thresholds: { warn: 1, unit: 'items', worse: 'higher' },
};
const RESULTS = (newest: Record<string, unknown>) => ({
  items: [
    { ts: at(1), metric: 1, status: 'warn', unit: 'items', message: '1 item counted; warn ≥ 1.', ...newest },
    {
      ts: at(7),
      metric: 0,
      status: 'ok',
      unit: 'items',
      message: '0 items counted; warn ≥ 1.',
      details: null,
    },
  ],
});
const handlers = (newest: Record<string, unknown>): MockHandler[] => [
  ({ method, path }) => {
    if (method === 'GET' && path === '/api/probes') return { body: { items: [PROBE] } };
    if (method === 'GET' && path === `/api/probes/${PROBE.key}/results`) return { body: RESULTS(newest) };
    return undefined;
  },
];

async function openDetail(newest: Record<string, unknown>) {
  renderApp({ path: '/monitoring', handlers: handlers(newest) });
  const main = await screen.findByRole('main');
  await userEvent.click(
    await within(main).findByRole('button', { name: /SAML signing certificates expiring/ }),
  );
  return screen.findByRole('dialog', { name: PROBE.title });
}

describe('probe detail guidance', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });

  it('shows what it found, what to do with a link to act, and what the check is for', async () => {
    const drawer = await openDetail({
      details: {
        rows: [{ displayName: 'Example Org HR', expires: '2026-11-01T00:00:00Z', daysRemaining: 12 }],
        totalRows: 1,
      },
    });
    const found = await within(drawer).findByRole('region', { name: 'What it found' });
    const table = within(found).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Display name' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Days remaining' })).toBeInTheDocument();
    expect(within(table).getByText('Example Org HR')).toBeInTheDocument();
    expect(within(table).getByText('12')).toBeInTheDocument();

    const next = within(drawer).getByRole('region', { name: 'What to do' });
    expect(next).toHaveTextContent(PROBE.remedy);
    expect(within(next).getByRole('link', { name: 'Open SAML certificate expiry' })).toHaveAttribute(
      'href',
      '/p/identity.saml-certificate-expiry',
    );
    expect(within(drawer).getByRole('region', { name: 'What this checks' })).toHaveTextContent(PROBE.summary);
    expect(await axeViolations()).toEqual([]);
  });

  it('says the rows are for Operators when the viewer may not see them', async () => {
    const drawer = await openDetail({ details: null, detailsHidden: true });
    const found = await within(drawer).findByRole('region', { name: 'What it found' });
    expect(found).toHaveTextContent('shown to Operators');
    expect(within(found).queryByRole('table')).not.toBeInTheDocument();
    // What to do and where to act stay: the linked page reads with the viewer's own permissions.
    expect(within(drawer).getByRole('link', { name: 'Open SAML certificate expiry' })).toBeInTheDocument();
  });

  it('caps a long result and says how many more there are', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ displayName: `App ${i + 1}`, daysRemaining: i }));
    const drawer = await openDetail({ details: { rows, totalRows: 120, truncated: true } });
    const found = await within(drawer).findByRole('region', { name: 'What it found' });
    expect(within(found).getAllByRole('row')).toHaveLength(26);
    expect(found).toHaveTextContent('95 more not shown here');
  });
});
