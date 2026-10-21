import { createMsalAuthClient, silentFailure, type MsalApp } from '@adminforge/api/src/auth/msal-client';
import { createTokenCache, MemorySealedBlobStore } from '@adminforge/api/src/auth/token-cache';
import { ReauthRequired } from '@adminforge/api/src/auth/types';
import { loadConfig } from '@adminforge/api/src/config';

/** What MSAL Node throws for an OAuth error response without an interaction-required sub-error. */
const serverError = (errorCode: string, errorMessage: string) =>
  Object.assign(new Error(`${errorCode}: ${errorMessage}`), {
    name: 'ServerError',
    errorCode,
    errorMessage,
    subError: '',
  });

// A disabled account, a password reset or revoked sessions make Entra answer the refresh-token grant with
// invalid_grant (AADSTS50057, 50173, 700082). MSAL raises that as a plain ServerError, not InteractionRequiredAuthError;
// it must still mean "sign in again", or the role re-check would treat it as transient and keep the session alive.
describe('silentFailure', () => {
  it.each([
    ['AADSTS50057: The user account is disabled.'],
    ['AADSTS50173: The provided grant has expired due to it being revoked.'],
    ['AADSTS700082: The refresh token has expired due to inactivity.'],
  ])('invalid_grant (%s) → ReauthRequired', (message) => {
    const mapped = silentFailure(serverError('invalid_grant', message), 'read');
    expect(mapped).toBeInstanceOf(ReauthRequired);
    expect((mapped as ReauthRequired).kind).toBe('read');
  });

  it('unauthorized_client → ReauthRequired (write keeps its kind and claims)', () => {
    const mapped = silentFailure(serverError('unauthorized_client', 'AADSTS700016'), 'write', '{"c":1}');
    expect(mapped).toMatchObject({ kind: 'write', claims: '{"c":1}' });
  });

  it('a plain object with errorCode invalid_grant (ServerError-shaped) is mapped too', () =>
    expect(silentFailure({ name: 'ServerError', errorCode: 'invalid_grant' }, 'read')).toBeInstanceOf(
      ReauthRequired,
    ));

  it('transient failures pass through unchanged', () => {
    const err = serverError('temporarily_unavailable', 'AADSTS90033');
    expect(silentFailure(err, 'read')).toBe(err);
    const net = new TypeError('fetch failed');
    expect(silentFailure(net, 'read')).toBe(net);
  });
});

describe('MSAL AuthClient maps a dead refresh token to ReauthRequired', () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:5173',
    AUTH_MODE: 'entra',
    DATABASE_PATH: '/nonexistent/adminforge-test-unused.db',
    TOKEN_CACHE_KEY: Buffer.alloc(32, 7).toString('base64'),
    AF_TENANT_ID: '11111111-2222-4333-8444-555555555555',
    AF_READ_CLIENT_ID: '22222222-3333-4444-8555-666666666666',
    AF_READ_CLIENT_SECRET: 'synthetic-read-secret',
  });
  const cache = createTokenCache(new MemorySealedBlobStore(), Buffer.alloc(32, 7));

  const silent = vi.fn(async () => {
    throw serverError('invalid_grant', 'AADSTS50057: The user account is disabled.');
  });
  const app = {
    getTokenCache: () => ({ getAccountByHomeId: async () => ({ homeAccountId: 'h' }) }),
    acquireTokenSilent: silent,
  } as unknown as MsalApp;
  beforeEach(() => {
    silent.mockClear();
  });

  it('token()', async () => {
    const client = createMsalAuthClient(cfg, cache, undefined, { createApp: () => app });
    await expect(
      client.token({ kind: 'read', partitionKey: 'read:x', homeAccountId: 'h', scopes: ['openid'] }),
    ).rejects.toBeInstanceOf(ReauthRequired);
    expect(silent).toHaveBeenCalledTimes(1);
  });

  it('refreshClaims() (the role re-check)', async () => {
    const client = createMsalAuthClient(cfg, cache, undefined, { createApp: () => app });
    await expect(
      client.refreshClaims({ kind: 'read', partitionKey: 'read:x', homeAccountId: 'h' }),
    ).rejects.toBeInstanceOf(ReauthRequired);
    expect(silent).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
  });
});
