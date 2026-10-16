import { fetchFeed, FEED_MAX_BYTES, FEED_USER_AGENT } from '@adminforge/api/src/news/fetch-feed';

// Public feeds: https on an allow-listed Microsoft host, public addresses only, redirects only within the list,
// bounded size, conditional GET, nothing about this installation in the request.
const PUBLIC = async () => ['20.112.52.29'];
const URL_OK = 'https://www.microsoft.com/releasecommunications/api/v2/azure/rss';

function fakeFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('fetchFeed', () => {
  it('GETs an allow-listed https feed with a fixed User-Agent, gzip and the previous validators', async () => {
    const f = fakeFetch([
      () =>
        new Response('<rss/>', {
          status: 200,
          headers: { etag: '"e2"', 'last-modified': 'Wed, 15 Oct 2026 06:00:00 GMT' },
        }),
    ]);
    const r = await fetchFeed(
      URL_OK,
      { fetch: f.fn, lookup: PUBLIC },
      { etag: '"e1"', lastModified: 'Tue, 14 Oct 2026 06:00:00 GMT' },
    );
    expect(r).toEqual({
      status: 'ok',
      text: '<rss/>',
      etag: '"e2"',
      lastModified: 'Wed, 15 Oct 2026 06:00:00 GMT',
    });
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      'user-agent': FEED_USER_AGENT,
      'accept-encoding': 'gzip',
      'if-none-match': '"e1"',
      'if-modified-since': 'Tue, 14 Oct 2026 06:00:00 GMT',
    });
    expect(Object.keys(headers)).not.toContain('cookie');
    expect(f.calls[0]!.init.redirect).toBe('manual');
  });

  it('304 means unchanged', async () => {
    const f = fakeFetch([() => new Response(null, { status: 304 })]);
    await expect(fetchFeed(URL_OK, { fetch: f.fn, lookup: PUBLIC }, { etag: '"e1"' })).resolves.toEqual({
      status: 'not_modified',
    });
  });

  it.each([
    ['http://www.microsoft.com/feed', 'http'],
    ['https://evil.example.com/rss', 'host not on the list'],
    ['https://www.microsoft.com:8443/rss', 'non-default port'],
    ['https://user:pw@www.microsoft.com/rss', 'credentials'],
    ['https://www.microsoft.com.evil.example/rss', 'look-alike host'],
  ])('refuses %s (%s) without a request', async (url) => {
    const f = fakeFetch([]);
    await expect(fetchFeed(url, { fetch: f.fn, lookup: PUBLIC })).rejects.toMatchObject({
      code: 'feed_not_allowed',
    });
    expect(f.calls).toHaveLength(0);
  });

  it('refuses an allow-listed host that resolves to a private or metadata address', async () => {
    for (const addr of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '::1', 'fd00::1']) {
      const f = fakeFetch([]);
      await expect(fetchFeed(URL_OK, { fetch: f.fn, lookup: async () => [addr] })).rejects.toMatchObject({
        code: 'feed_not_allowed',
      });
      expect(f.calls).toHaveLength(0);
    }
  });

  it('follows redirects only to allow-listed https hosts, at most 3, without the validators', async () => {
    const hop = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
    const ok = fakeFetch([
      hop('https://developer.microsoft.com/en-us/graph/changelog/rss'),
      () => new Response('<rss/>'),
    ]);
    await expect(fetchFeed(URL_OK, { fetch: ok.fn, lookup: PUBLIC }, { etag: '"e"' })).resolves.toMatchObject(
      { status: 'ok' },
    );
    expect(ok.calls[1]!.url).toBe('https://developer.microsoft.com/en-us/graph/changelog/rss');
    expect(ok.calls[1]!.init.headers).not.toHaveProperty('if-none-match');

    const off = fakeFetch([hop('https://evil.example.com/x')]);
    await expect(fetchFeed(URL_OK, { fetch: off.fn, lookup: PUBLIC })).rejects.toMatchObject({
      code: 'feed_not_allowed',
    });
    expect(off.calls).toHaveLength(1);

    const down = fakeFetch([hop('http://www.microsoft.com/rss')]);
    await expect(fetchFeed(URL_OK, { fetch: down.fn, lookup: PUBLIC })).rejects.toMatchObject({
      code: 'feed_not_allowed',
    });

    const loop = fakeFetch([hop(URL_OK), hop(URL_OK), hop(URL_OK), hop(URL_OK)]);
    await expect(fetchFeed(URL_OK, { fetch: loop.fn, lookup: PUBLIC })).rejects.toThrow(/more than 3 times/);
    expect(loop.calls).toHaveLength(4);
  });

  it('stops reading at the size cap', async () => {
    const big = new Uint8Array(FEED_MAX_BYTES + 1);
    const declared = fakeFetch([
      () => new Response(big, { headers: { 'content-length': String(big.length) } }),
    ]);
    await expect(fetchFeed(URL_OK, { fetch: declared.fn, lookup: PUBLIC })).rejects.toMatchObject({
      code: 'feed_too_large',
    });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 9; i++) c.enqueue(new Uint8Array(1024 * 1024));
        c.close();
      },
    });
    const streamed = fakeFetch([() => new Response(stream)]);
    await expect(fetchFeed(URL_OK, { fetch: streamed.fn, lookup: PUBLIC })).rejects.toMatchObject({
      code: 'feed_too_large',
    });
  });

  it('reports HTTP errors and network failures with a code a person can act on', async () => {
    const gone = fakeFetch([() => new Response('nope', { status: 404 })]);
    await expect(fetchFeed(URL_OK, { fetch: gone.fn, lookup: PUBLIC })).rejects.toMatchObject({
      code: 'feed_failed',
      extras: { hint: expect.stringMatching(/moved/) },
    });
    const down = fakeFetch([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    await expect(fetchFeed(URL_OK, { fetch: down.fn, lookup: PUBLIC })).rejects.toMatchObject({
      code: 'feed_unreachable',
    });
    await expect(
      fetchFeed(URL_OK, { fetch: down.fn, lookup: async () => Promise.reject(new Error('ENOTFOUND')) }),
    ).rejects.toMatchObject({ code: 'feed_unreachable' });
  });
});
