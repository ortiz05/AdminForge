import { existsSync } from 'node:fs';
import path from 'node:path';
import { galleryVersionsUrl } from '@adminforge/api/src/news/collectors/ps-gallery';
import { fixtureKey } from '@adminforge/connectors';
import {
  isCitationUrl,
  isFeedUrl,
  isTenantCollector,
  loadContentDir,
  type Feed,
  type Schedule,
} from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// The News and changes feed library (portal/content/feeds, docs/news.md): first-party sources only, every public URL on
// the allow-list with a synthetic fixture, every tenant feed declaring what the automation identity needs, and the
// hourly schedule that collects them.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const feeds = loaded.definitions.filter((d) => d.def.kind === 'feed') as Array<{ file: string; def: Feed }>;
const schedules = loaded.definitions.filter((d) => d.def.kind === 'schedule') as Array<{
  file: string;
  def: Schedule;
}>;
const fixturesDir = path.join(repoRoot, 'tests/fixtures');
const hasFixture = (url: string) =>
  fixtureKey('GET', url).candidates.some((c) => existsSync(path.join(fixturesDir, c)));
const publicUrls = (f: Feed): string[] =>
  f.collector.kind === 'rss'
    ? [f.collector.url]
    : f.collector.kind === 'psGallery'
      ? f.collector.packages.map((p) => galleryVersionsUrl(p, 5))
      : [];

describe('feed library', () => {
  it('loads without content errors and covers every source in docs/news.md', () => {
    expect(loaded.errors.filter((e) => e.file.startsWith('feeds/'))).toEqual([]);
    expect(feeds.map((f) => f.def.id).sort()).toEqual(
      [
        'feeds.azure-governance-blog',
        'feeds.azure-service-health',
        'feeds.azure-updates',
        'feeds.defender-xdr-blog',
        'feeds.entra-blog',
        'feeds.exchange-blog',
        'feeds.graph-changelog',
        'feeds.intune-blog',
        'feeds.learn-defender-xdr-whats-new',
        'feeds.learn-entra-whats-new',
        'feeds.learn-graph-whats-new',
        'feeds.learn-intune-whats-new',
        'feeds.learn-teams-powershell-release-notes',
        'feeds.m365-message-center',
        'feeds.m365-roadmap',
        'feeds.m365-service-health',
        'feeds.msrc-security',
        'feeds.pnp-powershell',
        'feeds.powershell-modules',
        'feeds.sharepoint-blog',
        'feeds.teams-blog',
      ].sort(),
    );
  });

  it('keeps feeds in portal/content/feeds as <name>.feed.yaml with id feeds.<name>', () => {
    for (const { file, def } of feeds) expect(file).toBe(`feeds/${def.id.replace(/^feeds\./, '')}.feed.yaml`);
  });

  it('fetches public feeds only from allow-listed hosts and cites Microsoft domains', () => {
    for (const { def } of feeds) {
      expect(isCitationUrl(def.homepage), def.id).toBe(true);
      for (const url of publicUrls(def)) expect(isFeedUrl(url), `${def.id}: ${url}`).toBe(true);
    }
  });

  it('has a synthetic fixture for every public feed URL (DATA_MODE=fixtures never reaches the internet)', () => {
    const missing = feeds.flatMap(({ def }) => publicUrls(def).filter((u) => !hasFixture(u)));
    expect(missing).toEqual([]);
  });

  it('declares what the automation identity needs for tenant feeds', () => {
    const need: Record<string, (f: Feed) => boolean> = {
      messageCenter: (f) => !!f.requires?.scopes?.graph?.includes('ServiceMessage.Read.All'),
      serviceHealth: (f) => !!f.requires?.scopes?.graph?.includes('ServiceHealth.Read.All'),
      azureServiceHealth: (f) => !!f.requires?.azureRoles?.includes('Reader'),
    };
    const tenant = feeds.filter((f) => isTenantCollector(f.def.collector.kind));
    expect(tenant.map((f) => f.def.collector.kind).sort()).toEqual([
      'azureServiceHealth',
      'messageCenter',
      'serviceHealth',
    ]);
    for (const { def } of tenant) expect(need[def.collector.kind]!(def), def.id).toBe(true);
    // Public feeds need nothing from the tenant.
    for (const { def } of feeds.filter((f) => !isTenantCollector(f.def.collector.kind)))
      expect(def.requires?.scopes, def.id).toBeUndefined();
  });

  it('keeps excerpts short (a quote with a link back, never the article)', () => {
    for (const { def } of feeds) expect(def.excerptChars, def.id).toBeLessThanOrEqual(300);
  });

  it('polls large feeds without conditional requests at most every few hours', () => {
    const poll = Object.fromEntries(feeds.map((f) => [f.def.id, f.def.pollMinutes]));
    expect(poll['feeds.m365-roadmap']).toBeGreaterThanOrEqual(360);
    expect(poll['feeds.graph-changelog']).toBeGreaterThanOrEqual(1440);
    expect(poll['feeds.powershell-modules']).toBeGreaterThanOrEqual(360);
    expect(poll['feeds.pnp-powershell']).toBeGreaterThanOrEqual(360);
    for (const { def } of feeds.filter((f) => f.def.id.includes('-blog')))
      expect(def.pollMinutes, def.id).toBeGreaterThanOrEqual(180);
    for (const { def } of feeds.filter((f) => f.def.id.startsWith('feeds.learn-')))
      expect(def.pollMinutes, def.id).toBe(1440);
  });

  it('labels PnP.PowerShell as a community project, not Microsoft', () => {
    const pnp = feeds.find((f) => f.def.id === 'feeds.pnp-powershell')!.def;
    expect(pnp.publisher).toMatch(/community/i);
    expect(pnp.publisher).not.toBe('Microsoft');
  });

  it('follows only the what-s-new pages in Learn search feeds', () => {
    for (const { def } of feeds.filter((f) => f.def.id.startsWith('feeds.learn-'))) {
      const c = def.collector;
      expect(c.kind, def.id).toBe('rss');
      if (c.kind === 'rss') {
        expect(c.url.startsWith('https://learn.microsoft.com/api/search/rss?'), def.id).toBe(true);
        expect(c.linkPrefixes?.length, def.id).toBeGreaterThan(0);
      }
    }
  });
});

describe('hourly news schedule', () => {
  const s = schedules.find((x) => x.def.id === 'maintenance.news-refresh-hourly')?.def;

  it('collects every feed hourly as the automation identity, without overlap', () => {
    expect(s).toBeDefined();
    expect(s!.enabled).toBe(true);
    expect(s!.cron).toBe('5 * * * *');
    expect(s!.timezone).toBe('UTC');
    expect(s!.identity).toBe('automation');
    expect(s!.overlap).toBe('skip');
    expect(s!.job).toEqual({ kind: 'news' });
  });

  it('declares the permissions the tenant feeds need', () => {
    const declared = new Set(s!.requires?.scopes?.graph ?? []);
    for (const { def } of feeds)
      for (const scope of def.requires?.scopes?.graph ?? []) expect(declared.has(scope), scope).toBe(true);
    expect(s!.requires?.azureRoles).toContain('Reader');
  });

  it('is the only news schedule (one collector per hour)', () => {
    expect(schedules.filter((x) => x.def.job.kind === 'news').map((x) => x.def.id)).toEqual([
      'maintenance.news-refresh-hourly',
    ]);
  });
});
