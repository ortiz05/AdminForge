import {
  bindingCookie,
  cookieFrom,
  entraConfig,
  FakeAuthClient,
  getMe,
  makeApp,
  orgResponse,
} from './helpers';

// S-26, end to end: the tenant name read at sign-in goes through the outbound executor, so it carries the sign-in's
// correlation id to Microsoft (client-request-id) like every other call, uses the Read token the sign-in just
// redeemed, and tries once: a failing Graph means the configured domain, not a slower sign-in.

async function signIn(fetch: typeof globalThis.fetch, overrides: Record<string, string> = {}) {
  const auth = new FakeAuthClient();
  const t = await makeApp(entraConfig(overrides), { auth, fetch });
  const login = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F' });
  const state = new URL(login.headers.location as string).searchParams.get('state')!;
  const res = await t.app.inject({
    method: 'GET',
    url: `/auth/callback?code=good-code&state=${state}`,
    headers: { cookie: bindingCookie(login)! },
  });
  expect(res.statusCode).toBe(302);
  const { me } = await getMe(t.app, cookieFrom(res)!);
  return { t, auth, me: me!, correlationId: String(res.headers['x-correlation-id']) };
}

describe('sign-in: tenant profile through the outbound executor', () => {
  it('sends one Graph read with the Read token and the sign-in correlation id', async () => {
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    const { t, auth, me, correlationId } = await signIn(async (input, init) => {
      sent.push({ url: String(input), headers: init?.headers as Record<string, string> });
      return orgResponse();
    });
    try {
      expect(me.tenant).toEqual({ name: 'Example Org', domain: 'example.com' });
      expect(sent.map((s) => s.url)).toEqual([
        'https://graph.microsoft.com/v1.0/organization?$select=displayName%2CverifiedDomains',
      ]);
      expect(sent[0]!.headers['client-request-id']).toBe(correlationId);
      expect(sent[0]!.headers.Authorization).toMatch(/^Bearer /);
      expect(auth.tokens.map((x) => x.kind)).toEqual(['read']);
    } finally {
      await t.app.close();
    }
  });

  it('tries once when Graph fails and signs in with the configured domain', async () => {
    let calls = 0;
    const { t, me } = await signIn(
      async () => {
        calls++;
        return new Response('nope', { status: 503 });
      },
      { AF_PRIMARY_DOMAIN: 'example.net' },
    );
    try {
      expect(me.tenant).toEqual({ name: 'example.net', domain: 'example.net' });
      expect(calls).toBe(1);
    } finally {
      await t.app.close();
    }
  });
});
