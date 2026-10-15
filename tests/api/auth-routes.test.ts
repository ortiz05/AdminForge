import { ReauthRequired } from '@adminforge/api/src/auth/types';
import { ApiErrorBody, MeResponse } from '@adminforge/schemas';
import {
  bindingCookie,
  cookieFrom,
  entraConfig,
  FakeAuthClient,
  getMe,
  makeApp,
  MINUTE,
  orgResponse,
  setCookieHeader,
  TENANT_ID,
  USER_OID,
  type TestApp,
} from './helpers';

type Setup = TestApp & { auth: FakeAuthClient };

async function setup(overrides: Record<string, string> = {}): Promise<Setup> {
  const auth = new FakeAuthClient();
  const t = await makeApp(entraConfig(overrides), { auth, fetch: async () => orgResponse() });
  return { ...t, auth };
}

/** Starts /auth/login and returns the state/nonce Entra would echo back. */
async function startLogin(t: Setup, returnTo = '/p/identity.users') {
  const res = await t.app.inject({
    method: 'GET',
    url: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  });
  expect(res.statusCode).toBe(302);
  const url = new URL(res.headers.location as string);
  return {
    url,
    state: url.searchParams.get('state')!,
    nonce: url.searchParams.get('nonce')!,
    pre: bindingCookie(res)!,
  };
}

async function signIn(t: Setup) {
  const { state, pre } = await startLogin(t);
  const res = await t.app.inject({
    method: 'GET',
    url: `/auth/callback?code=good-code&state=${state}`,
    headers: { cookie: pre },
  });
  expect(res.statusCode).toBe(302);
  const cookie = cookieFrom(res)!;
  const { me } = await getMe(t.app, cookie);
  return { cookie, csrf: me!.csrf, me: me!, res };
}

describe('Entra sign-in routes (fake AuthClient)', () => {
  let t: Setup;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
  });

  it('GET /auth/login stores a 10-minute single-use pre-auth record and redirects to the Read app', async () => {
    const { url, state, nonce } = await startLogin(t, '/p/identity.groups?x=1');
    expect(url.origin).toBe('https://login.example.test');
    expect(url.searchParams.get('app')).toBe('read');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const record = t.preauth.rows.get(state)!;
    expect(record).toMatchObject({
      kind: 'read',
      nonce,
      returnTo: '/p/identity.groups?x=1',
      sessionIdHash: null,
    });
    expect(record.verifier).not.toBe(url.searchParams.get('code_challenge'));
    expect(record.expiresAt.getTime()).toBe(t.clock.t + 10 * MINUTE);
  });

  it('rejects an unknown state', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${'x'.repeat(43)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(ApiErrorBody.parse(res.json()).error).toMatchObject({
      code: 'invalid_state',
      message: 'This sign-in link has expired or was already used.',
    });
    expect(t.auth.redeems).toHaveLength(0);
  });

  it('rejects an expired state', async () => {
    const { state, pre } = await startLogin(t);
    t.clock.advance(10 * MINUTE + 1);
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${state}`,
      headers: { cookie: pre },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_state');
  });

  it('state is single use', async () => {
    const { state, pre } = await startLogin(t);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/auth/callback?code=good-code&state=${state}`,
          headers: { cookie: pre },
        })
      ).statusCode,
    ).toBe(302);
    const replay = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${state}`,
      headers: { cookie: pre },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe('invalid_state');
  });

  it('successful callback: session with roles from the ID token, cookie, audit, redirect to returnTo', async () => {
    const { cookie, me, res } = await signIn(t);
    expect(res.headers.location).toBe('/p/identity.users');
    expect(setCookieHeader(res)).toMatch(/HttpOnly/);
    expect(MeResponse.parse(me)).toMatchObject({
      user: { oid: USER_OID, upn: 'avery@example.com', name: 'Avery Engineer', tenantId: TENANT_ID },
      tenant: { name: 'Example Org', domain: 'example.com' },
      roles: ['Portal.Reader', 'Portal.Operator'],
      mode: 'read',
      canArm: true,
      authMode: 'entra',
      dataMode: 'live',
    });
    const [session] = [...t.sessions.rows.values()];
    expect(t.auth.redeems[0]).toMatchObject({
      kind: 'read',
      code: 'good-code',
      partitionKey: `read:${session!.idHash}`,
    });
    expect(session!.readAccountId).toBe(`${USER_OID}.${TENANT_ID}`);
    expect(cookie.split('=')[1]).not.toBe(session!.idHash);
    expect(t.audit.rows.map((r) => [r.action, r.result])).toEqual([['session.signin', 'success']]);
  });

  it('nonce mismatch → 400, no session, cache partition dropped, failure audited', async () => {
    t.auth.claims = () => ({ nonce: 'something-else' });
    const { state, pre } = await startLogin(t);
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${state}`,
      headers: { cookie: pre },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_nonce');
    expect(cookieFrom(res)).toBeUndefined();
    expect(t.sessions.rows.size).toBe(0);
    expect(t.auth.forgets).toEqual([{ kind: 'read', partitionKey: t.auth.redeems[0]!.partitionKey }]);
    expect(t.audit.rows.map((r) => [r.action, r.result, r.details?.reason])).toEqual([
      ['session.signin', 'failure', 'invalid_nonce'],
    ]);
  });

  it('tenant mismatch → 400 wrong_tenant, no session', async () => {
    t.auth.claims = () => ({ tid: '99999999-9999-4999-8999-999999999999' });
    const { state, pre } = await startLogin(t);
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${state}`,
      headers: { cookie: pre },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('wrong_tenant');
    expect(t.sessions.rows.size).toBe(0);
  });

  it('no portal role → 403 no_portal_role', async () => {
    t.auth.claims = () => ({ roles: ['Something.Else'] });
    const { state, pre } = await startLogin(t);
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${state}`,
      headers: { cookie: pre },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('no_portal_role');
    expect(t.sessions.rows.size).toBe(0);
  });

  it('an Entra error redirect → a specific code, the AADSTS number as detail, no Entra text shown', async () => {
    const { state, pre } = await startLogin(t);
    const description = encodeURIComponent(
      'AADSTS50105: The signed in user is not assigned to a role.\r\nTrace ID: abc',
    );
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?error=access_denied&error_description=${description}&state=${state}`,
      headers: { cookie: pre },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({
      code: 'no_portal_role',
      message: 'Your account doesn’t have access to AdminForge yet.',
      detail: 'AADSTS50105',
    });
  });

  it('a failed code redemption → 400 without a session', async () => {
    const { state, pre } = await startLogin(t);
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=bad-code&state=${state}`,
      headers: { cookie: pre },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('signin_failed');
    expect(t.sessions.rows.size).toBe(0);
  });

  it('tenant profile falls back to AF_PRIMARY_DOMAIN when Graph is unavailable', async () => {
    const auth = new FakeAuthClient();
    const t2 = await makeApp(entraConfig({ AF_PRIMARY_DOMAIN: 'example.net' }), {
      auth,
      fetch: async () => new Response('nope', { status: 503 }),
    });
    const s = await signIn({ ...t2, auth });
    expect(s.me.tenant).toEqual({ name: 'example.net', domain: 'example.net' });
    await t2.app.close();
  });

  it('logout clears both cache partitions and returns the Entra end-session URL', async () => {
    const { cookie, csrf } = await signIn(t);
    const [session] = [...t.sessions.rows.values()];
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, 'x-adminforge-csrf': csrf },
    });
    expect(res.statusCode).toBe(200);
    const redirect = new URL(res.json().redirect);
    expect(redirect.origin).toBe('https://login.example.test');
    expect(redirect.searchParams.get('post_logout_redirect_uri')).toBe(
      'http://localhost:5173/auth/signed-out',
    );
    expect(t.auth.forgets).toEqual([
      { kind: 'read', partitionKey: `read:${session!.idHash}` },
      { kind: 'write', partitionKey: `write:${session!.idHash}` },
    ]);
    expect(t.sessions.rows.size).toBe(0);
    expect(t.audit.rows.at(-1)!.action).toBe('session.signout');
  });

  it('a reauth-required token error maps to 401 {code:"reauth", reauth:{url}}', async () => {
    const { cookie } = await signIn(t);
    t.auth.tokenImpl = async () => {
      throw new ReauthRequired('read');
    };
    const res = await t.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });
    expect(res.statusCode).toBe(401);
    expect(ApiErrorBody.parse(res.json()).error).toMatchObject({
      code: 'reauth',
      reauth: { url: '/auth/login?returnTo=%2F' },
      login: '/auth/login?returnTo=%2F',
    });
  });

  it('uses __Host-adminforge with Secure in production', async () => {
    const auth = new FakeAuthClient();
    const prod = await makeApp(
      entraConfig({
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://adminforge.example.com',
        LOG_LEVEL: 'silent',
      }),
      { auth, fetch: async () => orgResponse() },
    );
    const { state, pre } = await startLogin({ ...prod, auth });
    const res = await prod.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${state}`,
      headers: { cookie: pre },
    });
    const set = setCookieHeader(res, '__Host-adminforge')!;
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toMatch(/Domain=/);
    expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    await prod.app.close();
  });
});

describe('Entra arm / extend / disarm (fake AuthClient)', () => {
  let t: Setup;
  afterEach(async () => {
    await t.app.close();
  });

  async function armStart(
    cookie: string,
    csrf: string,
    body = { minutes: 30, reason: 'Disable test user' },
    query = '',
  ) {
    return t.app.inject({
      method: 'POST',
      url: `/auth/arm${query}`,
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: body,
    });
  }

  /** The callback in the browser that started arming: its binding cookie plus `cookie` (the session). */
  async function armCallback(cookie: string, started: Awaited<ReturnType<Setup['app']['inject']>>) {
    const state = new URL(started.json().redirect).searchParams.get('state')!;
    return t.app.inject({
      method: 'GET',
      url: `/auth/arm/callback?code=write-code&state=${state}`,
      headers: { cookie: `${cookie}; ${bindingCookie(started)}` },
    });
  }

  it('without WRITE_AUTH_CONTEXT: Write app URL with login_hint, prompt=login and max_age=0', async () => {
    t = await setup();
    const { cookie, csrf } = await signIn(t);
    const res = await armStart(cookie, csrf, undefined, '?returnTo=%2Fp%2Fidentity.users');
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().redirect);
    expect(url.searchParams.get('app')).toBe('write');
    expect(url.searchParams.get('login_hint')).toBe('avery@example.com');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
    expect(url.searchParams.get('claims')).toBeNull();
    const pending = t.preauth.rows.get(url.searchParams.get('state')!)!;
    expect(pending).toMatchObject({
      kind: 'write',
      returnTo: '/p/identity.users',
      details: { minutes: 30, reason: 'Disable test user' },
    });
  });

  it('with WRITE_AUTH_CONTEXT: requests acrs via claims and requires it at the callback', async () => {
    t = await setup({ WRITE_AUTH_CONTEXT: 'c1' });
    const { cookie, csrf } = await signIn(t);
    const res = await armStart(cookie, csrf);
    const url = new URL(res.json().redirect);
    expect(JSON.parse(url.searchParams.get('claims')!)).toEqual({
      id_token: { acrs: { essential: true, value: 'c1' } },
      access_token: { acrs: { essential: true, value: 'c1' } },
    });
    expect(url.searchParams.get('prompt')).toBeNull();

    // Callback without the acrs claim → refused.
    const refused = await armCallback(cookie, res);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('step_up_required');
    expect((await getMe(t.app, cookie)).me!.mode).toBe('read');

    // Second attempt satisfies c1.
    t.auth.claims = (kind) => (kind === 'write' ? { acrs: ['c1'] } : {});
    const again = await armStart(cookie, csrf);
    const ok = await armCallback(cookie, again);
    expect(ok.statusCode).toBe(302);
    expect((await getMe(t.app, cookie)).me!.mode).toBe('armed');
    const armed = t.audit.rows.filter((r) => r.action === 'session.armed');
    expect(armed.map((r) => r.result)).toEqual(['failure', 'success']);
    expect(armed[1]!.details).toMatchObject({ acrs: ['c1'], reason: 'Disable test user' });
  });

  it('callback opens the write window: requested minutes capped by WRITE_SESSION_MAX_MINUTES', async () => {
    t = await setup({ WRITE_SESSION_MAX_MINUTES: '45' });
    const { cookie, csrf } = await signIn(t);
    const res = await armStart(cookie, csrf, { minutes: 120, reason: 'Maintenance window' });
    const cb = await armCallback(cookie, res);
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/');
    const [session] = [...t.sessions.rows.values()];
    expect(t.auth.redeems.at(-1)).toMatchObject({ kind: 'write', partitionKey: `write:${session!.idHash}` });
    expect(session!.writeAccountId).toBe(`${USER_OID}.${TENANT_ID}`);
    expect(session!.writeExpiresAt!.getTime()).toBe(t.clock.t + 45 * MINUTE);
    expect(session!.writeReason).toBe('Maintenance window');
    const { me } = await getMe(t.app, cookie);
    expect(me).toMatchObject({ mode: 'armed', armedUntil: new Date(t.clock.t + 45 * MINUTE).toISOString() });
  });

  it('arm callback with a different user (oid mismatch) → 403, not armed, write partition dropped', async () => {
    t = await setup();
    const { cookie, csrf } = await signIn(t);
    t.auth.claims = (kind) => (kind === 'write' ? { oid: '55555555-6666-4777-8888-999999999999' } : {});
    const res = await armStart(cookie, csrf);
    const cb = await armCallback(cookie, res);
    expect(cb.statusCode).toBe(403);
    expect(cb.json().error.code).toBe('user_mismatch');
    expect((await getMe(t.app, cookie)).me!.mode).toBe('read');
    const [session] = [...t.sessions.rows.values()];
    expect(t.auth.forgets).toContainEqual({ kind: 'write', partitionKey: `write:${session!.idHash}` });
    expect(t.audit.rows.at(-1)).toMatchObject({
      action: 'session.armed',
      result: 'failure',
      details: { error: 'user_mismatch' },
    });
  });

  it('arm callback from another session → 401 session_mismatch (no redemption)', async () => {
    t = await setup();
    const a = await signIn(t);
    const b = await signIn(t);
    const res = await armStart(a.cookie, a.csrf);
    const cb = await armCallback(b.cookie, res);
    expect(cb.statusCode).toBe(401);
    expect(cb.json().error.code).toBe('session_mismatch');
    expect(t.auth.redeems.filter((r) => r.kind === 'write')).toHaveLength(0);
  });

  it('arm requires CSRF and Portal.Operator; 503 when the Write app is not configured', async () => {
    t = await setup();
    t.auth.claims = () => ({ roles: ['Portal.Reader'] });
    const reader = await signIn(t);
    expect(reader.me.canArm).toBe(false);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/auth/arm',
          headers: { cookie: reader.cookie },
          payload: { minutes: 30, reason: 'Disable test user' },
        })
      ).statusCode,
    ).toBe(403);
    const forbidden = await armStart(reader.cookie, reader.csrf);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('forbidden');
    await t.app.close();

    t = await setup({ AF_WRITE_CLIENT_ID: '', AF_WRITE_CLIENT_SECRET: '' });
    const op = await signIn(t);
    expect(op.me.canArm).toBe(false);
    const res = await armStart(op.cookie, op.csrf);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('write_app_not_configured');
  });

  it('extend once and disarm (drops the write partition)', async () => {
    t = await setup();
    const { cookie, csrf } = await signIn(t);
    const res = await armStart(cookie, csrf);
    await armCallback(cookie, res);
    const h = { cookie, 'x-adminforge-csrf': csrf };
    expect(
      (await t.app.inject({ method: 'POST', url: '/auth/arm/extend', headers: h, payload: { minutes: 30 } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await t.app.inject({ method: 'POST', url: '/auth/arm/extend', headers: h, payload: {} })).statusCode,
    ).toBe(409);
    const dis = await t.app.inject({ method: 'POST', url: '/auth/disarm', headers: h });
    expect(dis.statusCode).toBe(200);
    const [session] = [...t.sessions.rows.values()];
    expect(session!.writeAccountId).toBeNull();
    expect(t.auth.forgets.at(-1)).toEqual({ kind: 'write', partitionKey: `write:${session!.idHash}` });
    expect(t.audit.rows.map((r) => r.action)).toEqual([
      'session.signin',
      'session.armed',
      'session.arm_extended',
      'session.disarmed',
    ]);
    expect(await t.audit.verify()).toMatchObject({ ok: true });
  });
});
