import { ROLE_RECHECK_MS } from '@adminforge/api/src/auth/session-plugin';
import { ReauthRequired } from '@adminforge/api/src/auth/types';
import {
  bindingCookie,
  cookieFrom,
  entraConfig,
  FakeAuthClient,
  getMe,
  makeApp,
  orgResponse,
  type TestApp,
} from './helpers';

// Roles are re-read from Entra every ROLE_RECHECK_MS: removing someone from a group (or disabling them) takes effect
// within minutes instead of at the end of a 12-hour session.
type Setup = TestApp & { auth: FakeAuthClient };

async function signedIn(): Promise<Setup & { cookie: string }> {
  const auth = new FakeAuthClient();
  const t = await makeApp(entraConfig(), { auth, fetch: async () => orgResponse() });
  const login = await t.app.inject({ method: 'GET', url: '/auth/login' });
  const state = new URL(login.headers.location as string).searchParams.get('state');
  const cb = await t.app.inject({
    method: 'GET',
    url: `/auth/callback?code=good-code&state=${state}`,
    headers: { cookie: bindingCookie(login)! },
  });
  return { ...t, auth, cookie: cookieFrom(cb)! };
}

describe('session roles stay current', () => {
  it('does not refresh within the interval', async () => {
    const t = await signedIn();
    t.clock.advance(ROLE_RECHECK_MS - 1000);
    await getMe(t.app, t.cookie);
    expect(t.auth.refreshes).toHaveLength(0);
    await t.app.close();
  });

  it('applies and audits a changed role set after the interval', async () => {
    const t = await signedIn();
    t.auth.refreshImpl = async () => ({ roles: ['Portal.Reader'] });
    t.clock.advance(ROLE_RECHECK_MS + 1000);
    const { me } = await getMe(t.app, t.cookie);
    expect(me!.roles).toEqual(['Portal.Reader']);
    expect(me!.canArm).toBe(false);
    expect(t.audit.rows.find((r) => r.action === 'session.roles_changed')).toMatchObject({
      details: { roles: ['Portal.Reader'] },
    });
    await t.app.close();
  });

  it('ends the session when no AdminForge role is left', async () => {
    const t = await signedIn();
    t.auth.refreshImpl = async () => ({ roles: [] });
    t.clock.advance(ROLE_RECHECK_MS + 1000);
    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(401);
    expect(t.sessions.rows.size).toBe(0);
    expect(t.audit.rows.some((r) => r.action === 'session.access_revoked')).toBe(true);
    await t.app.close();
  });

  it('ends the session when Entra will not refresh it (disabled account, password reset)', async () => {
    const t = await signedIn();
    t.auth.refreshImpl = async () => {
      throw new ReauthRequired('read');
    };
    t.clock.advance(ROLE_RECHECK_MS + 1000);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: t.cookie } })).statusCode,
    ).toBe(401);
    await t.app.close();
  });

  it('keeps the session through a transient Entra failure and retries later', async () => {
    const t = await signedIn();
    t.auth.refreshImpl = async () => {
      throw new Error('ETIMEDOUT');
    };
    t.clock.advance(ROLE_RECHECK_MS + 1000);
    expect((await getMe(t.app, t.cookie)).me).toBeTruthy();
    // Within the retry minute: no second attempt.
    await getMe(t.app, t.cookie);
    expect(t.auth.refreshes).toHaveLength(1);
    await t.app.close();
  });
});
