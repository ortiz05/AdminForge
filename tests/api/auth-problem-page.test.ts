import { ApiErrorBody } from '@adminforge/schemas';
import {
  cookieFrom,
  entraConfig,
  FakeAuthClient,
  getMe,
  makeApp,
  orgResponse,
  type TestApp,
} from './helpers';

// Browser navigations to /auth/* that fail go to the public problem page, never to raw JSON.
type Setup = TestApp & { auth: FakeAuthClient };
const NAVIGATE = { 'sec-fetch-mode': 'navigate', accept: 'text/html,application/xhtml+xml' };

async function setup(): Promise<Setup> {
  const auth = new FakeAuthClient();
  const t = await makeApp(entraConfig(), { auth, fetch: async () => orgResponse() });
  return { ...t, auth };
}

async function loginState(t: Setup, query = '') {
  const res = await t.app.inject({ method: 'GET', url: `/auth/login?returnTo=%2F${query}` });
  return new URL(res.headers.location as string);
}

const problem = (location: unknown) => {
  const url = new URL(String(location), 'https://portal.example.test');
  expect(url.pathname).toBe('/sign-in-problem');
  return url.searchParams;
};

describe('sign-in problem page redirects', () => {
  let t: Setup;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
  });

  it('a navigation that fails (no portal role) is redirected with the code, reference, and Microsoft code', async () => {
    const state = (await loginState(t)).searchParams.get('state')!;
    const description = encodeURIComponent('AADSTS50105: The signed in user is not assigned to a role.');
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?error=access_denied&error_description=${description}&state=${state}`,
      headers: NAVIGATE,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers['cache-control']).toBe('no-store');
    const q = problem(res.headers.location);
    expect(q.get('code')).toBe('no_portal_role');
    expect(q.get('detail')).toBe('AADSTS50105');
    expect(q.get('ref')).toBe(res.headers['x-correlation-id']);
    expect(q.get('during')).toBeNull();
    // Entra's own text never travels in the URL.
    expect(String(res.headers.location)).not.toMatch(/assigned/i);
  });

  it('an expired or replayed state is explained on the page', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${'x'.repeat(43)}`,
      headers: NAVIGATE,
    });
    expect(res.statusCode).toBe(303);
    expect(problem(res.headers.location).get('code')).toBe('invalid_state');
  });

  it('a user cancelling at Microsoft becomes signin_cancelled with the OAuth error as detail', async () => {
    const state = (await loginState(t)).searchParams.get('state')!;
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?error=access_denied&state=${state}`,
      headers: NAVIGATE,
    });
    const q = problem(res.headers.location);
    expect(q.get('code')).toBe('signin_cancelled');
    expect(q.get('detail')).toBe('access_denied');
  });

  it('write-access failures carry during=arm', async () => {
    const signedIn = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${(await loginState(t)).searchParams.get('state')}`,
    });
    const cookie = cookieFrom(signedIn)!;
    const { me } = await getMe(t.app, cookie);
    const arm = await t.app.inject({
      method: 'POST',
      url: '/auth/arm',
      headers: { cookie, 'x-adminforge-csrf': me!.csrf },
      payload: { minutes: 30, reason: 'Disable test user' },
    });
    expect(arm.statusCode, arm.body).toBe(200);
    const state = new URL(arm.json().redirect).searchParams.get('state')!;
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/arm/callback?error=access_denied&state=${state}`,
      headers: { ...NAVIGATE, cookie },
    });
    expect(res.statusCode).toBe(303);
    const q = problem(res.headers.location);
    expect(q.get('code')).toBe('arm_cancelled');
    expect(q.get('during')).toBe('arm');
  });

  it('API clients (fetch, no navigation) still get the JSON error body', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${'x'.repeat(43)}`,
      headers: { 'sec-fetch-mode': 'cors', accept: 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('invalid_state');
  });

  it('?account=choose asks Entra for the account picker instead of hinting the last account', async () => {
    await loginState(t, '&account=choose');
    expect(t.auth.authUrls.at(-1)).toMatchObject({ kind: 'read', prompt: 'select_account' });
    expect(t.auth.authUrls.at(-1)?.loginHint).toBeUndefined();
  });
});
