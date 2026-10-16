import { providerAuditDetails, providerError } from '@adminforge/api/src/auth/entra-errors';
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

// APP-03: anyone can loop /auth/login → /auth/callback?error=…&error_description=<text>. The audit log is permanent, so
// only allow-listed, structured values from the query reach it (the OAuth error code and the AADSTS number).
type Setup = TestApp & { auth: FakeAuthClient };

const INJECTED = 'Call the help desk at 555-0100 and read them your code';

async function setup(): Promise<Setup> {
  const auth = new FakeAuthClient();
  const t = await makeApp(entraConfig(), { auth, fetch: async () => orgResponse() });
  return { ...t, auth };
}

async function callbackWith(t: Setup, query: Record<string, string>) {
  const login = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F' });
  const state = new URL(login.headers.location as string).searchParams.get('state')!;
  const q = new URLSearchParams({ ...query, state });
  return t.app.inject({
    method: 'GET',
    url: `/auth/callback?${q}`,
    headers: { cookie: bindingCookie(login)! },
  });
}

describe('Entra error redirects never write free text into the audit log (APP-03)', () => {
  let t: Setup;
  afterEach(async () => {
    await t.app.close();
  });

  it('keeps the OAuth error and the AADSTS number, not the description', async () => {
    t = await setup();
    const res = await callbackWith(t, {
      error: 'access_denied',
      error_description: `AADSTS50105: ${INJECTED}`,
    });
    expect(res.statusCode).toBe(403);
    const row = t.audit.rows.at(-1)!;
    expect(row).toMatchObject({ action: 'session.signin', result: 'failure' });
    expect(row.details).toEqual({
      reason: 'no_portal_role',
      oauthError: 'access_denied',
      aadsts: 'AADSTS50105',
    });
    expect(JSON.stringify(row)).not.toContain('help desk');
  });

  it('an unknown error code is recorded as `other`, and shown nowhere', async () => {
    t = await setup();
    const res = await callbackWith(t, { error: 'call_the_help_desk_now', error_description: INJECTED });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('signin_failed');
    expect(res.json().error.detail).toBeUndefined();
    expect(JSON.stringify(res.json())).not.toMatch(/help/);
    expect(t.audit.rows.at(-1)!.details).toEqual({
      reason: 'signin_failed',
      oauthError: 'other',
      aadsts: null,
    });
  });

  it('the arm callback keeps the same allow-listed details', async () => {
    t = await setup();
    const login = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F' });
    const state = new URL(login.headers.location as string).searchParams.get('state');
    const cb = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${state}`,
      headers: { cookie: bindingCookie(login)! },
    });
    const cookie = cookieFrom(cb)!;
    const { me } = await getMe(t.app, cookie);
    const start = await t.app.inject({
      method: 'POST',
      url: '/auth/arm',
      headers: { cookie, 'x-adminforge-csrf': me!.csrf },
      payload: { minutes: 30, reason: 'Disable test user' },
    });
    const armState = new URL(start.json().redirect).searchParams.get('state')!;
    const q = new URLSearchParams({ error: 'access_denied', error_description: INJECTED, state: armState });
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/arm/callback?${q}`,
      headers: { cookie: `${cookie}; ${bindingCookie(start)}` },
    });
    expect(res.json().error.code).toBe('arm_cancelled');
    const row = t.audit.rows.at(-1)!;
    expect(row).toMatchObject({ action: 'session.armed', result: 'failure' });
    expect(row.details).toEqual({
      reason: 'Disable test user',
      error: 'arm_cancelled',
      oauthError: 'access_denied',
      aadsts: null,
    });
    expect(JSON.stringify(row)).not.toContain('help desk');
  });
});

describe('providerAuditDetails / providerError detail', () => {
  it('allow-lists the OAuth error and extracts only the AADSTS number', () => {
    expect(
      providerAuditDetails({ error: 'interaction_required', error_description: 'AADSTS50076: MFA required' }),
    ).toEqual({ oauthError: 'interaction_required', aadsts: 'AADSTS50076' });
    expect(providerAuditDetails({ error: 'x'.repeat(500) })).toEqual({ oauthError: 'other', aadsts: null });
    expect(providerAuditDetails({ error_description: INJECTED })).toEqual({
      oauthError: 'other',
      aadsts: null,
    });
  });

  it('the problem page detail is the AADSTS number or a known OAuth error, nothing else', () => {
    expect(providerError('read', { error: 'access_denied' })!.extras.detail).toBe('access_denied');
    expect(providerError('read', { error: 'made_up_code' })!.extras.detail).toBeUndefined();
    expect(
      providerError('read', { error: 'made_up_code', error_description: 'AADSTS90072: x' })!.extras.detail,
    ).toBe('AADSTS90072');
  });
});
