import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  azureEventToCandidate,
  azureServiceHealthLink,
  collectAzureServiceHealth,
  groupEvents,
} from '@adminforge/api/src/news/collectors/azure-service-health';
import { collectMessageCenter, messageToCandidate } from '@adminforge/api/src/news/collectors/message-center';
import {
  collectPsGallery,
  galleryVersions,
  galleryVersionsUrl,
} from '@adminforge/api/src/news/collectors/ps-gallery';
import { collectRss, rssKind } from '@adminforge/api/src/news/collectors/rss';
import {
  collectServiceHealth,
  issueToCandidate,
  SERVICE_HEALTH_LINK,
} from '@adminforge/api/src/news/collectors/service-health';
import type { CollectContext, CollectorDeps } from '@adminforge/api/src/news/collectors/shared';
import type { FeedFetchResult } from '@adminforge/api/src/news/fetch-feed';
import type { OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { Feed, isCitationUrl } from '@adminforge/schemas';

// Collectors turn each source's own shape into candidates: kind, severity, status, dates, links and facts.
const NOW = new Date('2026-10-15T12:00:00Z');
const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures');
const fixture = (rel: string) => JSON.parse(readFileSync(path.join(FIXTURES, rel), 'utf8'));

function feed(collector: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return Feed.parse({
    kind: 'feed',
    id: 'feeds.test',
    version: '1.0.0',
    title: 'Test',
    owner: 'test',
    publisher: 'Microsoft',
    homepage: 'https://admin.cloud.microsoft/?ref=MessageCenter',
    collector,
    defaultAreas: ['m365'],
    requires: { scopes: { graph: ['ServiceMessage.Read.All'] } },
    ...over,
  });
}

function deps(opts: { respond?: (call: ServiceCall) => unknown; feeds?: Record<string, string> } = {}) {
  const calls: ServiceCall[] = [];
  const fetched: string[] = [];
  const outbound = {
    async execute(_identity: unknown, call: ServiceCall) {
      calls.push(call);
      const data = await opts.respond?.(call);
      return { data, status: 200, provenance: {} };
    },
  } as unknown as OutboundExecutor;
  const d: CollectorDeps = {
    outbound,
    now: () => NOW,
    fetchFeed: async (url): Promise<FeedFetchResult> => {
      fetched.push(url);
      const hit = Object.entries(opts.feeds ?? {}).find(([k]) => url.includes(k));
      if (!hit) throw new Error(`no fake feed for ${url}`);
      return { status: 'ok', text: hit[1], etag: null, lastModified: null };
    },
  };
  return { d, calls, fetched };
}

const ctx = <C>(f: Feed): CollectContext =>
  ({ feedKey: 'feeds.test', feed: f, state: null, signal: new AbortController().signal }) as CollectContext &
    C;

describe('Message Center', () => {
  it('maps category, tags, severity, act-by date, services and the admin center link', () => {
    const c = messageToCandidate(
      {
        id: 'MC900001',
        title: 'Example retirement',
        category: 'PlanForChange',
        severity: 'High',
        tags: ['Retirement', 'Admin impact'],
        isMajorChange: true,
        services: ['Exchange Online'],
        startDateTime: '2026-10-12T17:00:00Z',
        lastModifiedDateTime: '2026-10-13T09:00:00Z',
        actionRequiredByDateTime: '2026-10-25T00:00:00Z',
        body: { contentType: 'html', content: '<p>Do <b>this</b>.</p>' },
        details: [{ name: 'RoadmapIds', value: '900001' }],
      },
      NOW,
    )!;
    expect(c).toMatchObject({
      externalId: 'MC900001',
      kind: 'retirement',
      severity: 'high',
      summary: 'Do this.',
      services: ['Exchange Online'],
      categories: ['Retirement', 'Admin impact'],
      tags: ['major-change'],
      audience: [],
      url: 'https://admin.cloud.microsoft/?ref=MessageCenter/:/messages/MC900001',
    });
    expect(isCitationUrl(c.url!)).toBe(true);
    expect(c.publishedAt.toISOString()).toBe('2026-10-12T17:00:00.000Z');
    expect(c.updatedAt?.toISOString()).toBe('2026-10-13T09:00:00.000Z');
    expect(c.actionRequiredBy?.toISOString()).toBe('2026-10-25T00:00:00.000Z');
    expect(c.facts).toContainEqual({ label: 'Roadmap ID', value: '900001' });
    expect(c.facts).toContainEqual({ label: 'Category', value: 'Plan for change' });
  });

  it('data-privacy messages need Portal.Admin (tag matched case-insensitively); new features and stay-informed', () => {
    const base = { id: 'MC1', title: 't', services: [], startDateTime: '2026-10-01T00:00:00Z' };
    expect(
      messageToCandidate({ ...base, category: 'stayInformed', tags: ['DATA PRIVACY'] }, NOW)!.audience,
    ).toEqual(['Portal.Admin']);
    expect(messageToCandidate({ ...base, category: 'stayInformed', tags: ['New feature'] }, NOW)!.kind).toBe(
      'feature',
    );
    expect(messageToCandidate({ ...base, category: 'preventOrFixIssue', tags: [] }, NOW)!.kind).toBe(
      'advisory',
    );
    expect(messageToCandidate({ ...base, category: 'stayInformed', tags: [] }, NOW)!.kind).toBe('info');
    expect(messageToCandidate({ id: '', title: 'x' }, NOW)).toBeNull();
  });

  it('asks Graph for messages changed since the last run (with an hour of overlap), as the automation identity', async () => {
    const t = deps({ respond: () => fixture('graph/v1.0/admin/serviceannouncement/messages/GET.json') });
    const f = feed({ kind: 'messageCenter', lookbackDays: 30 });
    const out = await collectMessageCenter(
      { ...ctx(f), state: { lastSuccessAt: new Date('2026-10-15T11:00:00Z') } as never } as never,
      t.d,
    );
    expect(t.calls[0]).toMatchObject({
      service: 'graph',
      method: 'GET',
      path: '/admin/serviceAnnouncement/messages',
      query: { $filter: 'lastModifiedDateTime ge 2026-10-15T10:00:00Z' },
      paging: 'all',
    });
    expect(out.candidates.length).toBeGreaterThan(5);
    expect(out.note).toBeUndefined();
  });

  it('falls back to an unfiltered read when Graph rejects the change filter, and says so', async () => {
    let first = true;
    const t = deps({
      respond: () => {
        if (first) {
          first = false;
          throw Object.assign(new Error('Invalid filter clause'), { status: 400 });
        }
        return {
          value: [
            {
              id: 'MC1',
              title: 'new',
              lastModifiedDateTime: '2026-10-15T00:00:00Z',
              startDateTime: '2026-10-15T00:00:00Z',
            },
            {
              id: 'MC2',
              title: 'old',
              lastModifiedDateTime: '2026-01-01T00:00:00Z',
              startDateTime: '2026-01-01T00:00:00Z',
            },
          ],
        };
      },
    });
    const out = await collectMessageCenter(
      ctx(feed({ kind: 'messageCenter', lookbackDays: 30 })) as never,
      t.d,
    );
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.query).not.toHaveProperty('$filter');
    expect(out.candidates.map((c) => c.externalId)).toEqual(['MC1']);
    expect(out.note).toMatch(/did not accept the change filter/);
  });
});

describe('Microsoft 365 service health', () => {
  it('maps incidents and advisories; isResolved → resolved; cites Service health with the issue id in the facts', async () => {
    const t = deps({ respond: () => fixture('graph/v1.0/admin/serviceannouncement/issues/GET.json') });
    const out = await collectServiceHealth(ctx(feed({ kind: 'serviceHealth' })) as never, t.d);
    expect(t.calls[0]!.query).toMatchObject({ $select: expect.stringContaining('isResolved') });
    const active = out.candidates.find((c) => c.externalId === 'TM912345')!;
    expect(active).toMatchObject({
      kind: 'incident',
      severity: 'high',
      status: 'active',
      services: ['Microsoft Teams'],
    });
    expect(active.url).toBe(SERVICE_HEALTH_LINK);
    expect(active.facts).toContainEqual({ label: 'Issue ID', value: 'TM912345' });
    expect(out.candidates.find((c) => c.externalId === 'EX907001')).toMatchObject({
      kind: 'advisory',
      status: 'resolved',
    });
    expect(
      issueToCandidate({ id: 'X', title: 'y', classification: 'Incident', isResolved: false }, NOW)!.kind,
    ).toBe('incident');
  });
});

describe('Azure Service Health', () => {
  const rows = fixture('resourceGraph/POST.json').$fixture.variants.find(
    (v: { match: { bodyIncludes: string } }) => v.match.bodyIncludes === 'af:news.azure-service-health',
  ).body.data as Array<Record<string, unknown>>;

  it('merges per-subscription copies by tracking id, keeping the newest, and counts subscriptions', () => {
    const groups = groupEvents(rows);
    const fx = groups.find((g) => g.properties.TrackingId === 'EXMP-0001')!;
    expect(fx.subscriptions).toBe(2);
    expect(fx.properties.LastUpdateTime).toBe('2026-10-15T09:10:00Z');
    const c = azureEventToCandidate(fx, NOW)!;
    expect(c).toMatchObject({
      kind: 'incident',
      severity: 'high',
      status: 'active',
      services: ['Azure Functions', 'App Service'],
    });
    expect(c.url).toBe('https://app.azure.com/h/EXMP-0001/aaa001');
    expect(c.facts).toContainEqual({ label: 'Regions', value: 'West Europe' });
    expect(c.facts).toContainEqual({ label: 'Subscriptions affected', value: '2' });
  });

  it('maps maintenance (act-by = start), retirement (sub-type), security (with a note on elevated access) and epoch-ms dates', () => {
    const by = Object.fromEntries(
      groupEvents(rows).map((g) => [g.properties.TrackingId as string, azureEventToCandidate(g, NOW)!]),
    );
    expect(by['EXMP-0002']).toMatchObject({ kind: 'maintenance' });
    expect(by['EXMP-0002']!.actionRequiredBy?.toISOString()).toBe('2026-10-17T22:00:00.000Z');
    expect(by['EXMP-0003']).toMatchObject({ kind: 'retirement' });
    expect(by['EXMP-0004']).toMatchObject({ kind: 'security', severity: 'high' });
    expect(by['EXMP-0004']!.facts.find((f) => f.label === 'Details')?.value).toMatch(
      /Service Health Security Reader/,
    );
    expect(by['EXMP-0005']).toMatchObject({ kind: 'incident', status: 'resolved' });
    expect(by['EXMP-0005']!.publishedAt.toISOString()).toBe(new Date(1791558000000).toISOString());
  });

  it('reads properties case-insensitively and falls back to the portal page for odd tracking ids', () => {
    const c = azureEventToCandidate(
      {
        properties: { trackingid: 'A B', title: 't', eventtype: 'serviceissue', status: 'Active' },
        subscriptionId: null,
        subscriptions: 1,
      },
      NOW,
    )!;
    expect(c.kind).toBe('incident');
    expect(c.url).toMatch(/^https:\/\/portal\.azure\.com\//);
    expect(azureServiceHealthLink('EXMP-1', 'abc')).toMatch(/portal\.azure\.com/);
  });

  it('runs one Resource Graph query with nothing interpolated, filters event types and age here', async () => {
    const t = deps({ respond: () => ({ value: rows, totalRecords: rows.length }) });
    const out = await collectAzureServiceHealth(
      ctx(
        feed(
          { kind: 'azureServiceHealth', eventTypes: ['ServiceIssue'], lookbackDays: 30 },
          { requires: { scopes: { arm: ['user_impersonation'] }, azureRoles: ['Reader'] } },
        ),
      ) as never,
      t.d,
    );
    expect(String((t.calls[0]!.body as { query: string }).query)).toContain('af:news.azure-service-health');
    expect(out.candidates.map((c) => c.externalId).sort()).toEqual(['EXMP-0001', 'EXMP-0005']);
  });
});

describe('RSS / Atom', () => {
  const xml = (items: string, title = 'Feed') =>
    `<rss version="2.0"><channel><title>${title}</title>${items}</channel></rss>`;
  const item = (
    guid: string,
    title: string,
    date: string,
    link = `https://azure.microsoft.com/updates?id=${guid}`,
  ) =>
    `<item><guid>${guid}</guid><link>${link}</link><title>${title}</title><description>d</description><pubDate>${date}</pubDate></item>`;
  const rss = (over: Record<string, unknown> = {}) =>
    feed({ kind: 'rss', url: 'https://www.microsoft.com/releasecommunications/api/v2/azure/rss', ...over });

  it('reads the kind from the title and categories', () => {
    expect(rssKind('Retirement: X', [])).toBe('retirement');
    expect(rssKind('Public Preview: X', [])).toBe('preview');
    expect(rssKind('Generally Available: X', [])).toBe('feature');
    expect(rssKind('CVE-2026-90001 Example', [])).toBe('security');
    expect(rssKind('X', ['Launched'])).toBe('feature');
    expect(rssKind('Added a property', [])).toBe('info');
  });

  it('returns every item within lookbackDays, newest first, one per id (newest revision)', async () => {
    const t = deps({
      feeds: {
        'azure/rss': xml(
          item('a', 'A rev 1', 'Mon, 13 Oct 2026 10:00:00 Z') +
            item('a', 'A rev 2', 'Tue, 14 Oct 2026 10:00:00 Z') +
            item('b', 'B', 'Wed, 15 Oct 2026 10:00:00 Z') +
            item('c', 'C', 'Thu, 01 Jan 2026 10:00:00 Z') +
            item('d', 'D', 'Sun, 12 Oct 2026 10:00:00 Z'),
        ),
      },
    });
    const out = await collectRss(ctx(rss({ maxItems: 2, lookbackDays: 30 })) as never, t.d);
    // maxItems is applied by the service after classification (news-max-items.test.ts), not here.
    expect(out.candidates.map((c) => [c.externalId, c.title])).toEqual([
      ['b', 'B'],
      ['a', 'A rev 2'],
      ['d', 'D'],
    ]);
  });

  it('linkPrefixes keeps only matching links; empty feeds and "Resource Not Found" channels are errors', async () => {
    const page = 'https://learn.microsoft.com/en-us/entra/fundamentals/whats-new';
    const t = deps({
      feeds: {
        'learn.microsoft.com': xml(
          item('1', 'Entra', 'Tue, 14 Oct 2026 10:00:00 Z', page) +
            item('2', 'Other', 'Tue, 14 Oct 2026 10:00:00 Z', 'https://learn.microsoft.com/en-us/other'),
        ),
        'board.id=nope': xml('', 'Resource Not Found'),
        empty: xml(''),
      },
    });
    const learn = rss({ url: 'https://learn.microsoft.com/api/search/rss?search=x', linkPrefixes: [page] });
    expect((await collectRss(ctx(learn) as never, t.d)).candidates.map((c) => c.externalId)).toEqual(['1']);
    const tc = rss({ url: 'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=nope' });
    await expect(collectRss(ctx(tc) as never, t.d)).rejects.toMatchObject({ code: 'feed_not_found' });
    const empty = rss({ url: 'https://developer.microsoft.com/empty' });
    await expect(collectRss(ctx(empty) as never, t.d)).rejects.toMatchObject({ code: 'feed_empty' });
    const allowed = rss({ url: 'https://developer.microsoft.com/empty', allowEmpty: true });
    await expect(collectRss(ctx(allowed) as never, t.d)).resolves.toMatchObject({ candidates: [] });
  });

  it('passes the previous validators and reports 304 as not modified', async () => {
    const seen: unknown[] = [];
    const d: CollectorDeps = {
      outbound: {} as never,
      now: () => NOW,
      fetchFeed: async (_url, o) => {
        seen.push(o);
        return { status: 'not_modified' };
      },
    };
    const out = await collectRss(
      { ...ctx(rss()), state: { etag: '"e"', lastModified: 'x' } as never } as never,
      d,
    );
    expect(out).toEqual({ notModified: true, candidates: [] });
    expect(seen[0]).toMatchObject({ etag: '"e"', lastModified: 'x' });
  });
});

describe('PowerShell Gallery', () => {
  it('builds the documented FindPackagesById query, re-checking the package id', () => {
    const url = new URL(galleryVersionsUrl('ExchangeOnlineManagement', 6));
    expect(url.origin + url.pathname).toBe('https://www.powershellgallery.com/api/v2/FindPackagesById()');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      id: "'ExchangeOnlineManagement'",
      $filter: 'IsPrerelease eq false',
      $orderby: 'Published desc',
      $top: '6',
      $select: 'Id,Version,Published,IsPrerelease,ReleaseNotes,GalleryDetailsUrl',
    });
    expect(new URL(galleryVersionsUrl('X', 2, true)).searchParams.has('$filter')).toBe(false);
    expect(() => galleryVersionsUrl("x' or 1 eq 1", 1)).toThrow(/invalid PowerShell Gallery package id/);
  });

  it('keeps listed stable versions, marks a new major version high, links the version page', async () => {
    const body = fixture('hosts/www.powershellgallery.com/api/v2/findpackagesbyid__/GET.json').$fixture
      .variants[0].body as string;
    expect(galleryVersions(body, 'ExchangeOnlineManagement').map((v) => v.version)).toEqual([
      '4.0.0',
      '4.0.0-Preview1',
      '3.9.2',
      '3.9.1',
    ]);
    const t = deps({ feeds: { ExchangeOnlineManagement: body } });
    const out = await collectPsGallery(
      ctx(
        feed(
          { kind: 'psGallery', packages: ['ExchangeOnlineManagement'], versions: 2 },
          { requires: undefined },
        ),
      ) as never,
      t.d,
    );
    expect(out.candidates.map((c) => [c.externalId, c.severity])).toEqual([
      ['ExchangeOnlineManagement@4.0.0', 'high'],
      ['ExchangeOnlineManagement@3.9.2', 'normal'],
    ]);
    expect(out.candidates[0]).toMatchObject({
      kind: 'release',
      services: ['ExchangeOnlineManagement'],
      tags: ['powershell', 'major-version'],
      url: 'https://www.powershellgallery.com/packages/ExchangeOnlineManagement/4.0.0',
    });
    expect(out.candidates[0]!.facts).toContainEqual({ label: 'Previous version', value: '3.9.2' });
  });
});
