import { buildUrl, createGraphClient, decodeBatchBody, GraphError } from '@adminforge/connectors';
import { fakeFetch, headersOf, jsonBody, type Fake } from './fake-fetch';

// Ported from plan Task 1.13, plus regressions for bugs found while porting.
const client = (responses: Fake[], extra = {}) => {
  const f = fakeFetch(responses);
  const sleep = vi.fn(async () => {});
  return {
    f,
    sleep,
    g: createGraphClient({
      getToken: async () => 'tok',
      fetch: f.fetch,
      sleep,
      correlationId: 'corr-1',
      ...extra,
    }),
  };
};

describe('buildUrl', () => {
  it('keeps $ keys and encodes values with %20', () => {
    expect(
      buildUrl('https://graph.microsoft.com', {
        path: '/users',
        query: { $filter: "userType eq 'Guest'", $top: 5, skip: undefined },
      }),
    ).toBe("https://graph.microsoft.com/v1.0/users?$filter=userType%20eq%20'Guest'&$top=5");
  });
  it('rejects traversal', () =>
    expect(() => buildUrl('https://g', { path: '/users/../me' })).toThrow(/Invalid Graph path/));
  it('rejects percent-encoded traversal and separators', () => {
    expect(() => buildUrl('https://g', { path: '/users/%2E%2e/me' })).toThrow(/Invalid Graph path/);
    expect(() => buildUrl('https://g', { path: '/users/a%2Fb' })).toThrow(/Invalid Graph path/);
  });
  it('encodes query keys so they cannot inject parameters', () =>
    expect(buildUrl('https://g', { path: '/users', query: { 'a&b=c': 1 } })).toBe(
      'https://g/v1.0/users?a%26b%3Dc=1',
    ));
  it('uses /beta when asked and drops null and empty values', () =>
    expect(buildUrl('https://g', { path: '/users', beta: true, query: { $search: '', $top: null } })).toBe(
      'https://g/beta/users',
    ));
});

describe('graph client', () => {
  it('sends auth and correlation headers and returns data with requestId', async () => {
    const { g, f } = client([{ status: 200, body: { id: '1' }, headers: { 'request-id': 'ms-1' } }]);
    const r = await g.request<{ id: string }>({ path: '/me' });
    expect(r).toMatchObject({ data: { id: '1' }, status: 200, requestId: 'ms-1' });
    const h = headersOf(f.calls[0]!);
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['client-request-id']).toBe('corr-1');
  });
  it('honours Retry-After on 429', async () => {
    // The middle of the ±20 % Retry-After spread (D-03a): the wait is exactly what Microsoft named.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    onTestFinished(() => random.mockRestore());
    const { g, sleep } = client([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: { ok: true } },
    ]);
    await expect(g.request({ path: '/users' })).resolves.toMatchObject({ data: { ok: true } });
    expect(sleep).toHaveBeenCalledWith(2000);
  });
  it('throws GraphError with code, message, and requestId', async () => {
    const { g } = client([
      {
        status: 403,
        body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } },
        headers: { 'request-id': 'ms-9' },
      },
    ]);
    await expect(g.request({ path: '/users' })).rejects.toMatchObject({
      status: 403,
      code: 'Authorization_RequestDenied',
      requestId: 'ms-9',
      message: 'Insufficient privileges',
    });
  });
  it('surfaces CAE claims challenges', async () => {
    const { g } = client([
      {
        status: 401,
        body: { error: { code: 'InvalidAuthenticationToken', message: 'x' } },
        headers: {
          'www-authenticate': 'Bearer error="insufficient_claims", claims="eyJhY2Nlc3NfdG9rZW4iOnt9fQ=="',
        },
      },
    ]);
    const err = await g.request({ path: '/me' }).catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.claims).toBe('eyJhY2Nlc3NfdG9rZW4iOnt9fQ==');
  });
  it('parses $count text responses as numbers', async () => {
    const { g } = client([{ status: 200, body: 12408 }]);
    expect((await g.request<number>({ path: '/users/$count' })).data).toBe(12408);
  });
  it('follows nextLink and refuses links outside Graph', async () => {
    const { g } = client([
      {
        status: 200,
        body: { value: [1, 2], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=a' },
      },
      { status: 200, body: { value: [3], '@odata.nextLink': 'https://evil.example/steal' } },
    ]);
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const page of g.pages<number>({ path: '/users' })) seen.push(...page);
      })(),
    ).rejects.toThrow(/outside Graph/);
    expect(seen).toEqual([1, 2, 3]);
  });
  it('collects all pages up to maxItems', async () => {
    const { g } = client([
      {
        status: 200,
        body: { value: [1, 2], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=a' },
      },
      { status: 200, body: { value: [3, 4] } },
    ]);
    expect(await g.all<number>({ path: '/users' }, 3)).toEqual([1, 2, 3]);
  });
  it('chunks $batch by 20 and maps responses by id', async () => {
    const items = Array.from({ length: 45 }, (_, i) => ({ id: String(i), path: `/users/${i}` }));
    const reply = (ids: string[]) => ({
      status: 200,
      body: { responses: ids.map((id) => ({ id, status: 200, body: { id } })) },
    });
    const { g, f } = client([
      reply(items.slice(0, 20).map((i) => i.id)),
      reply(items.slice(20, 40).map((i) => i.id)),
      reply(items.slice(40).map((i) => i.id)),
    ]);
    const out = await g.batch(items);
    expect(f.calls).toHaveLength(3);
    expect(out['44']).toEqual({ status: 200, body: { id: '44' } });
  });

  // Bug fix: the doc comment promised per-item 429 retries that were never implemented.
  it('retries throttled $batch items once after their Retry-After', async () => {
    // The middle of the ±20 % Retry-After spread (D-03a): the wait is exactly what Microsoft named.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    onTestFinished(() => random.mockRestore());
    const { g, f, sleep } = client([
      {
        status: 200,
        body: {
          responses: [
            { id: 'a', status: 200, body: 1 },
            { id: 'b', status: 429, headers: { 'Retry-After': '3' }, body: {} },
          ],
        },
      },
      { status: 200, body: { responses: [{ id: 'b', status: 200, body: 2 }] } },
    ]);
    const out = await g.batch([
      { id: 'a', path: '/users/a' },
      { id: 'b', path: '/users/b' },
    ]);
    expect(out).toEqual({ a: { status: 200, body: 1 }, b: { status: 200, body: 2 } });
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(jsonBody<{ requests: Array<{ id: string }> }>(f.calls[1]!).requests.map((r) => r.id)).toEqual([
      'b',
    ]);
  });
  // Bug fix: one beta item used to send the whole chunk to /beta.
  it('sends v1.0 and beta items in separate batches', async () => {
    const reply = (id: string) => ({ status: 200, body: { responses: [{ id, status: 200, body: {} }] } });
    const { g, f } = client([reply('v'), reply('b')]);
    await g.batch([
      { id: 'v', path: '/users' },
      { id: 'b', path: '/users', beta: true },
    ]);
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://graph.microsoft.com/v1.0/$batch',
      'https://graph.microsoft.com/beta/$batch',
    ]);
  });
  it('decodes base64 text/plain sub-responses such as $count', async () => {
    const { g } = client([
      {
        status: 200,
        body: {
          responses: [
            { id: 'n', status: 200, headers: { 'Content-Type': 'text/plain' }, body: btoa('12408') },
          ],
        },
      },
    ]);
    expect((await g.batch([{ id: 'n', path: '/users/$count' }])).n).toEqual({ status: 200, body: 12408 });
    expect(decodeBatchBody({ headers: { 'content-type': 'text/plain' }, body: '42' })).toBe(42);
    expect(decodeBatchBody({ headers: { 'content-type': 'application/json' }, body: 'aGk=' })).toBe('aGk=');
  });
  it('sends $batch sub-request bodies with a JSON content type', async () => {
    const { g, f } = client([{ status: 200, body: { responses: [{ id: 'p', status: 204, body: null }] } }]);
    await g.batch([{ id: 'p', method: 'patch', path: '/users/1', body: { accountEnabled: false } }]);
    expect(jsonBody(f.calls[0]!)).toEqual({
      requests: [
        {
          id: 'p',
          method: 'PATCH',
          url: '/users/1',
          body: { accountEnabled: false },
          headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en-US' },
        },
      ],
    });
  });
  // Bug fix: POST/PATCH were retried on 5xx, which can repeat a write the service already applied.
  it('does not retry writes on 5xx but does retry reads', async () => {
    const w = client([{ status: 502 }, { status: 200, body: {} }]);
    await expect(w.g.request({ method: 'PATCH', path: '/users/1', body: {} })).rejects.toMatchObject({
      status: 502,
    });
    expect(w.f.calls).toHaveLength(1);
    const r = client([{ status: 502 }, { status: 200, body: { ok: 1 } }]);
    await expect(r.g.request({ path: '/users' })).resolves.toMatchObject({ data: { ok: 1 } });
    expect(r.f.calls).toHaveLength(2);
  });
  it('retries a read-only $batch on 5xx but not a batch that writes', async () => {
    const reply = { status: 200, body: { responses: [{ id: 'x', status: 200, body: {} }] } };
    const read = client([{ status: 503 }, reply]);
    await read.g.batch([{ id: 'x', path: '/users' }]);
    expect(read.f.calls).toHaveLength(2);
    const write = client([{ status: 500 }, reply]);
    await expect(write.g.batch([{ id: 'x', method: 'DELETE', path: '/groups/1' }])).rejects.toMatchObject({
      status: 500,
    });
    expect(write.f.calls).toHaveLength(1);
  });
});
