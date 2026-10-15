import { STEP_UP_MAX_AGE_SECONDS } from '@adminforge/api/src/auth/arm-routes';
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

// Without WRITE_AUTH_CONTEXT, arming must prove a fresh interactive sign-in through auth_time; prompt=login alone
// travels in a browser-controlled URL and can be stripped.
type Setup = TestApp & { auth: FakeAuthClient };

async function setup(overrides: Record<string, string> = {}): Promise<Setup> {
  const auth = new FakeAuthClient();
  const t = await makeApp(entraConfig(overrides), { auth, fetch: async () => orgResponse() });
  return { ...t, auth };
}

async function signInAndStartArm(t: Setup) {
  const login = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F' });
  const state = new URL(login.headers.location as string).searchParams.get('state');
  const cb = await t.app.inject({
    method: 'GET',
    url: `/auth/callback?code=good-code&state=${state}`,
    headers: { cookie: bindingCookie(login)! },
  });
  const cookie = cookieFrom(cb)!;
  const { me } = await getMe(t.app, cookie);
  const arm = await t.app.inject({
    method: 'POST',
    url: '/auth/arm',
    headers: { cookie, 'x-adminforge-csrf': me!.csrf },
    payload: { minutes: 30, reason: 'Disable test user' },
  });
  return {
    cookie: `${cookie}; ${bindingCookie(arm)}`,
    armState: new URL(arm.json().redirect).searchParams.get('state')!,
  };
}

const callback = (t: Setup, cookie: string, state: string) =>
  t.app.inject({
    method: 'GET',
    url: `/auth/arm/callback?code=write-code&state=${state}`,
    headers: { cookie },
  });

describe('arm step-up freshness (no auth context)', () => {
  let t: Setup;
  afterEach(async () => {
    await t.app.close();
  });

  it('arms when the Write sign-in happened just now', async () => {
    t = await setup();
    const { cookie, armState } = await signInAndStartArm(t);
    const res = await callback(t, cookie, armState);
    expect(res.statusCode).toBe(302);
    const { me } = await getMe(t.app, cookie);
    expect(me!.mode).toBe('armed');
  });

  it('refuses a token without auth_time (fails closed) and leaves the session read-only', async () => {
    t = await setup();
    t.auth.claims = (kind) => (kind === 'write' ? { auth_time: undefined } : {});
    const { cookie, armState } = await signInAndStartArm(t);
    const res = await callback(t, cookie, armState);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('step_up_unverified');
    const { me } = await getMe(t.app, cookie);
    expect(me!.mode).toBe('read');
    expect(t.auth.forgets.some((f) => f.kind === 'write')).toBe(true);
  });

  it('refuses a silent SSO sign-in (auth_time older than the limit)', async () => {
    t = await setup();
    const stale = Math.floor(t.clock.now().getTime() / 1000) - STEP_UP_MAX_AGE_SECONDS - 1;
    t.auth.claims = (kind) => (kind === 'write' ? { auth_time: stale } : {});
    const { cookie, armState } = await signInAndStartArm(t);
    const res = await callback(t, cookie, armState);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('step_up_stale');
  });

  it('with WRITE_AUTH_CONTEXT the acrs claim decides, not auth_time', async () => {
    t = await setup({ WRITE_AUTH_CONTEXT: 'c1' });
    t.auth.claims = (kind) => (kind === 'write' ? { auth_time: undefined, acrs: ['c1'] } : {});
    const { cookie, armState } = await signInAndStartArm(t);
    expect((await callback(t, cookie, armState)).statusCode).toBe(302);
  });
});
