import {
  citationLink,
  clampDates,
  collect,
  MAX_LINK_CHARS,
  sourceHosts,
} from '@adminforge/api/src/news/collectors/index';
import { messageToCandidate } from '@adminforge/api/src/news/collectors/message-center';
import { versionToCandidate } from '@adminforge/api/src/news/collectors/ps-gallery';
import type { CollectContext, CollectorDeps } from '@adminforge/api/src/news/collectors/shared';
import type { Candidate } from '@adminforge/api/src/news/types';
import { Feed } from '@adminforge/schemas';

// Rules every collected item passes, whatever the source: dates can't run ahead of the collection, citation links are
// normalised and short with no hidden characters, a public feed's items may only link back to the source itself, and
// Message Center data-privacy posts stay with Portal.Admin whichever way they are marked.
const NOW = new Date('2026-10-15T12:00:00Z');
const DAY = 86_400_000;

const rssFeed = (over: Record<string, unknown> = {}) =>
  Feed.parse({
    kind: 'feed',
    id: 'feeds.azure-updates',
    version: '1.0.0',
    title: 'Azure Updates',
    owner: 'test',
    publisher: 'Microsoft',
    homepage: 'https://azure.microsoft.com/updates',
    collector: { kind: 'rss', url: 'https://www.microsoft.com/releasecommunications/api/v2/azure/rss' },
    defaultAreas: ['azure'],
    ...over,
  });

const item = (guid: string, link: string, date = 'Wed, 14 Oct 2026 10:00:00 Z', updated?: string) =>
  `<item><guid>${guid}</guid><link>${link}</link><title>Item ${guid}</title><description>Text</description><pubDate>${date}</pubDate>${updated ? `<a10:updated xmlns:a10="http://www.w3.org/2005/Atom">${updated}</a10:updated>` : ''}</item>`;

function run(feed: Feed, items: string) {
  const deps: CollectorDeps = {
    outbound: {} as never,
    now: () => NOW,
    fetchFeed: async () => ({
      status: 'ok',
      text: `<rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`,
      etag: null,
      lastModified: null,
    }),
  };
  const ctx: CollectContext = {
    feedKey: feed.id,
    feed,
    state: null,
    signal: new AbortController().signal,
  };
  return collect(ctx, deps);
}

const byId = (cs: Candidate[]) => Object.fromEntries(cs.map((c) => [c.externalId, c]));

describe('item links come from the source itself', () => {
  it('keeps links on the feed host or the homepage host; anything else cites the homepage', async () => {
    const out = await run(
      rssFeed(),
      [
        item('home', 'https://azure.microsoft.com/updates?id=1'),
        item('feed', 'https://www.microsoft.com/releasecommunications/x'),
        item('upper', 'https://AZURE.microsoft.com/updates?id=2'),
        item('other', 'https://techcommunity.microsoft.com/t5/some-board/post'),
        item('forms', 'https://forms.office.com/r/abc'),
        item('sub', 'https://evil.azure.microsoft.com/updates'),
        item('http', 'http://azure.microsoft.com/updates?id=3'),
      ].join(''),
    );
    const c = byId(out.candidates);
    expect(c.home!.url).toBe('https://azure.microsoft.com/updates?id=1');
    expect(c.feed!.url).toBe('https://www.microsoft.com/releasecommunications/x');
    expect(c.upper!.url).toBe('https://azure.microsoft.com/updates?id=2');
    expect(c.other!.url).toBeNull();
    expect(c.forms!.url).toBeNull();
    expect(c.sub!.url).toBeNull();
    // Same host, so it is kept here; the service cites the homepage for anything that isn't an https citation URL.
    expect(c.http!.url).toBe('http://azure.microsoft.com/updates?id=3');
  });

  it('sourceHosts: rss → feed + homepage hosts, psGallery → gallery + homepage, tenant feeds → no host rule', () => {
    expect([...sourceHosts(rssFeed())!].sort()).toEqual(['azure.microsoft.com', 'www.microsoft.com']);
    const gallery = rssFeed({
      collector: { kind: 'psGallery', packages: ['MicrosoftTeams'] },
      homepage: 'https://www.powershellgallery.com',
    });
    expect([...sourceHosts(gallery)!]).toEqual(['www.powershellgallery.com']);
    const mc = rssFeed({
      collector: { kind: 'messageCenter' },
      homepage: 'https://admin.cloud.microsoft/#/MessageCenter',
      requires: { scopes: { graph: ['ServiceMessage.Read.All'] } },
    });
    expect(sourceHosts(mc)).toBeNull();
  });

  it('a gallery details link on another host is replaced by the gallery page of that version', () => {
    const c = versionToCandidate(
      {
        id: 'MicrosoftTeams',
        version: '8.0.0',
        published: NOW,
        prerelease: false,
        notes: '',
        link: 'https://techcommunity.microsoft.com/teams-module',
      },
      undefined,
    );
    expect(c.url).toBe('https://www.powershellgallery.com/packages/MicrosoftTeams/8.0.0');
  });
});

describe('citationLink', () => {
  const hosts = new Set(['learn.microsoft.com']);
  it('normalises and keeps a clean link', () => {
    expect(citationLink('  https://learn.microsoft.com/en-us/entra/whats-new  ', hosts)).toBe(
      'https://learn.microsoft.com/en-us/entra/whats-new',
    );
    expect(citationLink('https://learn.microsoft.com/a b', null)).toBeNull();
  });

  it.each([
    ['NUL', 'https://learn.microsoft.com/a\u0000b'],
    ['tab', 'https://learn.microsoft.com/a\tb'],
    ['newline', 'https://learn.microsoft.com/a\nb'],
    ['C1 control', 'https://learn.microsoft.com/a\u0085b'],
    ['bidi override', 'https://learn.microsoft.com/a\u202eb'],
    ['zero-width space', 'https://learn.microsoft.com/a\u200bb'],
    ['too long', `https://learn.microsoft.com/${'a'.repeat(MAX_LINK_CHARS)}`],
    ['not a URL', 'learn.microsoft.com/page'],
    ['empty', ''],
  ])('drops a link with %s', (_label, raw) => {
    expect(citationLink(raw, hosts)).toBeNull();
    expect(citationLink(raw, null)).toBeNull();
  });

  it('tenant links (no host rule) get the same length and character guard', () => {
    const long = messageToCandidate({ id: `MC${'1'.repeat(MAX_LINK_CHARS)}`, title: 'Long id' }, NOW)!;
    expect(citationLink(long.url, null)).toBeNull();
    const ok = messageToCandidate({ id: 'MC123456', title: 'Normal' }, NOW)!;
    expect(citationLink(ok.url, null)).toBe(ok.url);
  });
});

describe('dates can’t run ahead of the collection', () => {
  const base = (over: Partial<Candidate>): Candidate =>
    ({
      externalId: 'x',
      title: 'T',
      summary: '',
      url: null,
      kind: 'info',
      severity: 'normal',
      status: null,
      publishedAt: NOW,
      updatedAt: null,
      actionRequiredBy: null,
      services: [],
      categories: [],
      tags: [],
      audience: [],
      facts: [],
      ...over,
    }) as Candidate;

  it('a publish date more than a day ahead becomes now; up to a day ahead (time zones) is kept', () => {
    expect(clampDates(base({ publishedAt: new Date('2099-01-01T00:00:00Z') }), NOW).publishedAt).toEqual(NOW);
    const soon = new Date(NOW.getTime() + DAY - 60_000);
    expect(clampDates(base({ publishedAt: soon }), NOW).publishedAt).toEqual(soon);
  });

  it('an update date ahead is clamped, and dropped when it is no longer after the publish date', () => {
    const past = new Date(NOW.getTime() - 3 * DAY);
    expect(
      clampDates(base({ publishedAt: past, updatedAt: new Date('2099-01-01T00:00:00Z') }), NOW).updatedAt,
    ).toEqual(NOW);
    expect(
      clampDates(
        base({ publishedAt: new Date('2099-01-01T00:00:00Z'), updatedAt: new Date('2099-06-01T00:00:00Z') }),
        NOW,
      ).updatedAt,
    ).toBeNull();
  });

  it('deadlines are left as the source gave them', () => {
    const deadline = new Date('2027-06-30T00:00:00Z');
    expect(clampDates(base({ actionRequiredBy: deadline }), NOW).actionRequiredBy).toEqual(deadline);
  });

  it('applies to collected feed items', async () => {
    const out = await run(
      rssFeed(),
      item(
        'future',
        'https://azure.microsoft.com/updates?id=9',
        'Fri, 01 Jan 2099 10:00:00 Z',
        '2099-02-01T00:00:00Z',
      ),
    );
    const c = byId(out.candidates).future!;
    expect(c.publishedAt).toEqual(NOW);
    expect(c.updatedAt).toBeNull();
  });
});

describe('Message Center data privacy posts stay with Portal.Admin', () => {
  const msg = (over: Record<string, unknown>) =>
    messageToCandidate({ id: 'MC1', title: 'Post', ...over }, NOW)!;

  it.each([
    ['the documented tag', { tags: ['Data privacy'] }],
    ['another casing', { tags: ['DATA PRIVACY'] }],
    ['a tag mentioning privacy', { tags: ['Privacy'] }],
    ['a detail named for it', { details: [{ name: 'IsDataPrivacy', value: 'True' }] }],
    ['a detail value', { details: [{ name: 'Classification', value: ' Data privacy ' }] }],
  ])('%s', (_label, over) => {
    expect(msg(over).audience).toEqual(['Portal.Admin']);
  });

  it('other posts are for every reader', () => {
    expect(
      msg({ tags: ['Admin impact', 'New feature'], details: [{ name: 'Platforms', value: 'Web' }] }).audience,
    ).toEqual([]);
  });
});
