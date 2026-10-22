import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// SharePoint sharing and the Anyone-link sites report at fleet size: 50,000 sites (25 chunks of 2,000 from
// Get-SiteSharing.ps1) and 60,000 rows of the site usage report (its maxItems), a quarter of them holding Anyone
// links. Every transform runs on the largest answer under the real 250 ms budget (plus 20 % for a shared CPU), after one
// untimed warm-up. `scale` project, one file at a time. Behaviour: sharepoint-sharing-sites.test.ts.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => loaded.definitions.find((d) => d.def.id === id)!.def;
const PAGE = def('m365.sharepoint-sharing');
const REPORT = def('m365.anyone-link-sites');
const SCALE_TIMEOUT_MS = 300;
const atScale = async (str: string, scope: Record<string, unknown>) => {
  const full = { now: '2026-10-19T12:00:00Z', user: {}, env: {}, params: {}, ds: {}, ...scope };
  await renderString(str, full, { timeoutMs: 30_000 }).catch(() => undefined);
  return renderString(str, full, { timeoutMs: SCALE_TIMEOUT_MS }) as Promise<Def>;
};

const SITES = 50_000;
const LEVELS = [
  'Disabled',
  'ExternalUserSharingOnly',
  'ExternalUserAndGuestSharing',
  'ExistingExternalUserSharingOnly',
];
const site = (i: number) => ({
  url: `https://example.sharepoint.com/sites/site-${i}`,
  title: `Example Org site ${i}`,
  template: i % 3 ? 'GROUP#0' : 'STS#3',
  owner: `owner${i % 900}@example.com`,
  groupId: i % 3 ? `10000000-0000-4000-8000-${String(i).padStart(12, '0')}` : null,
  sharingCapability: LEVELS[i % 4],
  lastContentModified: '2026-10-01T00:00:00.0000000Z',
  storageUsedInBytes: (i % 500) * 1048576,
  lockState: 'Unlock',
});
const all = Array.from({ length: SITES }, (_, i) => site(i));
const events = [
  {
    tenant: { sharingCapability: 'ExternalUserAndGuestSharing', requireAnonymousLinksExpireInDays: 30 },
    summary: {
      total: SITES,
      bySharingCapability: LEVELS.map((l) => ({ sharingCapability: l, count: SITES / 4 })),
      anyoneLinks: SITES / 4,
      guests: SITES / 4,
      internal: SITES / 4,
    },
  },
  ...Array.from({ length: SITES / 2000 }, (_, c) => ({ sites: all.slice(c * 2000, (c + 1) * 2000) })),
];
const USAGE = 60_000;
const usage = Array.from({ length: USAGE }, (_, i) => ({
  reportRefreshDate: '2026-10-18',
  siteId: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  siteUrl: `https://example.sharepoint.com/sites/site-${i}`,
  ownerDisplayName: `Owner ${i % 900}`,
  isDeleted: i % 50 === 0,
  lastActivityDate: '2026-10-17',
  anonymousLinkCount: i % 4 === 0 ? (i % 97) + 1 : 0,
  secureLinkForGuestCount: i % 7,
}));

describe('SharePoint sharing at 50,000 sites', () => {
  it('joins the 25 chunks of the live read', async () => {
    const v = await atScale(PAGE.datasources.sites.transform, { value: events });
    expect(v.all).toHaveLength(SITES);
  });

  it('searches and filters natively, and the view caps the browser list', async () => {
    const sites = await atScale(PAGE.datasources.sites.transform, { value: events });
    for (const params of [
      { q: '', sharing: 'All' },
      { q: 'OWNER12@', sharing: 'All' },
      { q: 'site', sharing: 'ExternalUserAndGuestSharing' },
    ]) {
      const m = await atScale(PAGE.datasources.matches.transform, { value: sites, params });
      expect(m.rows.length).toBeGreaterThan(0);
      const view = await atScale(PAGE.datasources.sharing.transform, { value: m });
      expect(view.rows.length).toBeLessThanOrEqual(10_000);
    }
    const everything = await atScale(PAGE.datasources.matches.transform, {
      value: sites,
      params: { q: '', sharing: 'All' },
    });
    expect(everything.rows).toHaveLength(SITES);
  });

  it('the report picks the open sites and reads 60,000 usage rows within the budget', async () => {
    const sites = await atScale(REPORT.datasources.sites.transform, { value: events });
    const list = await atScale(REPORT.datasources.sharingList.transform, {
      value: sites,
      params: { includeGuestSharing: true },
    });
    expect(list.rows).toHaveLength(SITES / 2);
    const view = await atScale(REPORT.datasources.sharing.transform, { value: list });
    expect(view).toMatchObject({ listed: SITES / 2, listCapped: true });
    expect(view.rows).toHaveLength(10_000);
    const links = await atScale(REPORT.datasources.links.transform, { value: { value: usage } });
    const holding = usage.filter((r) => !r.isDeleted && r.anonymousLinkCount > 0);
    expect(links.sites).toBe(holding.length);
    expect(links.links).toBe(holding.reduce((n, r) => n + r.anonymousLinkCount, 0));
    expect(links.rows).toHaveLength(Math.min(10_000, holding.length));
    expect(links.rows[0].anonymousLinkCount).toBe(97);
  });
});
