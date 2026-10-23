import { parseDefinition } from '@adminforge/schemas';
import { fixturesApp, setupContent, type ContentEnv } from './content-helpers';
import { mockLogin } from './helpers';

// A page whose views switch tables (the Groups member views, the Users MFA and inactivity views) exports the table the
// view shows: `export.data` may be a `${ … }` template over params that names the datasource path. Before, the export
// always read one table, so an export from the MFA view held the users table the view hides.
const REPORT = `
kind: report
id: identity.export-views
version: 1.0.0
title: Export views
owner: identity-team
params:
  view: { type: enum, values: [all, small], default: all }
datasources:
  groups:
    source: static
    data: { value: [{ displayName: Alpha }, { displayName: Beta }] }
  small:
    source: static
    data: { rows: [{ displayName: Gamma, memberCount: 2 }] }
layout:
  - widget: table
    data: groups.value
    when: \${ params.view != 'small' }
    columns:
      - { field: displayName, label: Group }
  - widget: table
    data: small.rows
    when: \${ params.view = 'small' }
    columns:
      - { field: displayName, label: Group }
      - { field: memberCount, label: Direct members, kind: number }
export:
  formats: [csv]
  data: "\${ params.view = 'small' ? 'small.rows' : 'groups.value' }"
  columns: all
`;

const csvLines = (body: string) =>
  body
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n');

let env: ContentEnv;
beforeAll(() => {
  env = setupContent();
  env.write('reports/identity/export-views.report.yaml', REPORT);
});
afterAll(() => env.cleanup());

describe('an export follows the table the view shows', () => {
  const exportWith = async (params: Record<string, unknown>) => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    return t.app.inject({
      method: 'POST',
      url: '/api/reports/identity.export-views/export',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { format: 'csv', params },
    });
  };

  it('reads the datasource path the template names for these params, with that table’s columns', async () => {
    const small = await exportWith({ view: 'small' });
    expect(small.statusCode).toBe(200);
    expect(csvLines(small.body)).toEqual(['Group,Direct members', 'Gamma,2']);

    const all = await exportWith({});
    expect(all.statusCode).toBe(200);
    expect(csvLines(all.body)).toEqual(['Group', 'Alpha', 'Beta']);
  });

  it('refuses a template that names a datasource the page does not declare', () => {
    const bad = REPORT.replace("'small.rows' : 'groups.value'", "'missing.rows' : 'groups.value'");
    const parsed = parseDefinition(bad, 'export-views.report.yaml');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(JSON.stringify(parsed.errors)).toContain('Unknown datasource \\"missing\\"');
  });

  it('refuses a template that builds the path from a param instead of naming it', () => {
    const built = REPORT.replace(
      `"\${ params.view = 'small' ? 'small.rows' : 'groups.value' }"`,
      `"\${ params.view & '.rows' }"`,
    );
    const parsed = parseDefinition(built, 'export-views.report.yaml');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(JSON.stringify(parsed.errors)).toContain('Name each path the export may read');
  });

  it('exports only a path the template names: a param that names another one is refused, without echoing it', async () => {
    env.write(
      'reports/identity/export-views.report.yaml',
      REPORT.replace("'small.rows' : 'groups.value'", "'small.rows' : params.path").replace(
        '  view: { type: enum, values: [all, small], default: all }\n',
        '  view: { type: enum, values: [all, small], default: all }\n  path: { type: string, default: "" }\n',
      ),
    );
    try {
      const res = await exportWith({ path: 'groups.value' });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('groups.value');
      expect(JSON.parse(res.body).code ?? JSON.parse(res.body).error).toBeTruthy();
    } finally {
      env.write('reports/identity/export-views.report.yaml', REPORT);
    }
  });

  it('accepts a plain path and a template naming declared datasources', () => {
    expect(parseDefinition(REPORT, 'export-views.report.yaml').ok).toBe(true);
    const plain = REPORT.replace(/ {2}data: ".*"\n/, '  data: groups.value\n');
    expect(parseDefinition(plain, 'export-views.report.yaml').ok).toBe(true);
  });
});
