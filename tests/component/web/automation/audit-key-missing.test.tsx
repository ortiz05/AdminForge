import { screen } from '@testing-library/react';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { me } from '../../../support/web/fixtures/session';
import { renderApp } from './render';

// S-10: a stretch of the audit log keyed with a key the portal doesn't have can't be checked. The Audit page says so —
// "can't verify", not "broken" — without naming the key or its id.
const ADMIN = me({ roles: ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver', 'Portal.Admin'] });

describe('Audit page: a keyed stretch without its key', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('says it can’t verify from that event, not that the chain is broken', async () => {
    renderApp({
      session: ADMIN,
      path: '/audit',
      handlers: [
        ({ method, path }) =>
          method === 'GET' && path === '/api/audit/verify'
            ? { body: { ok: false, checked: 120, brokenAt: 121, keyMissing: true } }
            : undefined,
      ],
    });
    expect(await screen.findByText('Can’t verify from #121 · key not configured')).toBeInTheDocument();
    expect(screen.queryByText(/Chain broken/)).toBeNull();
  });
});
