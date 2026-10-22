import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { activeBlocks, neededDatasources } from '@adminforge/web/src/renderer/page-model';
import { repoRoot } from '../lib/repo';

// SharePoint sharing and the Anyone-link sites report over Get-SiteSharing.ps1's events (a summary, then sites in
// chunks) and Microsoft's site usage report: the live read is cached apart from search and filters, search matches
// title, URL and owner whatever the case, the browser gets at most 10,000 rows, and the admin-center link is worked out
// on the server (the browser has no env). Fleet size: content-at-scale-sharepoint-sharing.scale.test.ts.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => loaded.definitions.find((d) => d.def.id === id)!.def;
const PAGE = def('m365.sharepoint-sharing');
const REPORT = def('m365.anyone-link-sites');
const json = (rel: string) => JSON.parse(readFileSync(path.join(repoRoot, rel), 'utf8'));
const EVENTS = json('tests/fixtures/runner/sharepoint/Get-SiteSharing.ps1.json');
const USAGE = json('tests/fixtures/graph/beta/reports/getsharepointsiteusagedetail_period=_d7__/GET.json');
const usage = USAGE.$fixture?.body ?? USAGE;

const run = (d: Def, name: string, value: unknown, extra: Record<string, unknown> = {}) =>
  renderString(d.datasources[name].transform as string, {
    now: '2026-10-19T12:00:00Z',
    user: {},
    env: {},
    params: {},
    ds: {},
    value,
    ...extra,
  }) as Promise<Def>;

const pageParams = { q: '', sharing: 'All', template: 'All', includeOneDrive: false };

// What the browser asks for: the small views, never the live read of every site or the full list of matches.
const browserFetches = (d: Def) =>
  neededDatasources(d, [activeBlocks(d, undefined).blocks, d.header, d.actions]);

describe('what reaches the browser', () => {
  it('the page fetches the admin link and the capped view only', () =>
    expect(browserFetches(PAGE)).toEqual(['admin', 'sharing']));
  it('the report fetches its capped view and the usage report only', () =>
    expect(browserFetches(REPORT)).toEqual(['sharing', 'links']));
  it('the derived lists are not cached themselves (the live read is)', () => {
    expect(PAGE.datasources.sites.cache).toEqual({ ttl: 900 });
    expect(PAGE.datasources.matches.cache).toBeUndefined();
    expect(REPORT.datasources.sharingList.cache).toBeUndefined();
  });
});

describe('m365.sharepoint-sharing', () => {
  it('reads every site live, and its cache key ignores search and filters', async () => {
    const sites = PAGE.datasources.sites;
    expect(sites.transform).not.toMatch(/params/);
    expect(JSON.stringify(sites.parameters)).not.toMatch(/params\.(q|sharing)\b/);
    const v = await run(PAGE, 'sites', EVENTS);
    expect(v.head.summary.total).toBe(13);
    expect(v.all).toHaveLength(13);
  });

  it('joins the chunks in order', async () => {
    const chunk = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ url: `https://example.sharepoint.com/sites/s${from + i}` }));
    const v = await run(PAGE, 'sites', [
      { tenant: {}, summary: { total: 3 } },
      { sites: chunk(2, 0) },
      { sites: chunk(1, 2) },
    ]);
    expect(v.all.map((s: Def) => s.url)).toEqual(
      [0, 1, 2].map((i) => `https://example.sharepoint.com/sites/s${i}`),
    );
    expect((await run(PAGE, 'sites', [{ tenant: {}, summary: { total: 0 } }])).all).toEqual([]);
  });

  it('searches title, URL and owner whatever the case, and filters by sharing level', async () => {
    const sites = await run(PAGE, 'sites', EVENTS);
    const matches = (params: Record<string, unknown>) =>
      run(PAGE, 'matches', sites, { params: { ...pageParams, ...params } });
    const all = await matches({});
    expect(all.rows).toHaveLength(13);
    expect(all.total).toBe(13);
    expect(all.anyone).toBe(3);
    const byTitle = await matches({ q: 'ALL COMPANY' });
    expect(byTitle.rows.map((r: Def) => r.title)).toEqual(['All Company']);
    const byUrl = await matches({ q: '/sites/allcompany' });
    expect(byUrl.rows).toHaveLength(1);
    const anyone = await matches({ sharing: 'ExternalUserAndGuestSharing' });
    expect(anyone.rows).toHaveLength(3);
    expect(anyone.rows.every((r: Def) => r.sharingCapability === 'ExternalUserAndGuestSharing')).toBe(true);
    // The figures are the tenant's, whatever the filter.
    expect(anyone.total).toBe(13);
    expect((await matches({ q: 'nothing like this' })).rows).toEqual([]);
    expect(all.tenant).toMatchObject({ sharingLabel: 'Anyone', anyoneLinkExpiry: 'Never' });
  });

  it('sends the browser at most 10,000 rows and says how many matched', async () => {
    const rows = Array.from({ length: 10_001 }, (_, i) => ({ url: `u${i}` }));
    const view = await run(PAGE, 'sharing', { rows, total: 10_001 });
    expect(view.rows).toHaveLength(10_000);
    expect(view).toMatchObject({ matched: 10_001, listCapped: true, total: 10_001 });
    expect(PAGE.export.data).toBe('matches.rows');
  });

  it('builds the admin-center link on the server', async () => {
    expect(await run(PAGE, 'admin', {}, { env: { AF_SPO_TENANT_NAME: 'exampleorg' } })).toEqual({
      url: 'https://exampleorg-admin.sharepoint.com/_layouts/15/online/AdminHome.aspx#/siteManagement',
    });
    expect(await run(PAGE, 'admin', {})).toEqual({});
    const action = PAGE.layout
      .find((w: Def) => w.id === 'sites')
      .rowActions.find((a: Def) => /admin center/.test(a.label));
    expect(action.href).not.toMatch(/env\./);
    // The site page's action works the same way.
    const SITE = def('m365.sharepoint-site');
    expect(await run(SITE, 'admin', {}, { env: { AF_SPO_TENANT_NAME: 'exampleorg' } })).toMatchObject({
      url: expect.stringMatching(/^https:\/\/exampleorg-admin\.sharepoint\.com\//),
    });
    const siteAction = SITE.actions.find((a: Def) => /admin center/.test(a.label));
    expect([siteAction.href, siteAction.when]).toEqual(['${ admin.url }', '${ $boolean(admin.url) }']);
  });
});

describe('m365.anyone-link-sites', () => {
  it('lists the sites that allow Anyone links (and new guests when asked), labelled', async () => {
    const sites = await run(REPORT, 'sites', EVENTS);
    expect(REPORT.datasources.sites.transform).not.toMatch(/params/);
    const list = (includeGuestSharing: boolean) =>
      run(REPORT, 'sharingList', sites, { params: { includeGuestSharing, includeOneDrive: false } });
    const anyone = await list(false);
    expect(anyone.rows).toHaveLength(3);
    expect(anyone.rows.every((r: Def) => r.level === 'anyone')).toBe(true);
    const both = await list(true);
    expect(both.rows).toHaveLength(4);
    expect(both.rows.filter((r: Def) => r.level === 'guests')).toHaveLength(1);
    expect(both).toMatchObject({ anyone: 3, guests: 1, tenantAnyone: 1 });
    expect(REPORT.export.data).toBe('sharingList.rows');
  });

  it('reads every site in the usage report and lists those holding Anyone links, most first', async () => {
    expect(REPORT.datasources.links.maxItems).toBe(60_000);
    const links = await run(REPORT, 'links', usage);
    expect(links.rows.map((r: Def) => r.anonymousLinkCount)).toEqual([37, 11, 5, 3]);
    // Only the fields the table shows (the report's rows carry two dozen).
    expect(Object.keys(links.rows[0]).sort()).toEqual([
      'anonymousLinkCount',
      'lastActivityDate',
      'ownerDisplayName',
      'secureLinkForGuestCount',
      'siteId',
      'siteUrl',
    ]);
    expect(links).toMatchObject({ sites: 4, links: 56, partial: false, listCapped: false, concealed: false });
  });

  it('leaves out deleted sites, says when the report was cut or names are concealed', async () => {
    const value = [
      { siteId: 'a', siteUrl: '3f2a9c', anonymousLinkCount: 2, isDeleted: false },
      { siteId: 'b', siteUrl: '', anonymousLinkCount: 9, isDeleted: true },
      { siteId: 'c', siteUrl: '7d1e00', anonymousLinkCount: 0, isDeleted: false },
    ];
    const links = await run(REPORT, 'links', { value, truncated: true });
    expect(links.rows.map((r: Def) => r.siteId)).toEqual(['a']);
    expect(links).toMatchObject({ sites: 1, links: 2, partial: true, concealed: true });
    expect(await run(REPORT, 'links', { value: [] })).toMatchObject({ rows: [], sites: 0, links: 0 });
  });

  it('still lists the sites when the first one has no URL', async () => {
    const value = [
      { siteId: 'a', siteUrl: null, anonymousLinkCount: 4, isDeleted: false },
      {
        siteId: 'b',
        siteUrl: 'https://exampleorg.sharepoint.com/sites/b',
        anonymousLinkCount: 1,
        isDeleted: false,
      },
    ];
    const links = await run(REPORT, 'links', { value });
    expect(links).toMatchObject({ sites: 2, links: 5, concealed: false });
  });
});
