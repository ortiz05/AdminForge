import { ApiErrorBody, MeResponse, NavResponse, PORTAL_ROLES } from '@adminforge/schemas';
import { cookieFrom, getMe, makeApp, MINUTE, mockConfig, mockLogin, setCookieHeader, type TestApp } from './helpers';

describe('sessions, mock sign-in, /api/me, CSRF', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp(mockConfig());
  });
  afterEach(async () => {
    await t.app.close();
  });

  it('GET /api/me without a session → 401 with a login URL', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
    const body = ApiErrorBody.parse(res.json());
    expect(body.error).toMatchObject({ code: 'unauthenticated', login: '/auth/login?returnTo=%2F' });
    expect(body.error.correlationId).toBe(res.headers['x-correlation-id']);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('mock login sets an HttpOnly SameSite=Lax dev cookie and redirects to a safe returnTo', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2Fp%2Fidentity.users%3Fq%3D1' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/p/identity.users?q=1');
    const set = setCookieHeader(res)!;
    expect(set).toMatch(/^adminforge-dev=[A-Za-z0-9_-]{43};/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toMatch(/Secure/);

    const evil = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F%2Fevil.example' });
    expect(evil.headers.location).toBe('/');
  });

  it('stores only the hash of the session id', async () => {
    const { cookie } = await mockLogin(t.app);
    const sid = cookie.split('=')[1]!;
    expect([...t.sessions.rows.keys()].some((k) => k.includes(sid))).toBe(false);
    expect([...t.sessions.rows.keys()][0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('GET /api/me returns the exact MeResponse for Avery Engineer', async () => {
    const { cookie } = await mockLogin(t.app);
    const { res, me } = await getMe(t.app, cookie);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(Object.keys(MeResponse.shape).sort());
    expect(me).toMatchObject({
      user: { name: 'Avery Engineer', upn: 'avery@example.com' },
      tenant: { name: 'Example Org', domain: 'example.com' },
      roles: [...PORTAL_ROLES],
      mode: 'read',
      armedUntil: null,
      canArm: true,
      armExtended: false,
      armMaxMinutes: 60,
      prefs: {},
      authMode: 'mock',
      dataMode: 'fixtures',
    });
    expect(me!.csrf.length).toBeGreaterThanOrEqual(32);
    expect(t.audit.rows.map((r) => r.action)).toEqual(['session.signin']);
  });

  it('honours MOCK_ROLES', async () => {
    const t2 = await makeApp(mockConfig({ MOCK_ROLES: 'Portal.Reader' }));
    const { me } = await mockLogin(t2.app);
    expect(me.roles).toEqual(['Portal.Reader']);
    expect(me.canArm).toBe(false);
    await t2.app.close();
  });

  it('PUT /api/me/prefs requires the CSRF header, validates, merges, and audits', async () => {
    const { cookie, csrf } = await mockLogin(t.app);
    const put = (body: unknown, headers: Record<string, string> = {}) =>
      t.app.inject({ method: 'PUT', url: '/api/me/prefs', headers: { cookie, ...headers }, payload: body as object });

    const missing = await put({ theme: 'daylight' });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error.code).toBe('csrf');
    expect((await put({ theme: 'daylight' }, { 'x-adminforge-csrf': 'wrong' })).statusCode).toBe(403);

    const ok = await put({ theme: 'daylight', density: 'compact' }, { 'x-adminforge-csrf': csrf });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ prefs: { theme: 'daylight', density: 'compact' } });
    expect((await put({ navCollapsed: true }, { 'x-adminforge-csrf': csrf })).json().prefs).toEqual({ theme: 'daylight', density: 'compact', navCollapsed: true });

    const bad = await put({ theme: 'pink' }, { 'x-adminforge-csrf': csrf });
    expect(bad.statusCode).toBe(400);
    expect(ApiErrorBody.parse(bad.json()).error.code).toBe('invalid_request');
    expect((await put({ colour: 'x' }, { 'x-adminforge-csrf': csrf })).statusCode).toBe(400);

    const { me } = await getMe(t.app, cookie);
    expect(me!.prefs).toEqual({ theme: 'daylight', density: 'compact', navCollapsed: true });
    const prefsEvents = t.audit.rows.filter((r) => r.action === 'prefs.updated');
    expect(prefsEvents.map((e) => e.details)).toEqual([{ changed: ['theme', 'density'] }, { changed: ['navCollapsed'] }]);
  });

  it('GET /api/nav returns sections built from content; Admin only for Portal.Admin', async () => {
    const { cookie, csrf } = await mockLogin(t.app);
    const res = await t.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie } });
    const nav = NavResponse.parse(res.json());
    // Section order comes from portal/content/navigation.yaml; empty sections are dropped (content grows over time).
    expect(nav.sections[0]).toMatchObject({ key: 'overview', items: [{ key: 'overview', href: '/' }] });
    expect(nav.sections.map((s) => s.key)).toEqual(expect.arrayContaining(['overview', 'identity', 'automation', 'reports', 'admin']));
    expect(nav.sections.every((s) => s.items.length > 0)).toBe(true);
    const identity = nav.sections.find((s) => s.key === 'identity')!;
    expect(identity.items).toContainEqual(expect.objectContaining({ key: 'identity.users', label: 'Users', href: '/p/identity.users' }));
    expect(nav.sections.flatMap((s) => s.items).every((i) => i.href.startsWith('/'))).toBe(true);

    await t.app.inject({ method: 'POST', url: '/auth/mock/state', headers: { cookie, 'x-adminforge-csrf': csrf }, payload: { roles: ['Portal.Reader'] } });
    const reader = NavResponse.parse((await t.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie } })).json());
    expect(reader.sections.some((s) => s.key === 'admin')).toBe(false);
  });

  describe('arm / extend / disarm (mock)', () => {
    it('POST /auth/arm needs CSRF and Portal.Operator, validates the body, arms immediately', async () => {
      const { cookie, csrf } = await mockLogin(t.app);
      const arm = (payload: object, headers: Record<string, string> = { 'x-adminforge-csrf': csrf }) =>
        t.app.inject({ method: 'POST', url: '/auth/arm', headers: { cookie, ...headers }, payload });

      expect((await arm({ minutes: 30, reason: 'Disable a test user' }, {})).statusCode).toBe(403);
      expect((await arm({ minutes: 30, reason: 'no' })).statusCode).toBe(400);

      const res = await arm({ minutes: 30, reason: 'Disable a test user' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ redirect: '/' });
      const { me } = await getMe(t.app, cookie);
      expect(me!.mode).toBe('armed');
      expect(Date.parse(me!.armedUntil!)).toBe(t.clock.t + 30 * MINUTE);
      const armed = t.audit.rows.find((r) => r.action === 'session.armed')!;
      expect(armed.details).toMatchObject({ minutes: 30, reason: 'Disable a test user' });
    });

    it('caps the armed window at WRITE_SESSION_MAX_MINUTES', async () => {
      const { cookie, csrf } = await mockLogin(t.app);
      await t.app.inject({ method: 'POST', url: '/auth/arm', headers: { cookie, 'x-adminforge-csrf': csrf }, payload: { minutes: 240, reason: 'Long maintenance' } });
      const { me } = await getMe(t.app, cookie);
      expect(Date.parse(me!.armedUntil!)).toBe(t.clock.t + 60 * MINUTE);
    });

    it('refuses to arm without Portal.Operator', async () => {
      const { cookie, csrf } = await mockLogin(t.app);
      await t.app.inject({ method: 'POST', url: '/auth/mock/state', headers: { cookie, 'x-adminforge-csrf': csrf }, payload: { roles: ['Portal.Reader'] } });
      const res = await t.app.inject({ method: 'POST', url: '/auth/arm', headers: { cookie, 'x-adminforge-csrf': csrf }, payload: { minutes: 30, reason: 'Should not work' } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    });

    it('extends once, then refuses; disarm ends write access', async () => {
      const { cookie, csrf } = await mockLogin(t.app);
      const h = { cookie, 'x-adminforge-csrf': csrf };
      await t.app.inject({ method: 'POST', url: '/auth/arm', headers: h, payload: { minutes: 15, reason: 'Group cleanup' } });
      t.clock.advance(10 * MINUTE);

      const ext = await t.app.inject({ method: 'POST', url: '/auth/arm/extend', headers: h, payload: {} });
      expect(ext.statusCode).toBe(200);
      expect(ext.json()).toEqual({ armedUntil: new Date(t.clock.t + 60 * MINUTE).toISOString(), armExtended: true });
      expect((await getMe(t.app, cookie)).me!.armExtended).toBe(true);

      const again = await t.app.inject({ method: 'POST', url: '/auth/arm/extend', headers: h, payload: {} });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('already_extended');

      const dis = await t.app.inject({ method: 'POST', url: '/auth/disarm', headers: h });
      expect(dis.statusCode).toBe(200);
      expect(dis.json()).toEqual({ mode: 'read', armedUntil: null });
      expect((await getMe(t.app, cookie)).me).toMatchObject({ mode: 'read', armedUntil: null, armExtended: false });
      expect((await t.app.inject({ method: 'POST', url: '/auth/arm/extend', headers: h, payload: {} })).json().error.code).toBe('not_armed');
      expect(t.audit.rows.map((r) => r.action)).toEqual(['session.signin', 'session.armed', 'session.arm_extended', 'session.disarmed']);
    });

    it('extend and disarm require the CSRF header', async () => {
      const { cookie } = await mockLogin(t.app);
      expect((await t.app.inject({ method: 'POST', url: '/auth/arm/extend', headers: { cookie }, payload: {} })).statusCode).toBe(403);
      expect((await t.app.inject({ method: 'POST', url: '/auth/disarm', headers: { cookie } })).statusCode).toBe(403);
    });

    it('write access ends at its expiry and the expiry is audited', async () => {
      const { cookie, csrf } = await mockLogin(t.app);
      await t.app.inject({ method: 'POST', url: '/auth/arm', headers: { cookie, 'x-adminforge-csrf': csrf }, payload: { minutes: 5, reason: 'Quick change' } });
      t.clock.advance(6 * MINUTE);
      expect((await getMe(t.app, cookie)).me).toMatchObject({ mode: 'read', armedUntil: null });
      expect(t.audit.rows.at(-1)!.action).toBe('session.arm_expired');
      expect(await t.audit.verify()).toEqual({ ok: true, count: 3 });
    });
  });

  it('POST /auth/mock/state sets roles and armed state and returns MeResponse', async () => {
    const { cookie, csrf } = await mockLogin(t.app);
    const post = (payload: object, headers: Record<string, string> = { 'x-adminforge-csrf': csrf }) =>
      t.app.inject({ method: 'POST', url: '/auth/mock/state', headers: { cookie, ...headers }, payload });
    expect((await post({ armedMinutes: 10 }, {})).statusCode).toBe(403);

    const armed = MeResponse.parse((await post({ roles: ['Portal.Reader', 'Portal.Operator'], armedMinutes: 4.5 })).json());
    expect(armed).toMatchObject({ roles: ['Portal.Reader', 'Portal.Operator'], mode: 'armed' });
    expect(Date.parse(armed.armedUntil!)).toBe(t.clock.t + 4.5 * MINUTE);

    const read = MeResponse.parse((await post({ armedMinutes: null })).json());
    expect(read.mode).toBe('read');
    expect((await post({ roles: ['Not.A.Role'] })).statusCode).toBe(400);
  });

  it('idle expiry ends the session', async () => {
    const { cookie } = await mockLogin(t.app);
    t.clock.advance(59 * MINUTE);
    expect((await getMe(t.app, cookie)).res.statusCode).toBe(200);
    t.clock.advance(59 * MINUTE); // activity above slid the idle window
    expect((await getMe(t.app, cookie)).res.statusCode).toBe(200);
    t.clock.advance(61 * MINUTE);
    const { res } = await getMe(t.app, cookie);
    expect(res.statusCode).toBe(401);
    expect(setCookieHeader(res)).toMatch(/^adminforge-dev=;/);
    expect(t.sessions.rows.size).toBe(0);
  });

  it('absolute expiry ends the session even with activity', async () => {
    const t2 = await makeApp(mockConfig({ SESSION_ABSOLUTE_HOURS: '1' }));
    const { cookie } = await mockLogin(t2.app);
    for (let i = 0; i < 3; i++) {
      t2.clock.advance(19 * MINUTE);
      expect((await getMe(t2.app, cookie)).res.statusCode).toBe(200);
    }
    t2.clock.advance(4 * MINUTE);
    expect((await getMe(t2.app, cookie)).res.statusCode).toBe(401);
    await t2.app.close();
  });

  it('logout needs CSRF, clears the cookie and session, audits, and returns a redirect', async () => {
    const { cookie, csrf } = await mockLogin(t.app);
    expect((await t.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })).statusCode).toBe(403);
    const res = await t.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, 'x-adminforge-csrf': csrf } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ redirect: '/signed-out' });
    expect(setCookieHeader(res)).toMatch(/^adminforge-dev=;/);
    expect((await getMe(t.app, cookie)).res.statusCode).toBe(401);
    expect(t.audit.rows.at(-1)!.action).toBe('session.signout');
    // Without a session, logout is a harmless no-op.
    expect((await t.app.inject({ method: 'POST', url: '/auth/logout' })).json()).toEqual({ redirect: '/signed-out' });
  });

  it('a new sign-in replaces the previous session', async () => {
    const first = await mockLogin(t.app);
    const res = await t.app.inject({ method: 'GET', url: '/auth/login', headers: { cookie: first.cookie } });
    const second = cookieFrom(res)!;
    expect(second).not.toBe(first.cookie);
    expect((await getMe(t.app, first.cookie)).res.statusCode).toBe(401);
    expect((await getMe(t.app, second)).res.statusCode).toBe(200);
  });

  it('GET /auth/signed-out lands on the SPA signed-out page', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/auth/signed-out' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/signed-out');
  });
});
