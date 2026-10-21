import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { MemoryNewsStore } from '@adminforge/api/src/news/memory-store';
import { SqliteNewsStore } from '@adminforge/api/src/news/sqlite-store';
import { contentHash } from '@adminforge/api/src/news/service';
import type { NewsFilter, NewsItemInput, NewsStore } from '@adminforge/api/src/news/types';
import { testDatabasePath } from './db';

// The SQLite news store answers exactly like the memory store (breaking in SQL included), and another process's
// connection to the same file (a scheduler one-shot fetching feeds) can use the news tables.
const file = await testDatabasePath();
const T0 = Date.parse('2026-10-15T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const now = new Date(T0);

function item(i: number, over: Partial<NewsItemInput> = {}): NewsItemInput {
  const base = {
    feedKey: over.feedKey ?? 'feeds.a',
    externalId: `x${i}`,
    title: `Item ${i} ${i % 2 ? 'Exchange' : 'Azure'} 100%_done`,
    summary: 'Summary',
    url: 'https://azure.microsoft.com/updates',
    kind: 'change' as const,
    severity: 'normal' as const,
    areas: [i % 2 ? 'm365' : 'azure'] as NewsItemInput['areas'],
    tags: i % 3 ? [] : ['exchange'],
    status: null,
    audience: [] as NewsItemInput['audience'],
    publishedAt: new Date(T0 - i * D),
    updatedAt: null,
    activityAt: new Date(T0 - i * D),
    actionRequiredBy: null,
    facts: [{ label: 'Published', value: 'x' }],
    ...over,
  };
  const { contentHash: _h, ...rest } = { ...base, contentHash: '' };
  return { ...rest, contentHash: contentHash(rest) };
}

const fixtures = (): Array<[string, NewsItemInput[]]> => [
  [
    'feeds.a',
    [
      ...Array.from({ length: 8 }, (_, i) => item(i)),
      item(20, {
        kind: 'incident',
        status: 'active',
        activityAt: new Date(T0 - 40 * D),
        publishedAt: new Date(T0 - 40 * D),
      }),
      item(21, {
        kind: 'security',
        severity: 'high',
        activityAt: new Date(T0 - 2 * D - H),
        publishedAt: new Date(T0 - 2 * D - H),
      }),
      item(22, {
        actionRequiredBy: new Date(T0 + 5 * D),
        activityAt: new Date(T0 - 5 * D - H),
        publishedAt: new Date(T0 - 5 * D - H),
      }),
      item(23, {
        kind: 'maintenance',
        status: 'active',
        actionRequiredBy: new Date(T0 + 2 * D),
        activityAt: new Date(T0 - 60 * D),
        publishedAt: new Date(T0 - 60 * D),
      }),
    ],
  ],
  ['feeds.b', [item(30, { feedKey: 'feeds.b', audience: ['Portal.Admin'] })]],
];

describe('SqliteNewsStore (SQLite)', () => {
  let database: Database;
  let news: SqliteNewsStore;
  let mem: MemoryNewsStore;

  beforeAll(() => {
    database = createDatabase(file);
    news = new SqliteNewsStore(database);
  });
  beforeEach(async () => {
    database.sqlite.exec('delete from news_items; delete from news_feed_state;');
    mem = new MemoryNewsStore();
    for (const s of [news, mem] as NewsStore[])
      for (const [k, items] of fixtures()) await s.upsert(k, items, now);
  });
  afterAll(async () => {
    await database?.close();
  });

  const strip = (rows: Array<{ externalId: string }>) => rows.map((r) => r.externalId);
  const filters: Array<[string, Partial<NewsFilter>]> = [
    ['everything a reader may see', {}],
    ['admins', { roles: ['Portal.Reader', 'Portal.Admin'] }],
    ['area', { area: 'm365' }],
    ['kind', { kind: 'incident' }],
    ['tag', { tag: 'exchange' }],
    ['feed', { feed: 'feeds.a' }],
    ['feeds', { feeds: ['feeds.b'], roles: ['Portal.Reader', 'Portal.Admin'] }],
    ['text (literal % and _)', { q: '100%_d' }],
    ['text, no match', { q: '%x%' }],
    ['days', { days: 3 }],
    ['breaking', { breaking: true }],
    ['not breaking', { breaking: false }],
    ['changed after', { changedAfter: new Date(T0 - 2 * D - 1) }],
  ];

  it.each(filters)('list and count agree with the memory store: %s', async (_name, f) => {
    const filter: NewsFilter = { roles: ['Portal.Reader'], now, ...f };
    const a = await news.list(filter, { limit: 100 });
    const b = await mem.list(filter, { limit: 100 });
    expect(strip(a)).toEqual(strip(b));
    expect(await news.count(filter, 99)).toBe(await mem.count(filter, 99));
  });

  it('pages with the keyset cursor and round-trips every field', async () => {
    const filter: NewsFilter = { roles: ['Portal.Reader'], now };
    const p1 = await news.list(filter, { limit: 4 });
    const last = p1.at(-1)!;
    const p2 = await news.list(filter, { limit: 100, after: { activityAt: last.activityAt, id: last.id } });
    expect(strip([...p1, ...p2])).toEqual(strip(await mem.list(filter, { limit: 100 })));
    const one = await news.get(p1[0]!.id, ['Portal.Reader']);
    expect(one).toMatchObject({
      feedKey: 'feeds.a',
      facts: [{ label: 'Published', value: 'x' }],
      areas: ['azure'],
    });
    const admins = (
      await news.list({ roles: ['Portal.Reader', 'Portal.Admin'], now, feed: 'feeds.b' }, { limit: 1 })
    )[0]!;
    expect(await news.get(admins.id, ['Portal.Reader'])).toBeNull();
    expect(Object.fromEntries(await news.countByFeed(['Portal.Reader']))).toEqual({ 'feeds.a': 12 });
    expect((await news.newestByFeed(['Portal.Reader'])).get('feeds.a')?.toISOString()).toBe(
      now.toISOString(),
    );
  });

  it('upsert: unchanged items only refresh last_seen; changed ones move changed_at; first sighting uses the item date', async () => {
    const later = new Date(T0 + H);
    const before = (
      await news.list({ roles: ['Portal.Reader'], now, feed: 'feeds.a', q: 'Item 1 ' }, { limit: 1 })
    )[0]!;
    expect(before.changedAt.toISOString()).toBe(new Date(T0 - D).toISOString());
    const r = await news.upsert('feeds.a', [item(1), item(2, { title: 'Item 2 renamed' }), item(9)], later);
    expect(r).toEqual({ inserted: 1, updated: 1 });
    const rows = await news.list({ roles: ['Portal.Reader'], now: later }, { limit: 100 });
    const by = (id: string) => rows.find((x) => x.externalId === id)!;
    expect(by('x1')).toMatchObject({ lastSeenAt: later, changedAt: new Date(T0 - D) });
    expect(by('x2')).toMatchObject({ title: 'Item 2 renamed', changedAt: later });
    expect(by('x9').firstSeenAt).toEqual(later);
  });

  it('feed state round-trips; retention keeps unresolved incidents still listed in the last 30 days, then drops them', async () => {
    const state = {
      feedKey: 'feeds.a',
      lastRunAt: now,
      lastSuccessAt: now,
      status: 'ok' as const,
      errorCode: null,
      errorMessage: null,
      etag: '"e"',
      lastModified: null,
      items: 12,
      newItems: 12,
      updatedItems: 0,
      durationMs: 5,
      definitionSha: 'abc',
      note: 'a note',
    };
    await news.saveState(state);
    expect(await news.getState('feeds.a')).toEqual(state);
    expect(await news.listStates()).toHaveLength(1);
    const policy = (days: number, at: number) => ({
      now: new Date(at),
      feeds: new Map([['feeds.a', days]]),
      orphanDays: 30,
    });
    expect(await news.prune(policy(7, T0 + 29 * D))).toBe(await mem.prune(policy(7, T0 + 29 * D)));
    const left = strip(await news.list({ roles: ['Portal.Reader', 'Portal.Admin'], now }, { limit: 100 }));
    // x30 belongs to a feed that's no longer defined: it goes 30 days after it was last seen.
    expect(left.sort()).toEqual(['x20', 'x30']);
    // Not listed by its source for more than 30 days: an incident whose resolution was never seen goes too.
    expect(await news.prune(policy(7, T0 + 31 * D))).toBe(await mem.prune(policy(7, T0 + 31 * D)));
    expect(strip(await news.list({ roles: ['Portal.Reader', 'Portal.Admin'], now }, { limit: 100 }))).toEqual(
      [],
    );
  });

  it('removes a feed’s items by external id, only in that feed, like the memory store', async () => {
    const ids = ['x1', 'x2', 'missing'];
    const before = await news.totalForFeed('feeds.a');
    expect(await news.remove('feeds.a', ids)).toBe(await mem.remove('feeds.a', ids));
    expect(await news.totalForFeed('feeds.a')).toBe(await mem.totalForFeed('feeds.a'));
    expect(await news.totalForFeed('feeds.a')).toBeLessThan(before);
    expect(await news.remove('feeds.a', [])).toBe(0);
  });

  describe('another process’s connection to the same file', () => {
    // A scheduler one-shot (`--once`) or the CLI opens its own connection; WAL lets it read and write while the API's
    // connection stays open, and each sees the other's committed rows.
    let other: Database;
    beforeAll(() => {
      other = createDatabase(file, { name: 'scheduler', pollSignals: false });
    });
    afterAll(async () => {
      await other?.close();
    });

    it('reads, writes and prunes news through the store', async () => {
      const store = new SqliteNewsStore(other);
      await store.upsert('feeds.c', [item(40, { feedKey: 'feeds.c' })], now);
      await store.saveState({
        feedKey: 'feeds.c',
        lastRunAt: now,
        lastSuccessAt: now,
        status: 'ok',
        errorCode: null,
        errorMessage: null,
        etag: null,
        lastModified: null,
        items: 1,
        newItems: 1,
        updatedItems: 0,
        durationMs: 1,
        definitionSha: null,
        note: null,
      });
      expect((await store.getState('feeds.c'))?.items).toBe(1);
      expect(await store.totalForFeed('feeds.c')).toBe(1);
      expect(await news.totalForFeed('feeds.c')).toBe(1);
      expect(
        await store.prune({ now: new Date(T0 + 400 * D), feeds: new Map(), orphanDays: 30 }),
      ).toBeGreaterThan(0);
    });
  });
});
