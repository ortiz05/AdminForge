import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import type { DefinitionRecord } from '@adminforge/api/src/definitions/types';
import { reportCatalog, type CatalogDeps } from '@adminforge/api/src/reports/catalog';
import { composeNav } from '@adminforge/api/src/routes/nav';
import { renderString } from '@adminforge/expressions';
import { loadContentDir, type Kind, type Navigation } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Microsoft 365 split into its workloads: Exchange Online, SharePoint Online and Teams are parents of their own in the
// rail (pages keep their m365.* keys, so links, schedules and inspectors keep working), their reports sit in their
// own catalogue areas, and each has an overview dashboard with its synthetic checks (probeStatus by group).

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const records: DefinitionRecord[] = loaded.definitions.map((d) => ({
  kind: d.def.kind,
  key: d.def.id,
  version: d.def.version,
  sha256: d.sha256,
  def: d.def,
  status: 'published',
  source: 'fs',
  file: d.file,
}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (key: string): Def => {
  const found = records.find((r) => r.key === key);
  if (!found) throw new Error(`${key} is missing from portal/content`);
  return found.def;
};
const navigation = def('portal.navigation') as Navigation;
const ALL_ROLES = [
  'Portal.Reader',
  'Portal.Operator',
  'Playbook.Author',
  'Playbook.Approver',
  'Portal.Admin',
];

const WORKLOADS = ['exchange', 'sharepoint', 'teams'] as const;

const PLACEMENT: Record<string, string> = {
  'exchange.overview': 'exchange',
  'm365.mailboxes': 'exchange',
  'm365.shared-mailboxes': 'exchange',
  'm365.distribution-lists': 'exchange',
  'm365.mail-forwarding': 'exchange',
  'sharepoint.overview': 'sharepoint',
  'm365.sharepoint-sites': 'sharepoint',
  'm365.sharepoint-sharing': 'sharepoint',
  'teams.overview': 'teams',
  'm365.teams': 'teams',
  'm365.teams-user-policies': 'teams',
  // What spans the suite stays under Microsoft 365.
  'm365.overview': 'm365',
  'm365.service-health': 'm365',
  'm365.message-center': 'm365',
  'm365.licences': 'm365',
  'm365.usage': 'm365',
  'm365.groups': 'm365',
};

const AREA: Record<string, string> = {
  'm365.external-forwarding': 'exchange',
  'm365.inbox-rules': 'exchange',
  'm365.mailbox-storage': 'exchange',
  'm365.shared-mailbox-sign-in': 'exchange',
  'm365.anyone-link-sites': 'sharepoint',
  'm365.sharepoint-site-usage': 'sharepoint',
  'm365.onedrive-usage': 'sharepoint',
  'm365.teams-activity': 'teams',
  'm365.teams-without-owners': 'teams',
  'm365.licence-utilization': 'm365',
  'm365.inactive-licensed-users': 'm365',
  'm365.message-center-actions': 'm365',
  'm365.service-health-review': 'm365',
  'm365.subscription-renewals': 'm365',
};

describe('Microsoft 365 workloads in the navigation', () => {
  it('Exchange Online, SharePoint Online and Teams follow Microsoft 365, each with its service checks', () => {
    const keys = [...navigation.sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((s) => s.key);
    const m365 = keys.indexOf('m365');
    expect(keys.slice(m365, m365 + 4)).toEqual(['m365', 'exchange', 'sharepoint', 'teams']);
    // The section's checks are the status mark on its row (its key is the probes' group), not an item of their own.
    for (const key of WORKLOADS) {
      const section = navigation.sections.find((s) => s.key === key)!;
      expect(section.items ?? []).toEqual([]);
      expect(
        records.some((r) => r.kind === 'probe' && (r.def as Def).group === key),
        key,
      ).toBe(true);
    }
  });

  it.each(Object.entries(PLACEMENT))('%s is listed under %s', (key, section) => {
    expect(def(key).nav?.section).toBe(section);
  });

  it('nothing tied to one workload is left under Microsoft 365', () => {
    const left = records
      .filter((r) => (r.def as Def).nav?.section === 'm365')
      .map((r) => r.key)
      .sort();
    expect(left).toEqual(
      Object.keys(PLACEMENT)
        .filter((k) => PLACEMENT[k] === 'm365')
        .sort(),
    );
  });

  it('the rail opens each workload with its overview and lists only its pages', () => {
    const nav = composeNav({ navigation, definitions: records, roles: ALL_ROLES, licences: null });
    const items = (key: string) => nav.sections.find((s) => s.key === key)!.items;
    expect(items('exchange').map((i) => i.label)).toEqual([
      'Overview',
      'Mailboxes',
      'Shared mailboxes',
      'Distribution lists',
      'Mail forwarding',
    ]);
    expect(items('sharepoint').map((i) => i.label)).toEqual(['Overview', 'Sites', 'Sharing']);
    expect(items('teams').map((i) => i.label)).toEqual(['Overview', 'All teams', 'User policies']);
    expect(items('m365').map((i) => i.href)).toEqual([
      '/p/m365.overview',
      '/p/m365.service-health',
      '/p/m365.message-center',
      '/p/m365.licences',
      '/p/m365.usage',
      '/p/m365.groups',
    ]);
    // No section lists its checks as a page any more: the rail draws them on the section's row (D-14).
    expect(nav.sections.flatMap((s) => s.items).filter((i) => i.href.includes('group='))).toEqual([]);
  });
});

describe('Reports catalogue areas', () => {
  const deps: CatalogDeps = {
    definitions: {
      list: async (kind?: Kind) => records.filter((r) => !kind || r.kind === kind),
      get: async (kind: Kind, key: string) => records.find((r) => r.kind === kind && r.key === key) ?? null,
    },
    licences: async () => null,
    schedules: async () => ({ items: [] }),
    exportMaxRows: 10_000,
  };
  const session = { roles: ALL_ROLES } as SessionRecord;

  it('workload reports keep their keys and land in the workload area', async () => {
    const catalogue = await reportCatalog(deps, session);
    const areaOf = Object.fromEntries(catalogue.items.map((i) => [i.key, i.area]));
    for (const [key, area] of Object.entries(AREA)) expect(areaOf[key], key).toBe(area);
    const labels = Object.fromEntries(catalogue.areas.map((a) => [a.key, a.label]));
    expect(labels).toMatchObject({
      m365: 'Microsoft 365',
      exchange: 'Exchange Online',
      sharepoint: 'SharePoint Online',
      teams: 'Teams',
    });
  });

  it('every report area is a navigation section', () => {
    const sections = new Set(navigation.sections.map((s) => s.key));
    for (const r of records.filter((x) => x.kind === 'report'))
      if ((r.def as Def).area) expect(sections.has((r.def as Def).area), r.key).toBe(true);
  });
});

describe('workload overview dashboards', () => {
  const definitions = new Set(records.map((r) => r.key));

  it.each(WORKLOADS)('%s.overview shows its own synthetic checks and links only to real pages', (key) => {
    const d = def(`${key}.overview`);
    expect(d.kind).toBe('dashboard');
    expect(d.requires.licences).toEqual([key]);
    expect(d.requires.portalRoles).toEqual(['Portal.Reader']);
    const probes = d.layout.filter((b: Def) => b.widget === 'probeStatus');
    expect(probes).toHaveLength(1);
    expect(probes[0].group).toBe(key);
    const text = d.layout
      .filter((b: Def) => b.widget === 'markdown')
      .map((b: Def) => b.text)
      .join('\n');
    const pages = [...text.matchAll(/\]\(\/p\/([a-z0-9.-]+)/g)].map((m) => m[1]);
    expect(pages.length).toBeGreaterThan(2);
    for (const page of pages) expect(definitions.has(page), page).toBe(true);
    expect(text).toContain(`/monitoring?group=${key}`);
    expect(text).toContain(`/reports?area=${key}`);
  });

  it('probe groups name a navigation section (or AdminForge itself)', () => {
    const sections = new Set([...navigation.sections.map((s) => s.key), 'platform']);
    for (const r of records.filter((x) => x.kind === 'probe'))
      if ((r.def as Def).group) expect(sections.has((r.def as Def).group), r.key).toBe(true);
  });
});

// The dashboards' transforms over the synthetic fixtures mock mode serves (and over edge cases).
const fixture = (rel: string) => {
  const raw = JSON.parse(readFileSync(path.join(repoRoot, 'tests/fixtures/graph', rel), 'utf8'));
  return raw.$fixture?.body ?? raw;
};
const HEALTH = fixture('v1.0/admin/serviceannouncement/healthoverviews/GET.json');
const ISSUES = fixture('v1.0/admin/serviceannouncement/issues/GET.json');
const run = (key: string, ds: string, value: unknown) =>
  renderString(def(key).datasources[ds].transform as string, {
    now: '2026-10-17T12:00:00Z',
    user: {},
    env: {},
    params: {},
    ds: {},
    value,
  }) as Promise<Def>;

describe('workload overview transforms', () => {
  it('health: a healthy service, a degraded one, and two services of which one is affected', async () => {
    expect(await run('exchange.overview', 'health', HEALTH)).toMatchObject({
      label: 'Healthy',
      tone: 'ok',
      services: 'Exchange Online',
    });
    expect(await run('teams.overview', 'health', HEALTH)).toMatchObject({
      label: 'Degraded',
      tone: 'warn',
      services: 'Microsoft Teams',
    });
    const sp = await run('sharepoint.overview', 'health', HEALTH);
    expect(sp).toMatchObject({
      label: 'Healthy',
      tone: 'ok',
      services: 'SharePoint Online and OneDrive for Business',
    });
    expect(sp.value.map((r: Def) => r.service).sort()).toEqual([
      'OneDrive for Business',
      'SharePoint Online',
    ]);
    const down = {
      value: [
        { id: 'SharePoint', service: 'SharePoint Online', status: 'serviceOperational' },
        { id: 'OneDriveForBusiness', service: 'OneDrive for Business', status: 'serviceInterruption' },
      ],
    };
    expect(await run('sharepoint.overview', 'health', down)).toMatchObject({
      label: 'Interrupted',
      tone: 'crit',
      services: 'OneDrive for Business',
    });
    expect(await run('exchange.overview', 'health', { value: [] })).toMatchObject({
      label: 'Not reported',
      tone: 'neutral',
    });
  });

  it('issues: only the workload’s unresolved issues, incidents first', async () => {
    const teams = await run('teams.overview', 'issues', ISSUES);
    expect(teams.rows.map((r: Def) => r.id)).toEqual(['TM912345', 'TM913002']);
    expect(teams).toMatchObject({ incidents: 1, advisories: 1 });
    // The fixture's Exchange and SharePoint issues are resolved.
    expect(await run('exchange.overview', 'issues', ISSUES)).toMatchObject({
      rows: [],
      incidents: 0,
      advisories: 0,
    });
    expect(await run('sharepoint.overview', 'issues', ISSUES)).toMatchObject({ rows: [], incidents: 0 });
    const one = {
      value: [
        {
          id: 'OD1',
          title: 'Sync delays',
          service: 'OneDrive for Business',
          classification: 'incident',
          isResolved: false,
          lastModifiedDateTime: '2026-10-17T08:00:00Z',
        },
      ],
    };
    expect((await run('sharepoint.overview', 'issues', one)).rows).toHaveLength(1);
  });

  it('usage reports: storage, email, OneDrive and Teams activity in date order', async () => {
    const storage = await run(
      'exchange.overview',
      'storage',
      fixture('beta/reports/getmailboxusagestorage_period=_d7__/GET.json'),
    );
    expect(storage.used).toBeGreaterThan(0);
    const email = await run(
      'exchange.overview',
      'email',
      fixture('beta/reports/getemailactivitycounts_period=_d30__/GET.json'),
    );
    const dates = email.days.map((d: Def) => d.reportDate);
    expect(dates).toEqual([...dates].sort());
    expect(email.sent).toBe(email.sentTrend.reduce((a: number, b: number) => a + b, 0));
    for (const [ds, file] of [
      ['siteStorage', 'getsharepointsiteusagestorage_period=_d7__'],
      ['oneDriveStorage', 'getonedriveusagestorage_period=_d7__'],
    ])
      expect(
        (await run('sharepoint.overview', ds!, fixture(`beta/reports/${file}/GET.json`))).used,
      ).toBeGreaterThan(0);
    const files = await run(
      'sharepoint.overview',
      'files',
      fixture('beta/reports/getonedriveactivityfilecounts_period=_d30__/GET.json'),
    );
    expect(files.days.length).toBeGreaterThan(1);
    const activity = await run(
      'teams.overview',
      'activity',
      fixture('beta/reports/getteamsuseractivitycounts_period=_d30__/GET.json'),
    );
    expect(activity.days.length).toBeGreaterThan(1);
    // A report with one day still gives lists (charts and sparklines need them).
    const single = { value: [{ reportDate: '2026-10-16', send: 3, receive: 4, read: 5 }] };
    expect(await run('exchange.overview', 'email', single)).toMatchObject({ sent: 3, sentTrend: [3] });
    expect((await run('exchange.overview', 'email', single)).days).toHaveLength(1);
  });
});
