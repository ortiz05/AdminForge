import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '@adminforge/api/src/app';
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { MemoryPreauthStore } from '@adminforge/api/src/auth/preauth-store';
import { MemorySessionStore } from '@adminforge/api/src/auth/session-store';
import { createTokenCache, MemorySealedBlobStore } from '@adminforge/api/src/auth/token-cache';
import { registryFrom } from '@adminforge/api/src/definitions/registry';
import { MemoryNewsStore } from '@adminforge/api/src/news/memory-store';
import { MemoryPrefsStore } from '@adminforge/api/src/prefs/prefs-store';
import { Feed, NewsItemDto, NewsListResponse, NewsSummaryResponse } from '@adminforge/schemas';
import { mockConfig, noNetwork, TEST_KEY } from './helpers';
import { ALL_ROLES, AVERY, FakeDefinitions, READER, schedulesApp } from './schedules-helpers';

// /api/news*: Portal.Reader for everything; items a reader's roles don't cover are invisible; the reason a feed failed
// is for operators; friendly 400s; the read marker isn't audited and can't be in the future.
const T0 = Date.parse('2026-10-15T12:00:00Z');

const feed = (id: string, over: Record<string, unknown> = {}) =>
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

const xml = (n: number, prefix: string) =>
  `<rss version="2.0"><channel><title>x</title>${Array.from(
    { length: n },
    (_, i) =>
      `<item><guid>${prefix}${i}</guid><link>https://azure.microsoft.com/updates?id=${prefix}${i}</link><title>${prefix} ${i}</title><description>d</description><pubDate>${new Date(T0 - i * 3_600_000).toUTCString()}</pubDate></item>`,
  ).join('')}</channel></rss>`;

async function app() {
  const defs = new FakeDefinitions()
    .set(feed('feeds.public'))
    .set(feed('feeds.admins', { requires: { portalRoles: ['Portal.Admin'] } }))
    .set(feed('feeds.broken'));
  const bodies: Record<string, string> = {
    'feeds.public': xml(5, 'Public'),
    'feeds.admins': xml(1, 'Secret'),
    'feeds.broken': 'not xml',
  };
  const fetchFake = (async (url: string) => {
    const key = Object.keys(bodies).find((k) => url.includes(`/${k}/`));
    return new Response(key ? bodies[key] : 'missing', { status: key ? 200 : 404 });
  }) as unknown as typeof fetch;
  const t = await schedulesApp({
    defs,
    schedules: {
      news: { store: new MemoryNewsStore(), fetch: fetchFake, lookup: async () => ['20.112.52.29'] },
    },
  });
  await t.schedules.news.refresh();
  return t;
}

describe('News and changes API', () => {
  it('needs a session and Portal.Reader', async () => {
    const t = await app();
    expect((await t.app.inject({ method: 'GET', url: '/api/news' })).statusCode).toBe(401);
    const nobody = await t.login(READER, []);
    const res = await nobody.get('/api/news/summary');
    expect(res.statusCode).toBe(403);
    // Refused by the /api-wide Portal.Reader requirement before the route's own check.
    expect(res.json().error.message).toMatch(/needs the Portal.Reader role/);
    await t.close();
  });

  it('lists newest first with paging, hiding items the reader’s roles don’t cover', async () => {
    const t = await app();
    const reader = await t.login(READER, ['Portal.Reader']);
    const first = NewsListResponse.parse((await reader.get('/api/news?limit=3')).json());
    expect(first.items.map((i) => i.title)).toEqual(['Public 0', 'Public 1', 'Public 2']);
    const next = NewsListResponse.parse(
      (await reader.get(`/api/news?limit=3&cursor=${first.nextCursor}`)).json(),
    );
    expect(next).toMatchObject({ items: [{ title: 'Public 3' }, { title: 'Public 4' }], nextCursor: null });

    const admin = await t.login(AVERY, ALL_ROLES);
    const all = NewsListResponse.parse((await admin.get('/api/news')).json());
    const secret = all.items.find((i) => i.feed === 'feeds.admins')!;
    expect(secret).toMatchObject({
      title: 'Secret 0',
      publisher: 'Microsoft',
      feedTitle: 'Feed feeds.admins',
    });
    expect(NewsItemDto.parse((await admin.get(`/api/news/${secret.id}`)).json()).title).toBe('Secret 0');
    const hidden = await reader.get(`/api/news/${secret.id}`);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error).toMatchObject({ code: 'news_not_found', hint: expect.any(String) });
    expect((await reader.get('/api/news/not-an-id')).statusCode).toBe(404);
    await t.close();
  });

  it('answers bad filters with a sentence and a hint, never the validator output', async () => {
    const t = await app();
    const reader = await t.login(READER, ['Portal.Reader']);
    for (const q of ['area=nowhere', 'days=0', 'limit=500', 'kind=x', 'cursor=bogus']) {
      const res = await reader.get(`/api/news?${q}`);
      expect(res.statusCode).toBe(400);
      const err = res.json().error;
      expect(err.code).toBe('invalid_request');
      expect(err.hint).toBeTruthy();
      expect(JSON.stringify(err)).not.toMatch(/invalid_enum|too_small|too_big|"path"/);
    }
    await t.close();
  });

  it('summary: unread and breaking counts, feed statuses, the failure reason only for operators', async () => {
    const t = await app();
    const reader = await t.login(READER, ['Portal.Reader']);
    const s = NewsSummaryResponse.parse((await reader.get('/api/news/summary')).json());
    expect(s.unread).toBe(5);
    expect(s.seenAt).toBeNull();
    // feeds.admins needs Portal.Admin: a Reader doesn't see the feed at all, not even as an empty source.
    expect(s.feeds.map((f) => [f.key, f.status, f.items, f.error])).toEqual([
      ['feeds.broken', 'error', 0, null],
      ['feeds.public', 'ok', 5, null],
    ]);
    const operator = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator']);
    const op = NewsSummaryResponse.parse((await operator.get('/api/news/summary')).json());
    expect(op.feeds.find((f) => f.key === 'feeds.broken')!.error).toMatchObject({ code: 'feed_unreadable' });
    await t.close();
  });

  it('mark all as read: newsSeenAt is not audited, moves unread to zero, and can’t be in the future', async () => {
    const t = await app();
    const reader = await t.login(READER, ['Portal.Reader']);
    const before = t.audit.rows.length;
    const put = (newsSeenAt: string) =>
      t.app.inject({ method: 'PUT', url: '/api/me/prefs', headers: reader.headers, payload: { newsSeenAt } });
    expect((await put(new Date(T0).toISOString())).statusCode).toBe(200);
    expect(t.audit.rows.length).toBe(before);
    expect(NewsSummaryResponse.parse((await reader.get('/api/news/summary')).json())).toMatchObject({
      unread: 0,
      seenAt: new Date(T0).toISOString(),
    });
    const future = await put(new Date(T0 + 3_600_000).toISOString());
    expect(future.statusCode).toBe(400);
    expect(future.json().error.message).toMatch(/in the future/);
    expect((await put('yesterday')).statusCode).toBe(400);
    await t.close();
  });

  it('relays news.updated (counts only) to signed-in browsers', async () => {
    const t = await app();
    const seen: unknown[] = [];
    t.app.ctx.events.subscribe((e) => seen.push(e));
    t.schedules.events.publish({ type: 'news.updated', data: { new: 2, updated: 1 } });
    expect(seen).toContainEqual({ type: 'news.updated', data: { new: 2, updated: 1 } });
    await t.close();
  });
});

describe('News and changes in DATA_MODE=fixtures (whole collection against tests/fixtures)', () => {
  const tenant = { requires: { scopes: { graph: ['ServiceMessage.Read.All', 'ServiceHealth.Read.All'] } } };
  const defs = () =>
    new FakeDefinitions()
      .set(feed('feeds.mc', { ...tenant, collector: { kind: 'messageCenter' }, defaultAreas: ['m365'] }))
      .set(feed('feeds.sh', { ...tenant, collector: { kind: 'serviceHealth' }, defaultAreas: ['m365'] }))
      .set(
        feed('feeds.az', {
          requires: { scopes: { arm: ['user_impersonation'] }, azureRoles: ['Reader'] },
          collector: { kind: 'azureServiceHealth' },
        }),
      )
      .set(
        feed('feeds.azure-updates', {
          collector: { kind: 'rss', url: 'https://www.microsoft.com/releasecommunications/api/v2/azure/rss' },
        }),
      )
      .set(
        feed('feeds.roadmap', {
          collector: { kind: 'rss', url: 'https://www.microsoft.com/releasecommunications/api/v2/m365/rss' },
        }),
      )
      .set(
        feed('feeds.graph', {
          collector: { kind: 'rss', url: 'https://developer.microsoft.com/en-us/graph/changelog/rss' },
        }),
      )
      .set(
        feed('feeds.msrc', {
          collector: { kind: 'rss', url: 'https://api.msrc.microsoft.com/update-guide/rss' },
        }),
      )
      .set(
        feed('feeds.ps', {
          collector: {
            kind: 'psGallery',
            packages: ['ExchangeOnlineManagement', 'MicrosoftTeams', 'PnP.PowerShell'],
          },
          defaultAreas: ['platform'],
        }),
      );

  it('collects every collector kind from the fixtures, offline', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'af-news-'));
    const app = await buildApp(mockConfig({ ADMINFORGE_ARTIFACTS_DIR: dir }), {
      database: null,
      sessions: new MemorySessionStore(),
      preauth: new MemoryPreauthStore(),
      audit: new MemoryAuditWriter(),
      prefs: new MemoryPrefsStore(),
      tokenCache: createTokenCache(new MemorySealedBlobStore(), Buffer.from(TEST_KEY, 'base64')),
      fetch: noNetwork,
      now: () => new Date(T0),
      definitions: registryFrom(defs() as never, 'fs'),
      schedules: { inProcess: false },
    });
    await app.ready();
    const r = await app.schedules.news.refresh();
    expect(r.failed).toBe(0);
    expect(Object.fromEntries(r.results.map((x) => [x.key, x.new > 0]))).toEqual({
      'feeds.az': true,
      'feeds.azure-updates': true,
      'feeds.graph': true,
      'feeds.mc': true,
      'feeds.msrc': true,
      'feeds.ps': true,
      'feeds.roadmap': true,
      'feeds.sh': true,
    });
    const list = await app.schedules.news.list({ roles: ALL_ROLES, seenAt: null }, {
      days: 730,
      limit: 100,
    } as never);
    // The active Teams incident in the fixtures is always breaking.
    expect(list.items.find((i) => i.externalId === 'TM912345')).toMatchObject({
      kind: 'incident',
      breaking: true,
    });
    // A link to a non-Microsoft site is replaced by the feed's homepage.
    expect(
      list.items.every((i) =>
        /^https:\/\/[^/]*(microsoft\.com|azure\.com|cloud\.microsoft|powershellgallery\.com)\//.test(i.url),
      ),
    ).toBe(true);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
