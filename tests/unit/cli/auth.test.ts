import {
  buildAuthorizeUrl,
  checkAuthorizeUrl,
  clientCredentialToken,
  pkceChallenge,
  tokenRoles,
  TokenError,
} from '@adminforge/cli/src/provision/auth';

const TENANT = '0f1e2d3c-4b5a-4968-8776-655443322110';
const CLIENT = '1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: unknown) => `${b64({ alg: 'none' })}.${b64(payload)}.sig`;

describe('clientCredentialToken', () => {
  it('posts a client-credentials form to the tenant v2 endpoint and caches until near expiry', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    let clock = 1_000_000;
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ access_token: `tok${calls.length}`, expires_in: 3600 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const get = clientCredentialToken({
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: 's3cret',
      scope: 'https://graph.microsoft.com/.default',
      fetch: fake,
      now: () => clock,
    });
    expect(await get()).toBe('tok1');
    expect(await get()).toBe('tok1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('scope')).toBe('https://graph.microsoft.com/.default');
    clock += 3600_000;
    expect(await get()).toBe('tok2');
  });

  it('reports the AADSTS code without leaking the secret', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_client',
          error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: abc',
        }),
        { status: 401 },
      )) as unknown as typeof fetch;
    const get = clientCredentialToken({
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: 'super-secret-value',
      scope: 'x/.default',
      fetch: fake,
    });
    const err = await get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenError);
    expect((err as TokenError).aadsts).toBe('AADSTS7000215');
    expect((err as TokenError).message).not.toContain('super-secret-value');
    expect((err as TokenError).message).not.toContain('Trace ID');
  });
});

describe('tokenRoles', () => {
  it('returns the sorted roles claim', () =>
    expect(tokenRoles(jwt({ roles: ['User.Read.All', 'Directory.Read.All'] }))).toEqual([
      'Directory.Read.All',
      'User.Read.All',
    ]));
  it('returns [] when there is no roles claim', () => expect(tokenRoles(jwt({ appid: CLIENT }))).toEqual([]));
});

describe('authorize URL', () => {
  const redirectUri = 'http://localhost:5173/auth/callback';
  const url = buildAuthorizeUrl({
    tenantId: TENANT,
    clientId: CLIENT,
    redirectUri,
    scopes: ['openid', 'profile'],
    state: 'st',
    codeChallenge: pkceChallenge('verifier-verifier-verifier-verifier-verifier'),
  });

  it('is well-formed: auth code + PKCE S256 against the tenant authority', () => {
    expect(checkAuthorizeUrl(url, { tenantId: TENANT, clientId: CLIENT, redirectUri })).toEqual([]);
    const u = new URL(url);
    expect(u.searchParams.get('scope')).toBe('openid profile');
    expect(u.searchParams.get('code_challenge')).toHaveLength(43);
  });

  it('flags a mismatched client id or redirect URI', () => {
    expect(
      checkAuthorizeUrl(url, {
        tenantId: TENANT,
        clientId: '00000000-0000-0000-0000-000000000001',
        redirectUri,
      }),
    ).toContain('client_id does not match the Read app');
    expect(
      checkAuthorizeUrl(url, { tenantId: TENANT, clientId: CLIENT, redirectUri: 'https://elsewhere/cb' }),
    ).toContain('redirect_uri does not match the registered callback');
    expect(checkAuthorizeUrl('not a url', { tenantId: TENANT, clientId: CLIENT, redirectUri })).toEqual([
      'not a valid URL',
    ]);
  });

  it('computes the RFC 7636 S256 challenge', () => {
    // Appendix B of RFC 7636.
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
