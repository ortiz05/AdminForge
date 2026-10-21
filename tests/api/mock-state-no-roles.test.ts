import { ApiErrorBody } from '@adminforge/schemas';
import { cookieFrom, getMe, makeApp, mockConfig, mockLogin, type TestApp } from './helpers';

/**
 * Mock sign-in (loopback only) matches the real role path: a session left without any AdminForge role ends — like
 * the periodic role re-check with Entra (`session.access_revoked`) — and the answer is the 403 `no_portal_role` a
 * sign-in without a role gets. It never leaves a valid, role-less session behind.
 */
describe('POST /auth/mock/state with no roles', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp(mockConfig());
  });
  afterEach(async () => {
    await t.app.close();
  });

  const post = (cookie: string, csrf: string, payload: object) =>
    t.app.inject({
      method: 'POST',
      url: '/auth/mock/state',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload,
    });

  it('ends the session and answers no_portal_role, in plain words', async () => {
    const { cookie, csrf, me } = await mockLogin(t.app);
    const res = await post(cookie, csrf, { roles: [] });
    expect(res.statusCode).toBe(403);
    const { error } = ApiErrorBody.parse(res.json());
    expect(error).toMatchObject({
      code: 'no_portal_role',
      message: 'Your account doesn’t have access to AdminForge yet.',
      hint: expect.stringMatching(/AdminForge group/),
      correlationId: expect.any(String),
    });
    // The session is gone (no role-less session to use), and the browser is told to drop the cookie.
    expect(t.sessions.rows.size).toBe(0);
    expect((await getMe(t.app, cookie)).res.statusCode).toBe(401);
    expect(cookieFrom(res)).toBe('adminforge-dev=');
    // Recorded as the real path records it.
    const revoked = t.audit.rows.find((r) => r.action === 'session.access_revoked');
    expect(revoked).toMatchObject({
      actorUpn: 'avery@example.com',
      result: 'success',
      details: { previousRoles: me.roles, reason: 'roles', mock: true },
    });
  });

  it('still sets other roles and write access as before', async () => {
    const { cookie, csrf } = await mockLogin(t.app);
    const res = await post(cookie, csrf, { roles: ['Portal.Reader'], armedMinutes: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ roles: ['Portal.Reader'], mode: 'read' });
    expect((await getMe(t.app, cookie)).res.statusCode).toBe(200);
    expect(t.audit.rows.some((r) => r.action === 'session.access_revoked')).toBe(false);
  });

  it('leaves the roles alone when the body names none', async () => {
    const { cookie, csrf, me } = await mockLogin(t.app);
    const res = await post(cookie, csrf, { armedMinutes: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ roles: me.roles, mode: 'armed' });
  });
});
