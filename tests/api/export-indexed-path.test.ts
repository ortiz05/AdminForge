import { parseDefinition, type TableColumn } from '@adminforge/schemas';
import { createWidgetRuntime, toDataColumn } from '@adminforge/widgets';
import { fixturesApp, setupContent, type ContentEnv } from './content-helpers';
import { mockLogin } from './helpers';

// What a table shows is what its export holds (design review D-06): the export reads cells with the table's own path
// reader (`owners[0].displayName`, `value[0].items`) and map lookup (case-insensitive, `"null"` keys, enum labels).
// The export used to split paths on dots only, so an indexed column rendered but exported empty.
const REPORT = `
kind: report
id: identity.indexed-paths
version: 1.0.0
title: Indexed paths
owner: identity-team
datasources:
  groups:
    source: static
    data:
      value:
        - id: g1
          displayName: Alpha
          owners: [{ id: o1, displayName: Avery Engineer }, { id: o2, displayName: Blake Analyst }]
          licences: { skus: [{ name: E5 }] }
          state: enabled
          kind: Unified
          tags: { env: prod, team: "" }
          sync: null
        - id: g2
          displayName: Beta
          owners: []
          licences: { skus: [] }
          state: DISABLED
          kind: security
          tags: [a, b]
          sync: true
  nested:
    source: static
    data:
      value:
        - items: [{ name: first }, { name: second }]
layout:
  - widget: table
    data: groups.value
    columns:
      - { field: displayName, label: Name }
      - { field: "owners[0].displayName", label: First owner }
      - { field: "licences.skus[0].name", label: Licence }
      - { field: state, label: State, kind: status, map: { enabled: [ok, Enabled], disabled: [crit, Disabled] } }
      - { field: kind, label: Type, kind: enum, map: { Unified: Microsoft 365, Security: Security } }
      - { field: tags, label: Tags, kind: tags }
      - { field: sync, label: Source, kind: enum, map: { "true": Synced from AD, "null": Cloud } }
  - widget: table
    data: "nested.value[0].items"
    columns:
      - { field: name, label: Item }
export:
  formats: [csv]
  columns: all
`;

const ROWS = [
  {
    id: 'g1',
    displayName: 'Alpha',
    owners: [
      { id: 'o1', displayName: 'Avery Engineer' },
      { id: 'o2', displayName: 'Blake Analyst' },
    ],
    licences: { skus: [{ name: 'E5' }] },
    state: 'enabled',
    kind: 'Unified',
    tags: { env: 'prod', team: '' },
    sync: null,
  },
  {
    id: 'g2',
    displayName: 'Beta',
    owners: [],
    licences: { skus: [] },
    state: 'DISABLED',
    kind: 'security',
    tags: ['a', 'b'],
    sync: true,
  },
];

/** The words a rendered cell shows, from the table widget's own column value. */
function shown(col: TableColumn, row: Record<string, unknown>): string {
  const v = toDataColumn(col as never, col.field, createWidgetRuntime()).value(row);
  if (v == null) return '';
  if (Array.isArray(v)) return v.join('; ');
  if (typeof v === 'object' && 'label' in v) return String((v as { label: string }).label);
  return String(v);
}

const csvLines = (body: string) =>
  body
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n');

let env: ContentEnv;
beforeAll(() => {
  env = setupContent();
  env.write('reports/identity/indexed-paths.report.yaml', REPORT);
});
afterAll(() => env.cleanup());

describe('exports hold what the table shows', () => {
  it('indexed paths, status and enum labels, tags: every exported cell equals the rendered one', async () => {
    const parsed = parseDefinition(REPORT, 'indexed-paths.report.yaml');
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const columns = (parsed.def as unknown as { layout: Array<{ columns: TableColumn[] }> }).layout[0]!
      .columns;

    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/reports/identity.indexed-paths/export',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { format: 'csv' },
    });
    expect(res.statusCode).toBe(200);
    const [header, ...lines] = csvLines(res.body);
    expect(header).toBe('Name,First owner,Licence,State,Type,Tags,Source');
    expect(lines).toEqual([
      'Alpha,Avery Engineer,E5,Enabled,Microsoft 365,env: prod; team,Cloud',
      'Beta,,,Disabled,Security,a; b,Synced from AD',
    ]);
    // The same cells, as the table widget renders them.
    expect(lines).toEqual(ROWS.map((row) => columns.map((c) => shown(c, row)).join(',')));
    await t.app.close();
  });

  it('an export whose data path has an index reads the rows under it', async () => {
    env.write(
      'reports/identity/indexed-paths.report.yaml',
      REPORT.replace('  columns: all', '  columns: all\n  data: "nested.value[0].items"'),
    );
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/reports/identity.indexed-paths/export',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { format: 'csv' },
    });
    expect(res.statusCode).toBe(200);
    expect(csvLines(res.body)).toEqual(['Item', 'first', 'second']);
    await t.app.close();
  });
});
