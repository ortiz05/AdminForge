import {
  bindingCookie,
  cookieFrom,
  entraConfig,
  FakeAuthClient,
  makeApp,
  orgResponse,
  setCookieHeader,
  type TestApp,
} from './helpers';

// Login CSRF / session swap: a callback URL captured from one browser's sign-in can't be completed in another.
type Setup = TestApp & { auth: FakeAuthClient };
async function setup(overrides: Record<string, string> = {}): Promise<Setup> {
  const auth = new FakeAuthClient();
  return { ...(await makeApp(entraConfig(overrides), { auth, fetch: async () => orgResponse() })), auth };
}

async function start(t: Setup, cookie?: string) {
  const res = await t.app.inject({
    method: 'GET',
    url: '/auth/login',
    ...(cookie ? { headers: { cookie } } : {}),
  });
  return { state: new URL(res.headers.location as string).searchParams.get('state')!, res };
}

describe('sign-in round trips are bound to the browser that started them', () => {
  let t: Setup;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
  });

  it('sets an HttpOnly, SameSite=Lax binding cookie and reuses it for later sign-ins', async () => {
    const first = await start(t);
    const set = setCookieHeader(first.res, 'adminforge-dev-pre')!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    const pre = bindingCookie(first.res)!;
    const second = await start(t, pre);
    expect(bindingCookie(second.res)).toBe(pre);
  });

  it('the callback without the binding cookie is refused and creates no session', async () => {
    const { state } = await start(t);
    const res = await t.app.inject({ method: 'GET', url: `/auth/callback?code=good-code&state=${state}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_state');
    expect(cookieFrom(res)).toBeUndefined();
    expect(t.sessions.rows.size).toBe(0);
    expect(t.auth.redeems).toHaveLength(0);
  });

  it("another browser's binding cookie is refused (the attacker's callback in the victim's browser)", async () => {
    const attacker = await start(t);
    const victim = bindingCookie((await start(t)).res)!;
    expect(victim).not.toBe(bindingCookie(attacker.res));
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${attacker.state}`,
      headers: { cookie: victim },
    });
    expect(res.json().error.code).toBe('invalid_state');
    expect(t.sessions.rows.size).toBe(0);
  });

  it('production uses a __Host- binding cookie with Secure', async () => {
    const prod = await setup({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://adminforge.example.com',
      LOG_LEVEL: 'silent',
    });
    const { res } = await start(prod);
    expect(setCookieHeader(res, '__Host-adminforge-pre')).toMatch(/Secure/);
    await prod.app.close();
  });
});
