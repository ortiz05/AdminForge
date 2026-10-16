import { stepUpStrength } from '@adminforge/api/src/auth/arm-routes';
import { hasAccountStatus } from '@adminforge/api/src/auth/types';
import { AdminSettingsResponse } from '@adminforge/schemas';
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

// IAM-09: without the optional `acct` claim a guest can't be told from a member, so sign-in and arming refuse (fail
// closed) with a setup error for administrators. IAM-04: what arming proves (an authentication context, or only a fresh
// sign-in) is recorded on session.armed and shown in the installation settings.
type Setup = TestApp & { auth: FakeAuthClient };

async function setup(overrides: Record<string, string> = {}): Promise<Setup> {
  const auth = new FakeAuthClient();
  const t = await makeApp(entraConfig(overrides), { auth, fetch: async () => orgResponse() });
  return { ...t, auth };
}

async function signIn(t: Setup, headers: Record<string, string> = {}) {
  const login = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F' });
  const state = new URL(login.headers.location as string).searchParams.get('state');
  return t.app.inject({
    method: 'GET',
    url: `/auth/callback?code=good-code&state=${state}`,
    headers: { cookie: bindingCookie(login)!, ...headers },
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
  return t.app.inject({
    method: 'GET',
    url: `/auth/arm/callback?code=write-code&state=${redirect.searchParams.get('state')}`,
    headers: { cookie: `${cookie}; ${bindingCookie(start)}` },
  });
}

describe('hasAccountStatus', () => {
  it.each([
    [0, true],
    [1, true],
    ['0', true],
    [' 1 ', true],
    [undefined, false],
    ['', false],
    [2, false],
    ['guest', false],
  ])('acct %j → %s', (acct, expected) => {
    expect(hasAccountStatus({ acct: acct as number | string | undefined })).toBe(expected);
  });
});

describe('a missing acct claim is refused (IAM-09)', () => {
  let t: Setup;
  afterEach(async () => {
    await t.app.close();
  });

  it('refuses sign-in with a setup error for administrators', async () => {
    t = await setup();
    t.auth.claims = () => ({ acct: undefined });
    const res = await signIn(t);
    expect(res.statusCode).toBe(403);
    const error = res.json().error;
    expect(error.code).toBe('account_status_missing');
    expect(error.message).toBe(
      'AdminForge couldn’t confirm that your account is a member of this organisation.',
    );
    expect(error.hint).toContain('`pnpm adminforge provision entra`');
    expect(error.hint).toMatch(/sign in again\.$/);
    expect(cookieFrom(res)).toBeUndefined();
    expect(t.sessions.rows.size).toBe(0);
    expect(t.auth.forgets.some((f) => f.kind === 'read')).toBe(true);
    expect(t.audit.rows.at(-1)).toMatchObject({
      action: 'session.signin',
      result: 'failure',
      details: { reason: 'account_status_missing' },
    });
  });

  it('a browser navigation lands on the problem page with the code', async () => {
    t = await setup();
    t.auth.claims = () => ({ acct: undefined });
    const res = await signIn(t, { 'sec-fetch-mode': 'navigate' });
    expect(res.statusCode).toBe(303);
    expect(new URL(res.headers.location as string, 'http://x').searchParams.get('code')).toBe(
      'account_status_missing',
    );
  });

  it('refuses arming when the Write sign-in has no acct claim; the session stays read-only', async () => {
    t = await setup();
    const { cookie, csrf } = await signedIn(t);
    t.auth.claims = (kind) => (kind === 'write' ? { acct: undefined } : {});
    const res = await arm(t, cookie, csrf);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('account_status_missing');
    expect(res.json().error.hint).toMatch(/arm write access again\.$/);
    expect((await getMe(t.app, cookie)).me!.mode).toBe('read');
    expect(t.auth.forgets.some((f) => f.kind === 'write')).toBe(true);
    expect(t.audit.rows.at(-1)).toMatchObject({
      action: 'session.armed',
      result: 'failure',
      details: { error: 'account_status_missing' },
    });
  });
});

describe('stepUpStrength', () => {
  it('stepUpStrength: authContext with WRITE_AUTH_CONTEXT, freshSignIn without, none in mock mode', () => {
    expect(stepUpStrength({ AUTH_MODE: 'entra', WRITE_AUTH_CONTEXT: 'c1' })).toBe('authContext');
    expect(stepUpStrength({ AUTH_MODE: 'entra', WRITE_AUTH_CONTEXT: undefined })).toBe('freshSignIn');
    expect(stepUpStrength({ AUTH_MODE: 'mock', WRITE_AUTH_CONTEXT: undefined })).toBe('none');
  });
});

describe('step-up strength is visible (IAM-04)', () => {
  let t: Setup;
  afterEach(async () => {
    await t.app.close();
  });

  it('session.armed records freshSignIn without an authentication context', async () => {
    t = await setup();
    const { cookie, csrf } = await signedIn(t);
    expect((await arm(t, cookie, csrf)).statusCode).toBe(302);
    expect(t.audit.rows.find((r) => r.action === 'session.armed' && r.result === 'success')).toMatchObject({
      details: { stepUp: 'freshSignIn' },
    });
  });

  it('session.armed records authContext when WRITE_AUTH_CONTEXT is set and satisfied', async () => {
    t = await setup({ WRITE_AUTH_CONTEXT: 'c1' });
    const { cookie, csrf } = await signedIn(t);
    t.auth.claims = (kind) => (kind === 'write' ? { acrs: ['c1'] } : {});
    expect((await arm(t, cookie, csrf)).statusCode).toBe(302);
    expect(t.audit.rows.find((r) => r.action === 'session.armed' && r.result === 'success')).toMatchObject({
      details: { stepUp: 'authContext', acrs: ['c1'] },
    });
  });

  it('the installation settings say what arming proves', async () => {
    t = await setup();
    t.auth.claims = () => ({ roles: ['Portal.Reader', 'Portal.Admin'] });
    const { cookie } = await signedIn(t);
    const res = await t.app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(AdminSettingsResponse.parse(res.json()).writeStepUp).toBe('freshSignIn');
  });
});
