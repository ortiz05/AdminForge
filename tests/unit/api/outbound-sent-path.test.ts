import { RESPONSE_TOO_LARGE } from '@adminforge/connectors';
import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import {
  createOutboundExecutor,
  outboundAppError,
  sentPath,
  type OutboundDeps,
} from '@adminforge/api/src/execution/outbound';
import type { ExecutionIdentity } from '@adminforge/api/src/execution/types';

// The request policy must judge what is actually sent. Paths with control characters never leave; the policy is also
// re-run on the path as fetch's URL parser resolves it; oversized responses are refused with a clear error.
const NOW = new Date('2026-10-15T12:00:00.000Z');

function executor(fetch: typeof globalThis.fetch, extra: Partial<OutboundDeps['config']> = {}) {
  const urls: string[] = [];
  const auth = { token: async () => 'token' } as unknown as AuthClient;
  const deps: OutboundDeps = {
    config: {
      DATA_MODE: 'live',
      AF_SPO_TENANT_NAME: undefined,
      OUTBOUND_CONCURRENCY: 4,
      OUTBOUND_USER_CONCURRENCY: 2,
      OUTBOUND_TIMEOUT_MS: 5000,
      TOKEN_CACHE_KEY: undefined,
      ...extra,
    },
    broker: new TokenBroker(auth, {}, () => NOW),
    auth,
    automation: { clientId: 'a', credential: 'secret', token: async () => 'token-app' },
    fetch: async (input, init) => {
      urls.push(String(input));
      return fetch(input, init);
    },
    now: () => NOW,
    sleep: async () => undefined,
    maxRetries: 0,
  };
  return { out: createOutboundExecutor(deps), urls };
}

const automation: ExecutionIdentity = { kind: 'automation', mode: 'read' };
const ok = async () => new Response('{"value":[]}', { headers: { 'content-type': 'application/json' } });

describe('paths with control characters never leave', () => {
  it('a Graph path with TAB dot segments is refused before any token or fetch', async () => {
    const { out, urls } = executor(ok);
    await expect(
      out.execute(automation, { service: 'graph', method: 'GET', path: '/users/.\t./.\t./applications' }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect(urls).toEqual([]);
  });

  it.each([
    [{ id: '1', method: 'GET', url: '/users/.\t./.\t./applications' }],
    [{ id: '1', method: 'GET', url: 'users/x/.\n./.\n./servicePrincipals' }],
    [{ id: '1', method: 'GET', path: '/users/.\r./.\r./applications' }],
    [{ id: '1', method: 'GET', url: '/users/../applications' }],
  ])('a $batch sub-request %j is refused', async (request) => {
    const { out, urls } = executor(ok);
    await expect(
      out.execute(automation, {
        service: 'graph',
        method: 'POST',
        path: '/$batch',
        body: { requests: [request] },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    expect(urls).toEqual([]);
  });

  it('clean $batch sub-requests still go out', async () => {
    const { out, urls } = executor(
      async () =>
        new Response('{"responses":[{"id":"1","status":200,"body":{}}]}', {
          headers: { 'content-type': 'application/json' },
        }),
    );
    await out.execute(automation, {
      service: 'graph',
      method: 'POST',
      path: '/$batch',
      body: { requests: [{ id: '1', method: 'GET', url: '/users?$top=1' }] },
    });
    expect(urls).toEqual(['https://graph.microsoft.com/v1.0/$batch']);
  });
});

describe('sentPath (the path the service receives)', () => {
  it('is the path itself for clean paths', () => {
    expect(sentPath('graph', 'GET', '/users/x/memberOf', {})).toBe('/users/x/memberOf');
    expect(sentPath('graph', 'GET', '/users', { beta: true })).toBe('/users');
    expect(sentPath('arm', 'GET', '/subscriptions/s/resourceGroups', {})).toBe(
      '/subscriptions/s/resourceGroups',
    );
    expect(
      sentPath(
        'function',
        'GET',
        '/employees/1',
        {},
        { connection: { baseUrl: 'https://hr.example.com/api/' } },
      ),
    ).toBe('/employees/1');
  });

  it('shows how the URL parser rewrites a path (percent-encoding)', () =>
    expect(sentPath('graph', 'GET', '/users/a b', {})).toBe('/users/a%20b'));

  it.each(['/users/.\t./.\t./applications', '/a\nb'])('refuses %j', (p) =>
    expect(() => sentPath('graph', 'GET', p, {})).toThrow(/not a clean service path/),
  );
});

describe('response size cap', () => {
  it('an oversized Microsoft response becomes response_too_large with a hint (not a generic 502)', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const { out } = executor(async () => new Response(big, { headers: { 'content-type': 'text/plain' } }), {
      OUTBOUND_MAX_BYTES: 1024 * 1024,
    });
    const err = await out
      .execute(automation, { service: 'graph', method: 'GET', path: '/users' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: RESPONSE_TOO_LARGE });
    const app = outboundAppError(err);
    expect(app).toMatchObject({ status: 502, code: 'response_too_large' });
    expect(app.extras.hint).toMatch(/Narrow it down/);
  });
});
