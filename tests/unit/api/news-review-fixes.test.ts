import { isBreaking } from '@adminforge/api/src/news/breaking';
import type { CollectorDeps } from '@adminforge/api/src/news/collectors/shared';
import { MemoryNewsStore } from '@adminforge/api/src/news/memory-store';
import { NewsService, normalise } from '@adminforge/api/src/news/service';
import type { Candidate } from '@adminforge/api/src/news/types';
import { AppError } from '@adminforge/api/src/errors';
import { Feed, NewsListQuery } from '@adminforge/schemas';
import { FakeDefinitions } from '../scheduler/helpers';

// Security review follow-ups for News and changes: a feed's portal roles apply at read time, collection order and
// the time budget keep slow feeds from starving the rest, unresolved incidents stop being "breaking" when the source
// goes quiet, citation links are normalised, and an automation-identity refusal explains the application permission.
const T0 = Date.parse('2026-10-15T12:00:00Z');
const D = 86_400_000;

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

const rss = (id: string) =>
  `<rss version="2.0"><channel><title>x</title><item><guid>${id}</guid><link>https://azure.microsoft.com/updates?id=${id}</link><title>Item ${id}</title><description>Text</description><pubDate>Tue, 14 Oct 2026 10:00:00 Z</pubDate></item></channel></rss>`;

function setup(opts: { feedTimeoutMs?: number; outbound?: CollectorDeps['outbound'] } = {}) {
  const defs = new FakeDefinitions();
  const store = new MemoryNewsStore();
  const fetched: string[] = [];
  const collectors: CollectorDeps = {
    outbound: opts.outbound ?? ({} as never),
    now: () => new Date(T0),
    fetchFeed: async (url) => {
      fetched.push(url);
      return { status: 'ok', text: rss(url.split('/')[3]!), etag: null, lastModified: null };
    },
  };
  const service = new NewsService({
    store,
    definitions: defs as never,
    collectors,
    now: () => new Date(T0),
    ...(opts.feedTimeoutMs ? { feedTimeoutMs: opts.feedTimeoutMs } : {}),
  });
  return { defs, store, service, fetched };
}

describe('a feed’s requires.portalRoles at read time', () => {
  it('hides items stored before the feed was restricted, in list, get and summary', async () => {
    const t = setup();
    t.defs.set(rssFeed('feeds.a'));
    await t.service.refresh();
    const reader = { roles: ['Portal.Reader'], seenAt: null };
    const [item] = (await t.service.list(reader, NewsListQuery.parse({}))).items;
    expect(item).toBeDefined();

    // The definition now needs Portal.Operator; the stored items still carry an empty audience.
    t.defs.set(rssFeed('feeds.a', { version: '1.1.0', requires: { portalRoles: ['Portal.Operator'] } }));
    expect((await t.service.list(reader, NewsListQuery.parse({}))).items).toEqual([]);
    expect(await t.service.get(reader, item!.id)).toBeNull();
    const summary = await t.service.summary(reader, { showErrors: false });
    expect(summary.feeds).toEqual([]);
    expect(summary.unread).toBe(0);

    const operator = { roles: ['Portal.Reader', 'Portal.Operator'], seenAt: null };
    expect((await t.service.list(operator, NewsListQuery.parse({}))).items).toHaveLength(1);
  });
});

describe('collection order and budget', () => {
  it('collects the feeds longest without a success first', async () => {
    const t = setup();
    t.defs.set(rssFeed('feeds.a')).set(rssFeed('feeds.b'));
    await t.service.refresh({ refs: ['feeds.a'] });
    t.fetched.length = 0;
    await t.service.refresh({ refs: ['feeds.a', 'feeds.b'], concurrency: 1 });
    expect(t.fetched.map((u) => u.split('/')[3])).toEqual(['feeds.b', 'feeds.a']);
  });

  it('starts no feed that couldn’t finish inside the run’s budget', async () => {
    const t = setup({ feedTimeoutMs: 60_000 });
    t.defs.set(rssFeed('feeds.a'));
    const r = await t.service.refresh({ budgetMs: 30_000 });
    expect(r.results).toEqual([
      { key: 'feeds.a', status: 'skipped', code: 'out_of_time', new: 0, updated: 0 },
    ]);
    expect(t.fetched).toEqual([]);
    expect((await t.service.refresh({ budgetMs: 900_000 })).ok).toBe(1);
  });
});

describe('unresolved incidents', () => {
  const incident = (daysQuiet: number) => ({
    kind: 'incident' as const,
    severity: 'high' as const,
    status: 'investigating',
    activityAt: new Date(T0 - daysQuiet * D),
    actionRequiredBy: null,
  });
  it('are breaking while the source keeps updating them, not after two quiet weeks', () => {
    expect(isBreaking(incident(1), new Date(T0))).toBe(true);
    expect(isBreaking(incident(13), new Date(T0))).toBe(true);
    expect(isBreaking(incident(15), new Date(T0))).toBe(false);
    expect(isBreaking({ ...incident(1), status: 'resolved' }, new Date(T0))).toBe(false);
  });
});

describe('citation links', () => {
  const feed = rssFeed('feeds.a');
  const c = (url: string | null): Candidate => ({
    externalId: '1',
    title: 'Title',
    summary: 'Text',
    url,
    kind: 'info',
    severity: 'normal',
    status: null,
    services: [],
    categories: [],
    tags: [],
    audience: [],
    publishedAt: new Date(T0),
    updatedAt: null,
    actionRequiredBy: null,
    facts: [],
  });
  it('keeps the normalised link; control characters, over-long links and other domains cite the homepage', () => {
    expect(normalise('feeds.a', feed, c('https://AZURE.microsoft.com/updates?id=1'))!.url).toBe(
      'https://azure.microsoft.com/updates?id=1',
    );
    for (const bad of [
      'https://azure.microsoft.com/updates?id=1\t',
      'https://azure.microsoft.com/\u0000x',
      `https://azure.microsoft.com/${'a'.repeat(2100)}`,
      'https://example.com/updates',
      'javascript:alert(1)',
    ])
      expect(normalise('feeds.a', feed, c(bad))!.url).toBe('https://azure.microsoft.com/updates');
  });
});

describe('automation identity refusals', () => {
  it('name the application permission the tenant feed declares', async () => {
    const outbound = {
      execute: async () => {
        throw new AppError(403, 'upstream_forbidden', 'Forbidden', {
          hint: 'Ask for an Entra role or use PIM.',
        });
      },
    } as unknown as CollectorDeps['outbound'];
    const t = setup({ outbound });
    t.defs.set(
      Feed.parse({
        kind: 'feed',
        id: 'feeds.mc',
        version: '1.0.0',
        title: 'Message center',
        owner: 'test',
        publisher: 'Microsoft',
        homepage: 'https://admin.cloud.microsoft/?ref=MessageCenter',
        collector: { kind: 'messageCenter' },
        defaultAreas: ['m365'],
        requires: { scopes: { graph: ['ServiceMessage.Read.All'] } },
      }),
    );
    expect(await t.service.refresh()).toMatchObject({ failed: 1 });
    const state = await t.store.getState('feeds.mc');
    expect(state?.errorCode).toBe('upstream_forbidden');
    expect(state?.errorMessage).toContain(
      'automation identity needs Microsoft Graph ServiceMessage.Read.All',
    );
    expect(state?.errorMessage).not.toMatch(/PIM/);
  });
});

describe('tightened rules', () => {
  it('remove items the source still lists but the feed no longer keeps', async () => {
    const t = setup();
    t.defs.set(rssFeed('feeds.a'));
    await t.service.refresh();
    const reader = { roles: ['Portal.Reader'], seenAt: null };
    expect((await t.service.list(reader, NewsListQuery.parse({}))).items).toHaveLength(1);
    // A new rule drops the item: the next collection removes it instead of keeping it until retention.
    t.defs.set(
      rssFeed('feeds.a', { version: '1.1.0', classify: [{ match: { title: ['Item'] }, exclude: true }] }),
    );
    await t.service.refresh({ refs: ['feeds.a'] });
    expect((await t.service.list(reader, NewsListQuery.parse({}))).items).toEqual([]);
    expect(await t.store.totalForFeed('feeds.a')).toBe(0);
  });
});
