import { ROLE_FAIL_CLOSED_MS, ROLE_RECHECK_MS } from '@adminforge/api/src/auth/session-plugin';
import { STEP_UP_MAX_AGE_SECONDS } from '@adminforge/api/src/auth/arm-routes';
import { ReauthRequired } from '@adminforge/api/src/auth/types';
import {
  bindingCookie,
  cookieFrom,
  entraConfig,
  FakeAuthClient,
  getMe,
  makeApp,
  MINUTE,
  orgResponse,
  type TestApp,
} from './helpers';

type Setup = TestApp & { auth: FakeAuthClient };

async function setup(overrides: Record<string, string> = {}): Promise<Setup> {
  const auth = new FakeAuthClient();
  const t = await makeApp(entraConfig(overrides), { auth, fetch: async () => orgResponse() });
  return { ...t, auth };
}

async function signIn(t: Setup) {
  const login = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F' });
  const state = new URL(login.headers.location as string).searchParams.get('state');
  return t.app.inject({
    method: 'GET',
    url: `/auth/callback?code=good-code&state=${state}`,
    headers: { cookie: bindingCookie(login)! },
  });
}

async function signedIn(t: Setup) {
  const cookie = cookieFrom(await signIn(t))!;
  const { me } = await getMe(t.app, cookie);
  return { cookie, csrf: me!.csrf };
}

async function arm(t: Setup, cookie: string, csrf: string) {
  const start = await t.app.inject({
    method: 'POST',
    url: '/auth/arm',
    headers: { cookie, 'x-adminforge-csrf': csrf },
    payload: { minutes: 30, reason: 'Disable test user' },
  });
  const redirect = new URL(start.json().redirect);
  const res = await t.app.inject({
    method: 'GET',
    url: `/auth/arm/callback?code=write-code&state=${redirect.searchParams.get('state')}`,
    headers: { cookie: `${cookie}; ${bindingCookie(start)}` },
  });
  return { redirect, res };
}

describe('guest accounts are refused (acct claim)', () => {
  let t: Setup;
  afterEach(async () => {
    await t.app.close();
  });

  it.each([[1], ['1']])(
    'refuses sign-in when acct is %j, with a code and a hint for the person',
    async (acct) => {
      t = await setup();
      t.auth.claims = () => ({ acct });
      const res = await signIn(t);
      expect(res.statusCode).toBe(403);
      const error = res.json().error;
      expect(error).toMatchObject({ code: 'guest_account', message: 'You signed in with a guest account.' });
      expect(error.hint).toBe(
        'Sign in with your work account in this organisation; guest accounts can’t use AdminForge.',
      );
      expect(cookieFrom(res)).toBeUndefined();
      expect(t.sessions.rows.size).toBe(0);
      expect(t.auth.forgets.some((f) => f.kind === 'read')).toBe(true);
      expect(t.audit.rows.at(-1)).toMatchObject({
        action: 'session.signin',
        result: 'failure',
        details: { reason: 'guest_account' },
      });
    },
  );

  it('a browser navigation lands on the problem page with the code', async () => {
    t = await setup();
    t.auth.claims = () => ({ acct: 1 });
    const login = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F' });
    const state = new URL(login.headers.location as string).searchParams.get('state');
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${state}`,
      headers: { cookie: bindingCookie(login)!, 'sec-fetch-mode': 'navigate' },
    });
    expect(res.statusCode).toBe(303);
    expect(new URL(res.headers.location as string, 'http://x').searchParams.get('code')).toBe(
      'guest_account',
    );
  });

  // (A token without acct is refused: tests/api/auth-account-status.test.ts.)
  it.each([[0], ['0']])(
    'members keep working (acct %j — e.g. the personal account that owns the tenant)',
    async (acct) => {
      t = await setup();
      t.auth.claims = () => ({ acct });
      const res = await signIn(t);
      expect(res.statusCode).toBe(302);
      expect((await getMe(t.app, cookieFrom(res)!)).me).toBeTruthy();
    },
  );

  it('refuses arming when the Write sign-in is a guest account', async () => {
    t = await setup();
    const { cookie, csrf } = await signedIn(t);
    t.auth.claims = (kind) => (kind === 'write' ? { acct: 1 } : {});
    const { res } = await arm(t, cookie, csrf);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('guest_account');
    expect((await getMe(t.app, cookie)).me!.mode).toBe('read');
  });

  it('ends a session whose account became a guest (role re-check)', async () => {
    t = await setup();
    const { cookie } = await signedIn(t);
    t.auth.refreshImpl = async () => ({ acct: 1 });
    t.clock.advance(ROLE_RECHECK_MS + 1000);
    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
    expect(t.audit.rows.find((r) => r.action === 'session.access_revoked')).toMatchObject({
      details: { reason: 'guest' },
    });
  });
});

describe('arming always needs a fresh interactive sign-in', () => {
  let t: Setup;
  afterEach(async () => {
    await t.app.close();
  });

  it.each([[{}], [{ WRITE_AUTH_CONTEXT: 'c1' }]])('asks for prompt=login and max_age=0 (%j)', async (cfg) => {
    t = await setup(cfg);
    t.auth.claims = (kind) => (kind === 'write' ? { acrs: ['c1'] } : {});
    const { cookie, csrf } = await signedIn(t);
    const { redirect, res } = await arm(t, cookie, csrf);
    expect(redirect.searchParams.get('prompt')).toBe('login');
    expect(redirect.searchParams.get('max_age')).toBe('0');
    expect(res.statusCode).toBe(302);
  });

  it('with WRITE_AUTH_CONTEXT, a satisfied auth context from an old sign-in is refused (step_up_stale)', async () => {
    t = await setup({ WRITE_AUTH_CONTEXT: 'c1' });
    const stale = Math.floor(t.clock.now().getTime() / 1000) - STEP_UP_MAX_AGE_SECONDS - 1;
    t.auth.claims = (kind) => (kind === 'write' ? { acrs: ['c1'], auth_time: stale } : {});
    const { cookie, csrf } = await signedIn(t);
    const { res } = await arm(t, cookie, csrf);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('step_up_stale');
    expect((await getMe(t.app, cookie)).me!.mode).toBe('read');
  });

  it('with WRITE_AUTH_CONTEXT, a token without auth_time is refused (fails closed)', async () => {
    t = await setup({ WRITE_AUTH_CONTEXT: 'c1' });
    t.auth.claims = (kind) => (kind === 'write' ? { acrs: ['c1'], auth_time: undefined } : {});
    const { cookie, csrf } = await signedIn(t);
    const { res } = await arm(t, cookie, csrf);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('step_up_unverified');
  });
});

describe('role re-check fails closed', () => {
  let t: Setup;
  afterEach(async () => {
    await t.app.close();
  });

  it('ends the session after ~15 minutes without a successful confirmation', async () => {
    t = await setup();
    const { cookie } = await signedIn(t);
    t.auth.refreshImpl = async () => {
      throw Object.assign(new Error('AADSTS90033: temporarily unavailable'), { name: 'ServerError' });
    };
    // Every two minutes the browser comes back; Entra keeps failing in a way that isn't a clear "sign in again".
    const signedInAt = t.clock.t;
    while (t.clock.t + 2 * MINUTE - signedInAt < ROLE_FAIL_CLOSED_MS) {
      t.clock.advance(2 * MINUTE);
      const minutes = (t.clock.t - signedInAt) / MINUTE;
      expect((await getMe(t.app, cookie)).me, `still signed in after ${minutes} min`).toBeTruthy();
    }
    t.clock.advance(2 * MINUTE);
    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
    expect(t.sessions.rows.size).toBe(0);
    expect(t.audit.rows.find((r) => r.action === 'session.access_revoked')).toMatchObject({
      details: { reason: 'unconfirmed' },
    });
  });

  it('a success in between resets the clock', async () => {
    t = await setup();
    const { cookie } = await signedIn(t);
    let fail = true;
    t.auth.refreshImpl = async () => {
      if (fail) throw new Error('ETIMEDOUT');
      return {};
    };
    t.clock.advance(ROLE_RECHECK_MS + MINUTE);
    expect((await getMe(t.app, cookie)).me).toBeTruthy();
    fail = false;
    t.clock.advance(2 * MINUTE);
    expect((await getMe(t.app, cookie)).me).toBeTruthy();
    fail = true;
    // 14 minutes after that success: still within the window.
    for (let i = 0; i < 7; i++) {
      t.clock.advance(2 * MINUTE);
      expect((await getMe(t.app, cookie)).me).toBeTruthy();
    }
  });

  it('a revoked refresh token (ReauthRequired) ends it at the next check', async () => {
    t = await setup();
    const { cookie } = await signedIn(t);
    t.auth.refreshImpl = async () => {
      throw new ReauthRequired('read');
    };
    t.clock.advance(ROLE_RECHECK_MS + 1000);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    expect(t.audit.rows.find((r) => r.action === 'session.access_revoked')).toMatchObject({
      details: { reason: 'reauth' },
    });
  });
});
