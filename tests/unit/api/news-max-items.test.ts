import type { CollectorDeps } from '@adminforge/api/src/news/collectors/shared';
import { MemoryNewsStore } from '@adminforge/api/src/news/memory-store';
import { NewsService } from '@adminforge/api/src/news/service';
import { Feed } from '@adminforge/schemas';
import { FakeDefinitions } from '../scheduler/helpers';

// A broad feed filtered by its rules (MSRC lists thousands of CVEs, a handful in services AdminForge manages): the
// `maxItems` cap applies to what the feed keeps, so a flood of unrelated items can't push the relevant ones out.
const T0 = Date.parse('2026-10-15T12:00:00Z');

const feed = Feed.parse({
  kind: 'feed',
  id: 'feeds.cves',
  version: '1.0.0',
  title: 'CVEs',
  owner: 'test',
  publisher: 'Microsoft Security Response Center',
  homepage: 'https://msrc.microsoft.com/update-guide',
  collector: { kind: 'rss', url: 'https://api.msrc.microsoft.com/update-guide/rss', maxItems: 2 },
  keep: 'matched',
  classify: [{ match: { title: ['Microsoft Entra ID'] }, areas: ['identity'], kind: 'security' }],
});

const item = (id: string, title: string, day: number) =>
  `<item><guid>${id}</guid><link>https://msrc.microsoft.com/update-guide/vulnerability/${id}</link><title>${title}</title><description>Information published.</description><pubDate>${new Date(T0 - day * 86_400_000).toUTCString()}</pubDate></item>`;

it('keeps the newest maxItems of the items the rules keep, not of everything the feed lists', async () => {
  // Newest first: ten unrelated CVEs, then three Entra ID ones.
  const items = [
    ...Array.from({ length: 10 }, (_, i) =>
      item(`CVE-2026-1${i}`, `CVE-2026-1${i} Example Browser Vulnerability`, 1),
    ),
    item('CVE-2026-20', 'CVE-2026-20 Microsoft Entra ID Elevation of Privilege Vulnerability', 2),
    item('CVE-2026-21', 'CVE-2026-21 Microsoft Entra ID Spoofing Vulnerability', 3),
    item('CVE-2026-22', 'CVE-2026-22 Microsoft Entra ID Information Disclosure Vulnerability', 4),
  ].join('');
  const defs = new FakeDefinitions();
  defs.set(feed);
  const store = new MemoryNewsStore();
  const collectors: CollectorDeps = {
    outbound: {} as never,
    now: () => new Date(T0),
    fetchFeed: async () => ({
      status: 'ok',
      text: `<rss version="2.0"><channel><title>Security Update Guide</title>${items}</channel></rss>`,
      etag: null,
      lastModified: null,
    }),
  };
  const service = new NewsService({ store, definitions: defs as never, collectors, now: () => new Date(T0) });

  expect(await service.refresh()).toMatchObject({ ok: 1, new: 2 });
  const kept = await store.list({ roles: ['Portal.Reader'], now: new Date(T0) }, { limit: 10 });
  expect(kept.map((r) => r.externalId)).toEqual(['CVE-2026-20', 'CVE-2026-21']);
});
