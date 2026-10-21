import { screen } from '@testing-library/react';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { me } from '../../../support/web/fixtures/session';
import { axeViolations } from '../../axe';
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

  it('says it can’t verify from that event, not that the chain is broken, and what to do', async () => {
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
    expect(await screen.findByText('Can’t verify from #121')).toBeInTheDocument();
    expect(screen.queryByText(/Chain broken/)).toBeNull();
    // What to do, readable on any device (not only in a hover tooltip).
    expect(screen.getByText('The audit log can’t be verified from event #121')).toBeInTheDocument();
    expect(
      screen.getByText(/put the earlier key in AUDIT_CHAIN_PREVIOUS_KEYS .*the event was forged/),
    ).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });
});
