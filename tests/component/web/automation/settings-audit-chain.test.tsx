import { screen } from '@testing-library/react';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { me } from '../../../support/web/fixtures/session';
import { settings } from '../../../support/web/fixtures/automation';
import { axeViolations } from '../../axe';
import { renderApp } from './render';

// S-10: Settings says whether the audit log is keyed (AUDIT_CHAIN_KEY) — for administrators, by configuration key,
// never a value: keyed since which event and whether that is pinned, or a warning that it is unkeyed.
const ADMIN = me({ roles: ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver', 'Portal.Admin'] });

const withChain = (auditChain: unknown) => [
  ({ method, path }: { method: string; path: string }) =>
    method === 'GET' && path === '/api/admin/settings' ? { body: { ...settings(), auditChain } } : undefined,
];

describe('Settings: audit log key', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('unkeyed: a warning naming the configuration key', async () => {
    renderApp({ session: ADMIN, path: '/settings', handlers: withChain({ keyed: false }) });
    expect(await screen.findByText('Unkeyed')).toBeInTheDocument();
    expect(
      screen.getByText('Set AUDIT_CHAIN_KEY so changing an event needs a key the database doesn’t hold.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Audit log')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('keyed: since which event, and how to pin it', async () => {
    renderApp({ session: ADMIN, path: '/settings', handlers: withChain({ keyed: true, since: 12408 }) });
    expect(await screen.findByText('Keyed since event #12408')).toBeInTheDocument();
    expect(
      screen.getByText(
        /^Changing an event needs the key\. To catch removal .*AUDIT_CHAIN_KEYED_SINCE .*\(#12408 here\)\.$/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Unkeyed/)).toBeNull();
  });

  it('keyed and pinned', async () => {
    renderApp({
      session: ADMIN,
      path: '/settings',
      handlers: withChain({ keyed: true, since: 12408, pinned: true }),
    });
    expect(await screen.findByText('Keyed since event #12408')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Changing an event needs the key, and removing the keyed part is caught too (AUDIT_CHAIN_KEYED_SINCE).',
      ),
    ).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('an API that says nothing about it: no row', async () => {
    const { auditChain: _omit, ...older } = settings();
    renderApp({
      session: ADMIN,
      path: '/settings',
      handlers: [
        ({ method, path }) =>
          method === 'GET' && path === '/api/admin/settings' ? { body: older } : undefined,
      ],
    });
    expect(await screen.findByText('Example Org · example.com')).toBeInTheDocument();
    expect(screen.queryByText('Audit log')).toBeNull();
  });
});
