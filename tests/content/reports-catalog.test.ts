import path from 'node:path';
import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import type { DefinitionRecord } from '@adminforge/api/src/definitions/types';
import { reportCatalog, reportDetail, type CatalogDeps } from '@adminforge/api/src/reports/catalog';
import { composeNav } from '@adminforge/api/src/routes/nav';
import { loadContentDir, PORTAL_SCHEDULE_PREFIX, type Kind, type Navigation } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// The real content behind the Reports catalogue: the rail shows one "All reports" entry, every report lands in a
// labelled area with its export columns, and no content schedule uses the reserved `portal.` namespace.

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
const navigation = records.find((r) => r.key === 'portal.navigation')!.def as Navigation;
const reports = records.filter((r) => r.kind === 'report');
const active = reports.filter((r) => !['draft', 'retired'].includes(r.def.status ?? 'active'));
const ALL_ROLES = [
  'Portal.Reader',
  'Portal.Operator',
  'Playbook.Author',
  'Playbook.Approver',
  'Portal.Admin',
];
const session = { roles: ALL_ROLES } as SessionRecord;
const deps: CatalogDeps = {
  definitions: {
    list: async (kind?: Kind) => records.filter((r) => !kind || r.kind === kind),
    get: async (kind: Kind, key: string) => records.find((r) => r.kind === kind && r.key === key) ?? null,
  },
  licences: async () => null,
  schedules: async () => ({ items: [] }),
  exportMaxRows: 10_000,
};

describe('Reports in the navigation', () => {
  it('the reports section lists only the catalogue entry', () => {
    const section = navigation.sections.find((s) => s.key === 'reports')!;
    expect(section.listDefinitions).toBe(false);
    expect(section.items).toEqual([
      { key: 'reports-catalog', label: 'All reports', href: '/reports', icon: 'chart-bar', order: 10 },
    ]);
    const nav = composeNav({ navigation, definitions: records, roles: ALL_ROLES, licences: null });
    expect(nav.sections.find((s) => s.key === 'reports')!.items.map((i) => i.href)).toEqual(['/reports']);
    // No report is listed anywhere else in the rail either.
    const hrefs = nav.sections.flatMap((s) => s.items.map((i) => i.href));
    expect(reports.filter((r) => hrefs.includes(`/p/${r.key}`)).map((r) => r.key)).toEqual([]);
  });
});

describe('Reports catalogue over the real content', () => {
  it('offers every active report, each in an area labelled by the navigation', async () => {
    const catalogue = await reportCatalog(deps, session);
    expect(catalogue.items).toHaveLength(active.length);
    expect(catalogue.items.length).toBeGreaterThan(50);
    expect(catalogue.areas.filter((a) => a.icon === 'folder')).toEqual([]);
    // Areas follow the navigation's section order; each Microsoft 365 workload is an area of its own.
    const order = [...navigation.sections]
      .sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000))
      .map((s) => s.key)
      .filter((k) => catalogue.areas.some((a) => a.key === k));
    expect(catalogue.areas.map((a) => a.key)).toEqual(order);
    expect(order).toEqual(
      expect.arrayContaining([
        'identity',
        'm365',
        'exchange',
        'sharepoint',
        'teams',
        'endpoint',
        'security',
        'azure',
      ]),
    );
    for (const item of catalogue.items) {
      expect(item.schedulable, item.key).toBe(true);
      expect(item.icon, item.key).toBeTruthy();
      expect(item.tags.length, item.key).toBeGreaterThan(0);
    }
  });

  it.each(active.map((r) => r.key))('%s: export columns resolve', async (key) => {
    const detail = await reportDetail(deps, session, key);
    expect(detail.columns.length).toBeGreaterThan(0);
    expect(detail.exportFormats.length).toBeGreaterThan(0);
  });
});

describe('draft reports', () => {
  it.each(reports.filter((r) => !active.includes(r)).map((r) => r.key))(
    '%s is not offered (404)',
    async (key) => {
      await expect(reportDetail(deps, session, key)).rejects.toMatchObject({ code: 'definition_not_found' });
    },
  );
});

describe('reserved schedule namespace', () => {
  it(`no content schedule id starts with "${PORTAL_SCHEDULE_PREFIX}" and validation reports none`, () => {
    expect(records.filter((r) => r.kind === 'schedule' && r.key.startsWith(PORTAL_SCHEDULE_PREFIX))).toEqual(
      [],
    );
    expect(
      loaded.errors.filter((e) => e.message.includes('reserved for schedules created in the portal')),
    ).toEqual([]);
  });
});
