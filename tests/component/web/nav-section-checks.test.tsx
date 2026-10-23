import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PROBES_KEY } from '@adminforge/web/src/app/section-checks';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { probesQuery } from '@adminforge/web/src/ops/schedules';
import { me } from '../../support/web/fixtures/session';
import type { MockHandler } from '../../support/web/mock-handler';
import { axeViolations } from '../axe';
import { renderApp } from './automation/render';

// D-14: section rows are full-size (14 px, fg-2) with the hidden-page count, and the eight "Service checks" items are
// folded into a status mark at the end of each section's row, linking to Synthetic monitoring for that section's own
// probes (`/monitoring?group=<key>`). A section key is also a probe group, so the rail reads GET /api/probes as is.

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const probe = (key: string, group: string | null, status: string | null) => ({
  key,
  title: key,
  kind: 'http',
  group,
  latest: status ? { ts: ago(5), status, metric: 120, unit: 'ms', message: null } : null,
  series: [],
  thresholds: { warn: 1000, crit: 3000, unit: 'ms' },
});
const PROBES = {
  items: [
    probe('probes.entra-openid', 'identity', 'crit'),
    probe('probes.sign-in-health', 'identity', 'ok'),
    probe('probes.graph-reachability', 'm365', 'ok'),
    probe('probes.service-health', 'm365', 'ok'),
    probe('probes.intune-reachability', 'endpoint', 'warn'),
    probe('probes.policy-check', 'azure', null),
    // AdminForge's own checks have no section in the rail: Synthetic monitoring lists them.
    probe('probes.token-graph', 'platform', 'crit'),
  ],
  groups: [
    { key: 'identity', label: 'Identity', icon: 'identification-card' },
    { key: 'm365', label: 'Microsoft 365', icon: 'squares-four' },
    { key: 'endpoint', label: 'Endpoint', icon: 'devices' },
    { key: 'azure', label: 'Azure', icon: 'cloud' },
    { key: 'platform', label: 'AdminForge', icon: 'gauge' },
  ],
};
const probesAnswer =
  (answer: { status?: number; body: unknown }): MockHandler =>
  ({ method, path }) =>
    method === 'GET' && path === '/api/probes' ? answer : undefined;

const nav = () => screen.getByRole('navigation', { name: 'Primary' });
const checkLinks = () => within(nav()).queryAllByRole('link', { name: /service checks/ });

describe('navigation: check status per section', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('ends each section with probes with its worst result, in words, linking to its checks', async () => {
    const { container } = renderApp({ handlers: [probesAnswer({ body: PROBES })] });
    const identity = await within(await screen.findByRole('navigation', { name: 'Primary' })).findByRole(
      'link',
      { name: 'Identity service checks: 1 failing, 1 healthy' },
    );
    expect(identity).toHaveAttribute('href', '/monitoring?group=identity');
    expect(identity).toHaveAttribute('data-status', 'crit');
    expect(identity.querySelector('svg')).not.toBeNull(); // a glyph, not only a colour

    const m365 = within(nav()).getByRole('link', { name: 'Microsoft 365 service checks: 2 healthy' });
    expect(m365).toHaveAttribute('href', '/monitoring?group=m365');
    expect(m365).toHaveAttribute('data-status', 'ok');
    expect(within(nav()).getByRole('link', { name: 'Endpoint service checks: 1 degraded' })).toHaveAttribute(
      'data-status',
      'warn',
    );
    // No probe of Azure's has a result yet: no mark (nav-check-marks.test.tsx).
    expect(within(nav()).queryByRole('link', { name: /^Azure service checks/ })).toBeNull();

    // Sections without probes get no mark; AdminForge's own (platform) checks aren't a section.
    expect(checkLinks()).toHaveLength(3);
    expect(within(nav()).queryByRole('link', { name: /^Automation service checks/ })).toBeNull();
    expect(within(nav()).queryByRole('link', { name: /AdminForge/ })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('section rows are full size with their hidden-page count (not beside a mark); the toggle stays a separate control', async () => {
    renderApp({ handlers: [probesAnswer({ body: PROBES })] });
    await screen.findByRole('navigation', { name: 'Primary' });
    const toggle = await within(nav()).findByRole('button', { name: 'Identity (6 pages hidden)' });
    expect(toggle).toHaveClass('text-md', 'text-fg-2');
    expect(toggle).not.toHaveClass('af-eyebrow');
    // The count would read as a count of failures beside the mark: the name says it instead.
    expect(toggle).toHaveTextContent(/^Identity$/);
    expect(within(nav()).getByRole('button', { name: 'Automation (3 pages hidden)' })).toHaveTextContent(
      'Automation3',
    );
    // The check link isn't inside the toggle (no nested controls) nor inside the heading that names the list.
    const link = await within(nav()).findByRole('link', { name: /^Identity service checks/ });
    expect(toggle.contains(link)).toBe(false);
    expect(link.closest('h2')).toBeNull();
  });

  it('opens Synthetic monitoring for that section only, and marks it as the current place', async () => {
    const { router } = renderApp({ handlers: [probesAnswer({ body: PROBES })] });
    await screen.findByRole('navigation', { name: 'Primary' });
    await userEvent.click(await within(nav()).findByRole('link', { name: /^Identity service checks/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitoring'));
    expect(router.state.location.search).toMatchObject({ group: 'identity' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Monitoring' })).toBeInTheDocument();
    const link = within(nav()).getByRole('link', { name: /^Identity service checks/ });
    await waitFor(() => expect(link).toHaveAttribute('aria-current', 'page'));
    // Only one place is current: the plain Synthetic monitoring item isn't, while a section's checks are open.
    await userEvent.click(within(nav()).getByRole('button', { name: /^Automation/ }));
    expect(within(nav()).getByRole('link', { name: 'Synthetic monitoring' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('shows no marks, and nothing in the way, when probes are not readable', async () => {
    renderApp({
      handlers: [
        probesAnswer({
          status: 403,
          body: { error: { code: 'forbidden', message: 'You can’t see this.', correlationId: 'c-1' } },
        }),
      ],
    });
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(await within(nav()).findByRole('button', { name: /^Identity/ })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Example Org' })).toBeInTheDocument();
    expect(checkLinks()).toHaveLength(0);
    expect(screen.queryByText('You can’t see this.')).toBeNull();
  });

  it('shares Synthetic monitoring’s cache: one request for the rail and the page', async () => {
    expect(PROBES_KEY).toEqual(probesQuery.queryKey);
    const { calls } = renderApp({ path: '/monitoring', handlers: [probesAnswer({ body: PROBES })] });
    await within(await screen.findByRole('main')).findByRole('button', { name: /^probes\.entra-openid/ });
    await within(nav()).findByRole('link', { name: /^Identity service checks/ });
    expect(calls.filter((c) => c.url === '/api/probes')).toHaveLength(1);
  });

  it('the status mark is reached with the keyboard, right after its section toggle', async () => {
    renderApp({ handlers: [probesAnswer({ body: PROBES })] });
    await screen.findByRole('navigation', { name: 'Primary' });
    const toggle = await within(nav()).findByRole('button', { name: /^Identity \(/ });
    const link = await within(nav()).findByRole('link', { name: /^Identity service checks/ });
    toggle.focus();
    await userEvent.tab();
    expect(link).toHaveFocus();
  });

  it('does not ask for probes without the Reader role (the API would refuse)', async () => {
    const { calls } = renderApp({
      session: me({ roles: ['Playbook.Approver'] }),
      handlers: [probesAnswer({ body: PROBES })],
    });
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(await within(nav()).findByRole('button', { name: /^Identity/ })).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/probes')).toBe(false);
    expect(checkLinks()).toHaveLength(0);
  });

  it('the icon rail has no section rows, so no marks either', async () => {
    __resetPrefsForTests({ navCollapsed: true });
    const { calls } = renderApp({ handlers: [probesAnswer({ body: PROBES })] });
    await screen.findByRole('navigation', { name: 'Primary' });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/probes')).toBe(true));
    expect(await within(nav()).findByRole('link', { name: 'Groups' })).toBeInTheDocument();
    expect(checkLinks()).toHaveLength(0);
  });
});
