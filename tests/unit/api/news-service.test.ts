import { isBreaking } from '@adminforge/api/src/news/breaking';
import type { CollectorDeps } from '@adminforge/api/src/news/collectors/shared';
import { MemoryNewsStore } from '@adminforge/api/src/news/memory-store';
import { decodeCursor, NewsService, normalise } from '@adminforge/api/src/news/service';
import type { Candidate, NewsItemRow } from '@adminforge/api/src/news/types';
import type { FeedFetchResult } from '@adminforge/api/src/news/fetch-feed';
import { Feed, NewsListQuery } from '@adminforge/schemas';
import { FakeDefinitions } from '../scheduler/helpers';

// The news service: collection bookkeeping (state, polling, errors), normalisation (links, audience, excerpts),
// "new" and "updated", breaking, unread, paging, feed statuses and retention — on the memory store.
const T0 = Date.parse('2026-10-15T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;

const rssFeed = (id: string, over: Record<string, unknown> = {}) =>
  Feed.parse({
    kind: 'feed',
    id,
    version: '1.0.0',
    title: `Feed ${id}`,
    owner: 'test',
    publisher: 'Microsoft',
    homepage: 'https://azure.microsoft.com/updates',
    collector: { kind: 'rss', url: `https://www.microsoft.com/${id}/rss` },
    defaultAreas: ['azure'],
    ...over,
  });

const xml = (items: Array<{ id: string; title: string; date: string; link?: string; desc?: string }>) =>
  `<rss version="2.0"><channel><title>x</title>${items
    .map(
      (i) =>
        `<item><guid>${i.id}</guid>${i.link === undefined ? `<link>https://azure.microsoft.com/updates?id=${i.id}</link>` : i.link ? `<link>${i.link}</link>` : ''}<title>${i.title}</title><description>${i.desc ?? 'Text'}</description><pubDate>${i.date}</pubDate></item>`,
    )
    .join('')}</channel></rss>`;

function setup() {
  let now = T0;
  const clock = () => new Date(now);
  const defs = new FakeDefinitions();
  const store = new MemoryNewsStore();
  const feeds: Record<string, () => FeedFetchResult | Promise<FeedFetchResult>> = {};
  const fetched: string[] = [];
  const collectors: CollectorDeps = {
    outbound: {} as never,
    now: clock,
    fetchFeed: async (url) => {
      fetched.push(url);
      const hit = Object.entries(feeds).find(([k]) => url.includes(`/${k}/`));
      if (!hit) throw new Error(`no fake feed for ${url}`);
      return hit[1]();
    },
  };
  const warnings: object[] = [];
  const service = new NewsService({
    store,
    definitions: defs as never,
    collectors,
    now: clock,
    log: { warn: (o) => warnings.push(o) },
  });
  return {
    service,
    store,
    defs,
    feeds,
    fetched,
    warnings,
    advance: (ms: number) => (now += ms),
    ok: (text: string) => () => ({ status: 'ok' as const, text, etag: null, lastModified: null }),
  };
}

const query = (q: Record<string, string> = {}) => NewsListQuery.parse(q);
const READER = { roles: ['Portal.Reader'], seenAt: null };

describe('normalise', () => {
  const c = (over: Partial<Candidate> = {}): Candidate => ({
    externalId: ' id-1 ',
    title: '<b>Title</b>',
    summary: 'word '.repeat(200),
    url: 'https://example.com/elsewhere',
    kind: 'info',
    severity: 'normal',
    status: null,
    publishedAt: new Date(T0),
    updatedAt: null,
    actionRequiredBy: null,
    services: [],
    categories: [],
    tags: [],
    audience: ['Portal.Admin'],
    facts: [],
    ...over,
  });

  it('cites the homepage when the link is not a Microsoft citation URL; cuts the excerpt; joins audiences', () => {
    const f = rssFeed('feeds.a', { requires: { portalRoles: ['Portal.Operator'] }, excerptChars: 100 });
    const n = normalise('feeds.a', f, c())!;
    expect(n.url).toBe('https://azure.microsoft.com/updates');
    expect(n.title).toBe('Title');
    expect(n.externalId).toBe('id-1');
    expect(n.summary.length).toBeLessThanOrEqual(100);
    expect(n.summary.endsWith('…')).toBe(true);
    expect(n.audience.sort()).toEqual(['Portal.Admin', 'Portal.Operator']);
    expect(normalise('feeds.a', f, c({ url: 'https://learn.microsoft.com/x' }))!.url).toBe(
      'https://learn.microsoft.com/x',
    );
    expect(normalise('feeds.a', f, c({ url: 'javascript:alert(1)' }))!.url).toBe(
      'https://azure.microsoft.com/updates',
    );
  });

  it('a rule status wins over the collector status; the hash changes with the content', () => {
    const f = rssFeed('feeds.a', { classify: [{ match: { title: ['Title'] }, status: 'Rolling out' }] });
    const a = normalise('feeds.a', f, c({ status: 'x' }))!;
    expect(a.status).toBe('Rolling out');
    expect(normalise('feeds.a', f, c({ summary: 'other' }))!.contentHash).not.toBe(a.contentHash);
    expect(normalise('feeds.a', f, c())!.contentHash).toBe(a.contentHash);
  });
});

describe('NewsService.refresh', () => {
  it('stores new items (changedAt = their own date, so history is not "new"), then counts updates', async () => {
    const t = setup();
    t.defs.set(rssFeed('feeds.a'));
    t.feeds['feeds.a'] = t.ok(
      xml([
        { id: '1', title: 'One', date: 'Tue, 14 Oct 2026 10:00:00 Z' },
        { id: '2', title: 'Two', date: 'Mon, 13 Oct 2026 10:00:00 Z' },
      ]),
    );
    expect(await t.service.refresh()).toMatchObject({
      feeds: 1,
      ok: 1,
      failed: 0,
      skipped: 0,
      new: 2,
      updated: 0,
    });
    const [first] = await t.store.list({ roles: ['Portal.Reader'], now: new Date(T0) }, { limit: 10 });
    expect(first!.changedAt.toISOString()).toBe('2026-10-14T10:00:00.000Z');

    t.advance(H);
    t.feeds['feeds.a'] = t.ok(
      xml([
        { id: '1', title: 'One (updated)', date: 'Tue, 14 Oct 2026 10:00:00 Z' },
        { id: '2', title: 'Two', date: 'Mon, 13 Oct 2026 10:00:00 Z' },
        { id: '3', title: 'Three', date: 'Wed, 15 Oct 2026 10:00:00 Z' },
      ]),
    );
    expect(await t.service.refresh()).toMatchObject({ new: 1, updated: 1 });
    const one = (await t.store.list({ roles: ['Portal.Reader'], now: new Date(T0) }, { limit: 10 })).find(
      (r) => r.externalId === '1',
    )!;
    expect(one.changedAt.getTime()).toBe(T0 + H);
    const state = await t.store.getState('feeds.a');
    expect(state).toMatchObject({ status: 'ok', items: 3, newItems: 1, updatedItems: 1, errorCode: null });
  });

  it('skips feeds that are not due (pollMinutes − 5 min), unless the job names them', async () => {
    const t = setup();
    t.defs.set(rssFeed('feeds.a')).set(rssFeed('feeds.b', { pollMinutes: 360 }));
    t.feeds['feeds.a'] = t.ok(xml([{ id: '1', title: 'A', date: 'Tue, 14 Oct 2026 10:00:00 Z' }]));
    t.feeds['feeds.b'] = t.ok(xml([{ id: '1', title: 'B', date: 'Tue, 14 Oct 2026 10:00:00 Z' }]));
    await t.service.refresh();
    t.advance(56 * 60_000);
    const r = await t.service.refresh();
    expect(r.results).toEqual([
      { key: 'feeds.a', status: 'ok', code: 'ok', new: 0, updated: 0 },
      { key: 'feeds.b', status: 'skipped', code: 'not_due', new: 0, updated: 0 },
    ]);
    expect(await t.service.refresh({ refs: ['feeds.b', 'feeds.gone'] })).toMatchObject({
      results: [
        { key: 'feeds.b', status: 'ok' },
        { key: 'feeds.gone', status: 'failed', code: 'feed_not_found' },
      ],
    });
  });

  it('records a failure with a sanitised reason, keeps the previous success, and logs no content', async () => {
    const t = setup();
    t.defs.set(rssFeed('feeds.a'));
    t.feeds['feeds.a'] = t.ok(xml([{ id: '1', title: 'One', date: 'Tue, 14 Oct 2026 10:00:00 Z' }]));
    await t.service.refresh();
    t.advance(H);
    t.feeds['feeds.a'] = t.ok('<!DOCTYPE x [<!ENTITY a "b">]><rss/>');
    expect(await t.service.refresh()).toMatchObject({
      ok: 0,
      failed: 1,
      results: [{ code: 'feed_unreadable' }],
    });
    const s = (await t.store.getState('feeds.a'))!;
    expect(s).toMatchObject({ status: 'error', errorCode: 'feed_unreadable', items: 1 });
    expect(s.lastSuccessAt?.getTime()).toBe(T0);
    expect(s.errorMessage).toMatch(/DTD/);
    expect(t.warnings).toEqual([{ feed: 'feeds.a', code: 'feed_unreadable' }]);

    t.feeds['feeds.a'] = () => {
      throw new TypeError('socket hang up at 10.1.2.3 token=abc');
    };
    t.advance(H);
    await t.service.refresh();
    const generic = (await t.store.getState('feeds.a'))!;
    expect(generic.errorCode).toBe('internal');
    expect(generic.errorMessage).not.toMatch(/token|10\.1\.2\.3/);
  });

  it('a changed definition collects without the previous validators; 304 keeps them', async () => {
    const t = setup();
    t.defs.set(rssFeed('feeds.a'));
    t.feeds['feeds.a'] = () => ({
      status: 'ok',
      text: xml([{ id: '1', title: 'A', date: 'Tue, 14 Oct 2026 10:00:00 Z' }]),
      etag: '"e1"',
      lastModified: null,
    });
    await t.service.refresh();
    t.advance(H);
    t.feeds['feeds.a'] = () => ({ status: 'not_modified' });
    expect(await t.service.refresh()).toMatchObject({ results: [{ code: 'not_modified' }] });
    expect((await t.store.getState('feeds.a'))!.etag).toBe('"e1"');
    t.defs.set(rssFeed('feeds.a', { version: '1.1.0', title: 'Renamed' }));
    expect((await t.service.activeFeeds())[0]!.feed.title).toBe('Renamed');
  });

  it('ignores draft and retired feeds and invalid definitions', async () => {
    const t = setup();
    t.defs.set(rssFeed('feeds.a', { status: 'draft' })).set(rssFeed('feeds.b', { status: 'retired' }));
    t.defs.set({ kind: 'feed', id: 'feeds.bad', version: '1.0.0' } as never);
    expect(await t.service.activeFeeds()).toEqual([]);
    expect(await t.service.refresh()).toMatchObject({ feeds: 0 });
  });
});

describe('reading news', () => {
  async function seeded() {
    const t = setup();
    t.defs.set(
      rssFeed('feeds.a', {
        classify: [{ match: { title: ['Exchange'] }, areas: ['m365'], tags: ['exchange'] }],
      }),
    );
    t.defs.set(rssFeed('feeds.admin', { requires: { portalRoles: ['Portal.Admin'] } }));
    t.feeds['feeds.a'] = t.ok(
      xml(
        Array.from({ length: 7 }, (_, i) => ({
          id: String(i),
          title: i === 0 ? 'Exchange retirement' : `Item ${i}`,
          date: new Date(T0 - i * D).toUTCString(),
        })),
      ),
    );
    t.feeds['feeds.admin'] = t.ok(
      xml([{ id: 'x', title: 'Admins only', date: new Date(T0 - H).toUTCString() }]),
    );
    await t.service.refresh();
    return t;
  }

  it('pages newest first with an opaque cursor, and filters by area, tag, text and days', async () => {
    const t = await seeded();
    const p1 = await t.service.list(READER, query({ limit: '3' }));
    expect(p1.items.map((i) => i.externalId)).toEqual(['0', '1', '2']);
    const p2 = await t.service.list(READER, query({ limit: '3', cursor: p1.nextCursor! }));
    expect(p2.items.map((i) => i.externalId)).toEqual(['3', '4', '5']);
    const p3 = await t.service.list(READER, query({ limit: '3', cursor: p2.nextCursor! }));
    expect(p3).toMatchObject({ items: [{ externalId: '6' }], nextCursor: null });
    expect((await t.service.list(READER, query({ area: 'm365' }))).items.map((i) => i.externalId)).toEqual([
      '0',
    ]);
    expect((await t.service.list(READER, query({ tag: 'exchange' }))).items).toHaveLength(1);
    expect((await t.service.list(READER, query({ q: 'ITEM 5' }))).items.map((i) => i.externalId)).toEqual([
      '5',
    ]);
    expect((await t.service.list(READER, query({ q: '%' }))).items).toHaveLength(0);
    expect((await t.service.list(READER, query({ days: '2' }))).items.map((i) => i.externalId)).toEqual([
      '0',
      '1',
      '2',
    ]);
    expect(() => decodeCursor('not-a-cursor')).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('hides items whose audience the reader lacks (list, get, summary counts)', async () => {
    const t = await seeded();
    const admin = { roles: ['Portal.Reader', 'Portal.Admin'], seenAt: null };
    expect((await t.service.list(READER, query())).items.some((i) => i.feed === 'feeds.admin')).toBe(false);
    const all = await t.service.list(admin, query());
    const secret = all.items.find((i) => i.feed === 'feeds.admin')!;
    expect(secret).toBeDefined();
    expect(await t.service.get(READER, secret.id)).toBeNull();
    expect(await t.service.get(admin, secret.id)).toMatchObject({ title: 'Admins only' });
    expect(await t.service.get(admin, 'not-a-uuid')).toBeNull();
    const s = await t.service.summary(READER, { showErrors: false });
    // A feed restricted to roles the reader lacks isn't listed among the sources either.
    expect(s.feeds.find((f) => f.key === 'feeds.admin')).toBeUndefined();
  });

  it('unread: changed after newsSeenAt (the last 7 days without one); updated items are unread again', async () => {
    const t = await seeded();
    const never = await t.service.summary(READER, { showErrors: false });
    expect(never.unread).toBe(7); // 0..6 days old (changedAt = their own date)
    const seen = { roles: ['Portal.Reader'], seenAt: new Date(T0 + 1) };
    expect((await t.service.summary(seen, { showErrors: false })).unread).toBe(0);
    t.advance(H);
    t.feeds['feeds.a'] = t.ok(
      xml([{ id: '3', title: 'Item 3 (changed)', date: new Date(T0 - 3 * D).toUTCString() }]),
    );
    await t.service.refresh({ refs: ['feeds.a'] });
    const after = await t.service.summary(seen, { showErrors: false });
    expect(after.unread).toBe(1);
    expect(
      (await t.service.list(seen, query({ unread: 'true' }))).items.map((i) => [i.externalId, i.unread]),
    ).toEqual([['3', true]]);
  });

  it('feed statuses: never / ok / stale / error (reason only for operators), newest item, quiet', async () => {
    const t = await seeded();
    t.defs.set(rssFeed('feeds.never', { quietAfterDays: 1 }));
    t.defs.set(
      rssFeed('feeds.a', {
        version: '1.0.1',
        quietAfterDays: 3,
        classify: [{ match: { title: ['Exchange'] }, areas: ['m365'] }],
      }),
    );
    let s = await t.service.summary(READER, { showErrors: false });
    const by = (k: string) => s.feeds.find((f) => f.key === k)!;
    expect(by('feeds.never')).toMatchObject({
      status: 'never',
      items: 0,
      newestAt: null,
      quiet: false,
      pollMinutes: 60,
    });
    expect(by('feeds.a')).toMatchObject({
      status: 'ok',
      items: 7,
      newestAt: new Date(T0).toISOString(),
      quiet: false,
    });
    expect(s.lastUpdatedAt).toBe(new Date(T0).toISOString());
    t.advance(4 * D);
    s = await t.service.summary(READER, { showErrors: false });
    expect(by('feeds.a')).toMatchObject({ status: 'stale', quiet: true });
    t.feeds['feeds.a'] = t.ok('nope');
    await t.service.refresh({ refs: ['feeds.a'] });
    s = await t.service.summary(READER, { showErrors: false });
    expect(by('feeds.a')).toMatchObject({ status: 'error', error: null });
    s = await t.service.summary(READER, { showErrors: true });
    expect(by('feeds.a').error).toMatchObject({
      code: 'feed_unreadable',
      message: expect.stringMatching(/not XML/),
    });
  });

  it('retention: per feed by age and last sighting; feeds no longer defined after 30 days', async () => {
    const t = await seeded();
    t.defs.set(rssFeed('feeds.a', { retentionDays: 7, classify: [] }));
    t.advance(5 * D);
    expect(await t.service.prune(new Date(T0 + 5 * D))).toBe(0);
    t.advance(5 * D);
    expect(await t.service.prune(new Date(T0 + 10 * D))).toBe(7);
    t.defs.remove('feed', 'feeds.admin');
    expect(await t.service.prune(new Date(T0 + 10 * D))).toBe(0);
    expect(await t.service.prune(new Date(T0 + 31 * D))).toBe(1);
  });
});

describe('breaking', () => {
  const now = new Date(T0);
  const item = (over: Partial<NewsItemRow>) =>
    ({
      kind: 'info',
      severity: 'normal',
      status: null,
      activityAt: now,
      actionRequiredBy: null,
      ...over,
    }) as NewsItemRow;
  const ago = (ms: number) => new Date(T0 - ms);
  const ahead = (ms: number) => new Date(T0 + ms);

  it.each([
    [{ kind: 'incident', status: 'active', activityAt: ago(13 * D) }, true],
    // An unresolved incident nobody has updated for two weeks (its resolution was never seen) stops being breaking.
    [{ kind: 'incident', status: 'active', activityAt: ago(60 * D) }, false],
    [{ kind: 'incident', status: 'resolved' }, false],
    [{ kind: 'security', severity: 'high', activityAt: ago(6 * D) }, true],
    [{ kind: 'security', severity: 'high', activityAt: ago(8 * D) }, false],
    [{ kind: 'security', severity: 'normal' }, false],
    [{ kind: 'retirement', severity: 'critical', activityAt: ago(2 * D) }, true],
    [{ kind: 'change', severity: 'high', activityAt: ago(4 * D) }, false],
    [{ kind: 'feature', severity: 'high' }, false],
    [{ kind: 'change', actionRequiredBy: ahead(10 * D), activityAt: ago(13 * D) }, true],
    [{ kind: 'change', actionRequiredBy: ahead(10 * D), activityAt: ago(15 * D) }, false],
    [{ kind: 'change', actionRequiredBy: ago(H) }, false],
    [{ kind: 'change', actionRequiredBy: ahead(20 * D) }, false],
    [
      { kind: 'maintenance', status: 'active', actionRequiredBy: ahead(2 * D), activityAt: ago(30 * D) },
      true,
    ],
    [
      { kind: 'maintenance', status: 'resolved', actionRequiredBy: ahead(2 * D), activityAt: ago(30 * D) },
      false,
    ],
  ] as Array<[Partial<NewsItemRow>, boolean]>)('%o → %s', (over, expected) => {
    expect(isBreaking(item(over), now)).toBe(expected);
  });
});
