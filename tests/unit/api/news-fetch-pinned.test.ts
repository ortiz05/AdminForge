import { checkedConnectLookup, fetchFeed, FEED_DNS_TIMEOUT_MS } from '@adminforge/api/src/news/fetch-feed';

// DNS rebinding: the address checked before a feed request must be the address the socket connects to. On the real
// network feed requests go through an undici dispatcher whose sockets resolve with checkedConnectLookup, which refuses
// a host with any non-public address — so a name that answers "public" for the check and "loopback" for the connect is
// refused before a connection is made.
const URL_OK = 'https://www.microsoft.com/releasecommunications/api/v2/azure/rss';
const PUBLIC = async () => ['20.112.52.29'];

type Result = { err: NodeJS.ErrnoException | null; address: unknown; family?: number };
const run = (
  resolve: (h: string) => Promise<string[]>,
  options: Parameters<ReturnType<typeof checkedConnectLookup>>[1],
  timeoutMs?: number,
) =>
  new Promise<Result>((done) =>
    checkedConnectLookup(resolve, timeoutMs)('feed.example', options, (err, address, family) =>
      done({ err, address, family }),
    ),
  );

describe('checkedConnectLookup (the socket resolver for feed requests)', () => {
  it('answers in the shape the socket asked for: one address, or all of them', async () => {
    const both = async () => ['2603:1030:20e:3::23c', '20.112.52.29'];
    expect(await run(both, {})).toEqual({ err: null, address: '2603:1030:20e:3::23c', family: 6 });
    expect(await run(both, 4)).toEqual({ err: null, address: '20.112.52.29', family: 4 });
    expect(await run(both, { family: 4 })).toEqual({ err: null, address: '20.112.52.29', family: 4 });
    expect(await run(both, { all: true })).toEqual({
      err: null,
      address: [
        { address: '2603:1030:20e:3::23c', family: 6 },
        { address: '20.112.52.29', family: 4 },
      ],
      family: undefined,
    });
  });

  it.each([
    [['127.0.0.1']],
    [['20.112.52.29', '10.0.0.5']], // one private answer is enough to refuse
    [['::ffff:169.254.169.254']],
    [[]],
  ])('refuses %j before any connection is made', async (answers) => {
    const r = await run(async () => answers, { all: true });
    expect(r.err?.code).toBe('ERR_ADMINFORGE_NOT_PUBLIC');
    expect(r.address).toEqual([]);
  });

  it('refuses when no address of the requested family is left', async () => {
    const r = await run(async () => ['20.112.52.29'], 6);
    expect(r.err?.code).toBe('ERR_ADMINFORGE_NOT_PUBLIC');
  });

  it('passes resolver errors on, and gives up on a resolver that never answers', async () => {
    const nx = await run(
      async () => Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })),
      {},
    );
    expect(nx.err?.code).toBe('ENOTFOUND');
    const slow = await run(() => new Promise<string[]>(() => undefined), {}, 20);
    expect(slow.err?.code).toBe('ETIMEOUT');
    expect(FEED_DNS_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('fetchFeed through the pinned connection', () => {
  it('refuses a host that rebinds to loopback between the check and the connect (feed_not_allowed, not retried)', async () => {
    const lookups: string[] = [];
    const neverCalled = (async () => {
      throw new Error('the injected fetch must not be used on the pinned path');
    }) as unknown as typeof fetch;
    await expect(
      fetchFeed(URL_OK, {
        fetch: neverCalled,
        lookup: PUBLIC, // what the up-front check sees
        connectLookup: async (host) => {
          lookups.push(host);
          return ['127.0.0.1']; // what the socket would have connected to
        },
      }),
    ).rejects.toMatchObject({
      code: 'feed_not_allowed',
      message: expect.stringContaining('private, loopback or link-local'),
    });
    expect(lookups).toEqual(['www.microsoft.com']);
  });

  it('reports a name the socket cannot resolve as unreachable', async () => {
    await expect(
      fetchFeed(URL_OK, {
        fetch: globalThis.fetch,
        lookup: PUBLIC,
        connectLookup: async () => Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })),
      }),
    ).rejects.toMatchObject({ code: 'feed_unreachable' });
  });

  it('gives up on an up-front lookup that never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = fetchFeed(URL_OK, {
        fetch: (async () => new Response('<rss/>')) as unknown as typeof fetch,
        lookup: () => new Promise<string[]>(() => undefined),
      });
      const settled = expect(pending).rejects.toMatchObject({ code: 'feed_unreachable' });
      await vi.advanceTimersByTimeAsync(FEED_DNS_TIMEOUT_MS + 10);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
