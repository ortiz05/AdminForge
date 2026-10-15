import {
  ApiError,
  assertSafePath,
  buildUrl,
  cleanPath,
  createHttpClient,
  evaluate,
  isTransient,
  readBodyText,
  RESPONSE_TOO_LARGE,
} from '@adminforge/connectors';

// fetch's URL parser drops TAB/LF/CR and *then* resolves dot segments: `/users/.\t./.\t./applications` would pass a
// plain dot-segment check and still be sent as `/applications`.
describe('control characters in paths', () => {
  const sneaky = [
    '/users/.\t./.\t./applications',
    '/users/.\n./x',
    '/users/a\rb',
    '/users/\u0000',
    '/users/\u007f',
  ];

  it.each(sneaky)('assertSafePath rejects %j', (p) =>
    expect(() => assertSafePath(p)).toThrow(/Invalid Graph path/),
  );

  it('shows control characters as escapes in the error', () =>
    expect(() => buildUrl('https://g', { path: '/users/.\t./x' })).toThrow('/users/.\\t./x'));

  it.each(sneaky)('cleanPath (policy) rejects %j', (p) => expect(cleanPath(p)).toBeUndefined());

  it('the policy refuses them, $batch sub-requests included', () => {
    expect(
      evaluate('read', { service: 'graph', method: 'GET', path: '/users/.\t./.\t./applications' }),
    ).toEqual({
      allowed: false,
      reason: expect.stringMatching(/not a clean service path/),
    });
    expect(
      evaluate('read', {
        service: 'graph',
        method: 'POST',
        path: '/$batch',
        body: { requests: [{ id: '1', method: 'GET', url: '/users/.\t./.\t./applications' }] },
      }),
    ).toMatchObject({ allowed: false });
  });

  it('still accepts clean paths', () => {
    expect(cleanPath('/users/00000000-0000-4000-8000-000000000001/memberOf?$top=5')).toBe(
      '/users/00000000-0000-4000-8000-000000000001/memberOf',
    );
    expect(() => assertSafePath("/sites/root/lists('a b')")).not.toThrow();
  });
});

describe('response size cap (streamed)', () => {
  const big = (bytes: number, headers: Record<string, string> = {}) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (let sent = 0; sent < bytes; sent += 1024)
            c.enqueue(new Uint8Array(Math.min(1024, bytes - sent)).fill(97));
          c.close();
        },
      }),
      { headers: { 'content-type': 'text/plain', ...headers } },
    );

  it('reads bodies under the limit', async () => {
    expect(await readBodyText(new Response('héllo'), 100)).toEqual({ text: 'héllo', truncated: false });
  });

  it('refuses a body over the limit without reading the rest', async () => {
    const err = (await readBodyText(big(10_000), 4096, { url: 'https://graph.microsoft.com/v1.0/x' }).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(RESPONSE_TOO_LARGE);
    expect(err.message).toContain('graph.microsoft.com');
    // Never retried: the same request would be just as large.
    expect(isTransient(err)).toBe(false);
  });

  it('refuses up front when Content-Length is over the limit', async () => {
    await expect(
      readBodyText(new Response('x', { headers: { 'content-length': '999999999' } }), 4096),
    ).rejects.toMatchObject({ code: RESPONSE_TOO_LARGE });
  });

  it('truncates instead when asked (probes looking for a marker)', async () => {
    const r = await readBodyText(big(10_000), 4096, { onLimit: 'truncate' });
    expect(r).toMatchObject({ truncated: true });
    expect(r.text).toHaveLength(4096);
  });

  it('the HTTP client applies maxResponseBytes to every response', async () => {
    const http = createHttpClient({
      getToken: async () => 't',
      fetch: async () => big(5000),
      maxResponseBytes: 2048,
      maxRetries: 0,
    });
    await expect(http.send({ url: 'https://management.azure.com/x' })).rejects.toMatchObject({
      status: 502,
      code: RESPONSE_TOO_LARGE,
    });
    const ok = createHttpClient({
      getToken: async () => 't',
      fetch: async () => big(1000),
      maxResponseBytes: 2048,
    });
    expect((await ok.send({ url: 'https://management.azure.com/x' })).data).toHaveLength(1000);
  });
});
