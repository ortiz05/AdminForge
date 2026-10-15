import { ApiError } from '@adminforge/connectors';
import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import { decodeClaimsChallenge, resourceScopes, TokenBroker } from '@adminforge/api/src/auth/token-broker';
import { NotArmed, ReauthRequired, type AuthClient } from '@adminforge/api/src/auth/types';
import { AppError, toAppError } from '@adminforge/api/src/errors';

const NOW = new Date('2026-10-15T12:00:00.000Z');

const session = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  idHash: 'abc123',
  userOid: 'u',
  upn: 'avery@example.com',
  displayName: 'Avery',
  tenantId: 't',
  tenantName: 'Example Org',
  tenantDomain: 'example.com',
  roles: ['Portal.Reader'],
  csrf: 'x',
  readAccountId: 'read-acct',
  writeAccountId: null,
  writeExpiresAt: null,
  writeExtended: false,
  writeReason: null,
  createdAt: NOW,
  lastSeenAt: NOW,
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  ip: null,
  userAgent: null,
  ...overrides,
});

function fakeAuth(impl?: (i: { kind: string; claims?: string }) => Promise<string>) {
  const calls: Array<Parameters<AuthClient['token']>[0]> = [];
  const auth = {
    token: async (i: Parameters<AuthClient['token']>[0]) => {
      calls.push(i);
      return impl ? impl(i) : `tok-${i.kind}`;
    },
  } as unknown as AuthClient;
  return { auth, calls };
}

const armed = () =>
  session({ writeAccountId: 'write-acct', writeExpiresAt: new Date(NOW.getTime() + 600_000) });

describe('TokenBroker', () => {
  it('read tokens come from the Read account in partition read:<sidHash>', async () => {
    const { auth, calls } = fakeAuth();
    const broker = new TokenBroker(auth, {}, () => NOW);
    expect(await broker.get(session(), 'graph', 'read')).toBe('tok-read');
    expect(calls[0]).toEqual({
      kind: 'read',
      partitionKey: 'read:abc123',
      homeAccountId: 'read-acct',
      scopes: ['https://graph.microsoft.com/.default'],
    });
    await broker.get(session(), 'arm', 'read');
    expect(calls[1]!.scopes).toEqual(['https://management.azure.com/.default']);
  });

  it('write tokens need an armed session and use partition write:<sidHash>', async () => {
    const { auth, calls } = fakeAuth();
    const broker = new TokenBroker(auth, {}, () => NOW);
    await expect(broker.get(session(), 'graph', 'write')).rejects.toBeInstanceOf(NotArmed);
    const expired = session({ writeAccountId: 'w', writeExpiresAt: new Date(NOW.getTime() - 1) });
    await expect(broker.get(expired, 'graph', 'write')).rejects.toBeInstanceOf(NotArmed);
    expect(await broker.get(armed(), 'exchange', 'write')).toBe('tok-write');
    expect(calls[0]).toMatchObject({
      kind: 'write',
      partitionKey: 'write:abc123',
      homeAccountId: 'write-acct',
      scopes: ['https://outlook.office365.com/.default'],
    });
  });

  it('SharePoint admin needs AF_SPO_TENANT_NAME', async () => {
    const { auth } = fakeAuth();
    await expect(
      new TokenBroker(auth, {}, () => NOW).get(session(), 'sharepointAdmin', 'read'),
    ).rejects.toMatchObject({ status: 503, code: 'service_not_configured' });
    expect(resourceScopes({ AF_SPO_TENANT_NAME: 'contoso' }).sharepointAdmin).toEqual([
      'https://contoso-admin.sharepoint.com/.default',
    ]);
    expect(Object.keys(resourceScopes({})).sort()).toEqual([
      'arm',
      'exchange',
      'graph',
      'logAnalytics',
      'sharepointAdmin',
      'teams',
    ]);
  });

  it('maps NotArmed and ReauthRequired to ApiErrorBody shapes', () => {
    expect(toAppError(new NotArmed())).toMatchObject({ status: 403, code: 'not_armed' });
    const read = toAppError(new ReauthRequired('read'));
    expect(read).toMatchObject({
      status: 401,
      code: 'reauth',
      extras: { login: '/auth/login?returnTo=%2F', reauth: { url: '/auth/login?returnTo=%2F' } },
    });
    const write = toAppError(new ReauthRequired('write'));
    expect(write).toMatchObject({ status: 403, code: 'rearm', extras: { reauth: { url: '/auth/arm' } } });
    const withClaims = toAppError(new ReauthRequired('read', '{"access_token":{}}')) as AppError;
    const url = new URL(withClaims.extras.reauth!.url, 'http://x');
    expect(Buffer.from(url.searchParams.get('claims')!, 'base64url').toString()).toBe('{"access_token":{}}');
  });

  it('withToken retries a CAE claims challenge once with the claims', async () => {
    const claims = '{"access_token":{"nbf":{"essential":true,"value":"1"}}}';
    const { auth, calls } = fakeAuth();
    const broker = new TokenBroker(auth, {}, () => NOW);
    let n = 0;
    const result = await broker.withToken(session(), 'graph', 'read', async (getToken) => {
      n++;
      if (n === 1)
        throw new ApiError(
          401,
          'InvalidAuthenticationToken',
          'challenge',
          'r1',
          Buffer.from(claims).toString('base64'),
        );
      return getToken();
    });
    expect(result).toBe('tok-read');
    expect(calls.map((c) => c.claims)).toEqual([undefined, claims]);
  });

  it('withToken surfaces ReauthRequired (with claims) when the challenge persists', async () => {
    const claims = '{"access_token":{"xms_cc":{"values":["CP1"]}}}';
    const { auth } = fakeAuth();
    const broker = new TokenBroker(auth, {}, () => NOW);
    const challenge = () =>
      new ApiError(
        401,
        'InvalidAuthenticationToken',
        'challenge',
        undefined,
        Buffer.from(claims).toString('base64'),
      );
    const err = await broker
      .withToken(session(), 'graph', 'read', async () => Promise.reject(challenge()))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReauthRequired);
    expect(err).toMatchObject({ kind: 'read', claims });
  });

  it('token errors surface unchanged (never as transport errors)', async () => {
    const { auth } = fakeAuth(async () => {
      throw new ReauthRequired('read');
    });
    const broker = new TokenBroker(auth, {}, () => NOW);
    let called = false;
    const err = await broker
      .withToken(session(), 'graph', 'read', async () => {
        called = true;
        return 'x';
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReauthRequired);
    expect(called).toBe(false);
  });

  it('other upstream errors are not retried', async () => {
    const { auth, calls } = fakeAuth();
    const broker = new TokenBroker(auth, {}, () => NOW);
    await expect(
      broker.withToken(session(), 'graph', 'read', async () =>
        Promise.reject(new ApiError(403, 'Forbidden', 'no')),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
  });

  it('decodeClaimsChallenge rejects junk', () => {
    expect(decodeClaimsChallenge(Buffer.from('{"a":1}').toString('base64'))).toBe('{"a":1}');
    expect(decodeClaimsChallenge('not base64 json')).toBeUndefined();
  });
});
