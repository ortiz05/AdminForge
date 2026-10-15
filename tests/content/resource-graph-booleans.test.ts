import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveParams } from '@adminforge/api/src/datasources/params';
import { createFixtureFetch } from '@adminforge/connectors';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { analyzeKql, classify, outputColumns } from '../lib/kql-columns';
import { repoRoot } from '../lib/repo';

// Azure Resource Graph returns COMPUTED booleans (a comparison, `in~ (…)`, `isnotempty()`, `tobool()`,
// `coalesce(…, false)`, …) as 1/0 in objectArray results, and tostring() of one gives "True"/"False"; only a raw
// property passed through untouched keeps JSON true/false. Content projects flags as text with
// `iff(cond, 'true', 'false')`. Fixtures used to hold true/false, so a transform counting `[flag = true]`, a status
// map keyed "true"/"false" or a `when: row.flag = false` passed in tests and was silently wrong in production
// (the Privileged KPI on azure.role-assignments showed 0 with 10 privileged rows).
//
// These checks run over EVERY Resource Graph query in portal/content (page, dashboard and report datasources, probe
// checks, playbook and runbook steps): the KQL output columns are typed by tests/lib/kql-columns.ts, then the
// datasource's transform, the widgets bound to it and its fixtures must agree with what Resource Graph sends.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const fixtureFile = path.join(repoRoot, 'tests/fixtures/resourceGraph/POST.json');
const variants: Array<{ match?: { bodyIncludes?: string | string[] }; body?: { data?: unknown[] } }> =
  JSON.parse(readFileSync(fixtureFile, 'utf8')).$fixture.variants;

interface RgQuery {
  label: string;
  query: string;
  transform?: string;
  /** Widgets, header, actions or steps that read the result (the query text itself left out). */
  consumers: unknown[];
}

/** Widgets bound to datasource `ds` (`data: ds` or `data: ds.…`), anywhere in the definition's layout. */
function widgetsOf(node: unknown, ds: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) for (const n of node) widgetsOf(n, ds, out);
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (
      typeof o.widget === 'string' &&
      typeof o.data === 'string' &&
      (o.data === ds || o.data.startsWith(`${ds}.`))
    )
      out.push(o);
    else for (const [k, v] of Object.entries(o)) if (k !== 'datasources') widgetsOf(v, ds, out);
  }
  return out;
}

/** The definition without its query strings (a KQL `where flag != true` is fine; content comparing it is not). */
const withoutQueries = (node: unknown): unknown =>
  JSON.parse(JSON.stringify(node, (k, v) => (k === 'query' && typeof v === 'string' ? undefined : v)));

function collect(def: Def): RgQuery[] {
  const out: RgQuery[] = [];
  for (const [name, d] of Object.entries<Def>(def.datasources ?? {})) {
    if (d.source !== 'resourceGraph') continue;
    const mentions = (part: unknown) => part !== undefined && JSON.stringify(part).includes(`${name}.`);
    out.push({
      label: `${def.id}#${name}`,
      query: String(d.query),
      transform: d.transform,
      consumers: [...widgetsOf(def, name), ...[def.header, def.actions, def.export].filter(mentions)],
    });
  }
  if (def.check?.source === 'resourceGraph')
    out.push({ label: `${def.id} (check)`, query: String(def.check.query), consumers: [] });
  const steps = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(steps);
    else if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if (o.type === 'resourceGraph' && typeof o.query === 'string')
        out.push({ label: `${def.id}#${String(o.id)}`, query: o.query, consumers: [withoutQueries(def)] });
      Object.values(o).forEach(steps);
    }
  };
  if (def.kind === 'playbook' || def.kind === 'runbook') steps(def);
  return out;
}

const queries: RgQuery[] = loaded.definitions.flatMap(({ def }) => collect(def));

/** Every object below `node` (columns, fields, row actions, …). */
function objects(node: unknown, out: Array<Record<string, unknown>> = []) {
  if (Array.isArray(node)) for (const n of node) objects(n, out);
  else if (node && typeof node === 'object') {
    out.push(node as Record<string, unknown>);
    for (const v of Object.values(node)) objects(v, out);
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ways content can read a Resource Graph flag column wrongly. Empty = fine. */
function problemsOf(q: RgQuery): string[] {
  const bools = outputColumns(q.query, 'bool');
  const texts = outputColumns(q.query, 'flagText');
  const code = [q.transform ?? '', ...q.consumers.map((c) => JSON.stringify(c))].join('\n');
  const fields = objects(q.consumers);
  const problems: string[] = [];
  for (const c of [...bools, ...texts]) {
    const col = esc(c);
    const kind = bools.includes(c) ? 'arrives as 1/0' : "is 'true'/'false' text";
    if (
      new RegExp(
        `(?<![\\w$?&])${col}\\s*!?=\\s*(true|false)\\b|\\b(true|false)\\s*!?=\\s*(?:[\\w$]+\\.)*${col}\\b`,
      ).test(code)
    )
      problems.push(`${c} ${kind} but is compared with true/false`);
    if (
      new RegExp(
        `\\$\\{\\s*(?:row\\.)?${col}\\s*\\}|\\$not\\(\\s*(?:[\\w$]+\\.)*${col}\\s*\\)|\\[\\s*${col}\\s*\\]`,
      ).test(code)
    )
      problems.push(`${c} ${kind} but is used as a JSONata boolean`);
    if (fields.some((f) => f.field === c && f.kind === 'boolean'))
      problems.push(
        `${c} ${kind} but is shown as kind: boolean (use kind: status with a "true"/"false" map)`,
      );
  }
  for (const c of bools) {
    if (new RegExp(`(?<![\\w$?&])${esc(c)}\\s*!?=\\s*["'](true|false)["']`).test(code))
      problems.push(`${c} arrives as 1/0 but is compared with 'true'/'false'`);
    if (
      fields.some(
        (f) => f.field === c && f.map && typeof f.map === 'object' && ('true' in f.map || 'false' in f.map),
      )
    )
      problems.push(`${c} arrives as 1/0 but its status map is keyed "true"/"false"`);
  }
  return problems;
}

/** Fixture rows for the query (variants matched by its `// af:<id>#<name>` first line) that Resource Graph can't send. */
function fixtureProblemsOf(q: RgQuery, from: typeof variants = variants): string[] {
  const tag = /^\s*\/\/\s*(af:\S+)/.exec(q.query)?.[1]?.toLowerCase();
  if (!tag) return [];
  const bools = outputColumns(q.query, 'bool');
  const texts = outputColumns(q.query, 'flagText');
  const problems: string[] = [];
  for (const v of from) {
    const first = [v.match?.bodyIncludes ?? []].flat()[0];
    if (first?.toLowerCase() !== tag) continue;
    for (const [i, row] of (v.body?.data ?? []).entries()) {
      const r = row as Record<string, unknown>;
      for (const c of bools)
        if (r[c] !== undefined && r[c] !== null && r[c] !== 0 && r[c] !== 1)
          problems.push(`row ${i}: ${c} = ${JSON.stringify(r[c])}, Resource Graph sends 1/0 (or null)`);
      for (const c of texts)
        if (r[c] !== undefined && r[c] !== null && r[c] !== 'true' && r[c] !== 'false')
          problems.push(`row ${i}: ${c} = ${JSON.stringify(r[c])}, the query sends 'true'/'false'`);
    }
  }
  return problems;
}

describe('KQL column types (tests/lib/kql-columns.ts)', () => {
  const t = (expr: string, cols: Record<string, 'bool' | 'flagText' | 'other'> = {}) =>
    classify(expr, new Map(Object.entries(cols)));

  it('knows what Resource Graph sends as 1/0', () => {
    for (const e of [
      "roleName in~ ('Owner', 'User Access Administrator')",
      'isnotempty(condition)',
      'site != scope',
      'tobool(properties.httpsOnly)',
      'coalesce(tobool(properties.httpsOnly), false)',
      'iff(isnull(properties.allowSharedKeyAccess), true, tobool(properties.allowSharedKeyAccess))',
      "kind contains 'linux'",
      "t == 'microsoft.cache/redis' and coalesce(tobool(properties.enableNonSslPort), false)",
      "(scope == '/')",
      'not(isLinux)',
    ])
      expect([e, t(e)]).toEqual([e, 'bool']);
    expect(t('any(p)', { p: 'bool' })).toBe('bool');
  });

  it('knows text flags and everything else', () => {
    expect(t("iff(privileged, 'true', 'false')", { privileged: 'bool' })).toBe('flagText');
    expect(t("iff(isnotempty(condition), 'true', 'false')")).toBe('flagText');
    for (const e of [
      'properties.enabled',
      'tostring(properties.state)',
      "case(scope == '/', 'Root', depth == 3, 'Subscription', 'Resource')",
      "iff(kind contains 'linux', 'Linux', 'Windows')",
      'iff(httpsOnly, 0, 1) + iff(remoteDebugging, 1, 0)',
      'countif(extFailed)',
      'tostring(1 == 1)',
      'array_length(split(scope, "/"))',
    ])
      expect([e, t(e)]).toEqual([e, 'other']);
  });

  it('follows a query through extend, project, summarize, joins and template fragments', () => {
    const q = `// af:test#rows
      authorizationresources
      | where type =~ 'microsoft.authorization/roleassignments' and scope == '\${ $lowercase(params.id) }'
      | extend scope = tolower(tostring(properties.scope)), hasCondition = isnotempty(tostring(properties.condition))
      \${ params.x ? '| extend ignored = a == b' }
      | join kind=leftouter (resources | extend failed = tostring(properties.provisioningState) != 'Succeeded' | summarize failedCount = countif(failed), anyFailed = any(failed) by scope) on scope
      | extend privileged = roleName in~ ('Owner')
      | project id, privileged = iff(privileged, 'true', 'false'), hasCondition, failedCount, anyFailed, raw = properties.enabled
      | extend later = failedCount > 0`;
    const { columns, outputs } = analyzeKql(q);
    expect(outputs).toEqual(['id', 'privileged', 'hasCondition', 'failedCount', 'anyFailed', 'raw', 'later']);
    expect(Object.fromEntries(outputs!.map((c) => [c, columns.get(c)]))).toEqual({
      id: 'other',
      privileged: 'flagText',
      hasCondition: 'bool',
      failedCount: 'other',
      anyFailed: 'bool',
      raw: 'other',
      later: 'bool',
    });
    expect(columns.has('ignored')).toBe(false);
  });
});

describe('Resource Graph booleans in portal/content', () => {
  it('finds every Resource Graph query', () => {
    expect(queries.length).toBeGreaterThan(70);
    for (const id of ['azure.role-assignments#assignments', 'probes.key-vault-purge-protection (check)'])
      expect(queries.map((q) => q.label)).toContain(id);
    expect(queries.some((q) => q.label.startsWith('azure.create-resource-group#'))).toBe(true);
  });

  it.each(queries.map((q) => [q.label, q] as const))(
    '%s: transforms, widgets and actions read flags the way Resource Graph sends them',
    (_, q) => {
      expect(problemsOf(q)).toEqual([]);
    },
  );

  it.each(queries.map((q) => [q.label, q] as const))(
    '%s: fixtures have the shape Resource Graph sends',
    (_, q) => {
      expect(fixtureProblemsOf(q)).toEqual([]);
    },
  );

  it('would have caught the azure.role-assignments Privileged KPI and the other production bugs', () => {
    const page = (id: string) => loaded.definitions.find((d) => d.def.id === id)!.def as Def;
    // azure.role-assignments 1.0.0: flags projected as computed booleans, counted as `= true`, mapped as "true".
    const before = structuredClone(page('azure.role-assignments'));
    before.datasources.assignments.query = before.datasources.assignments.query
      .replace("privileged = iff(privileged, 'true', 'false')", 'privileged')
      .replace(
        "hasCondition = iff(isnotempty(condition), 'true', 'false')",
        'hasCondition = isnotempty(condition)',
      );
    before.datasources.assignments.transform = before.datasources.assignments.transform.replace(
      "privileged = 'true'",
      'privileged = true',
    );
    expect(problemsOf(collect(before)[0]!)).toEqual([
      'privileged arrives as 1/0 but is compared with true/false',
      'privileged arrives as 1/0 but its status map is keyed "true"/"false"',
      'hasCondition arrives as 1/0 but its status map is keyed "true"/"false"',
    ]);
    // azure.resource 1.1.0: `when: ${ row.inherited = false }` hid Remove assignment on every row.
    const resource = structuredClone(page('azure.resource'));
    resource.datasources.access.query = resource.datasources.access.query.replace(
      /inherited = iff\((.*?), 'true', 'false'\)\n/,
      'inherited = $1\n',
    );
    for (const a of objects(resource.tabs).filter((o) => o.playbook === 'azure.remove-role-assignment'))
      a.when = '${ row.inherited = false }';
    expect(problemsOf(collect(resource).find((q) => q.label === 'azure.resource#access')!)).toEqual([
      'inherited arrives as 1/0 but is compared with true/false',
      'inherited arrives as 1/0 but its status map is keyed "true"/"false"',
    ]);
    // Fixtures holding JSON true/false for computed columns are what hid it.
    const old = { label: 'x', query: before.datasources.assignments.query, consumers: [] };
    const fixture = (privileged: unknown) => [
      { match: { bodyIncludes: 'af:azure.role-assignments#assignments' }, body: { data: [{ privileged }] } },
    ];
    expect(fixtureProblemsOf(old, fixture(true))).toEqual([
      'row 0: privileged = true, Resource Graph sends 1/0 (or null)',
    ]);
    expect(fixtureProblemsOf(old, fixture(1))).toEqual([]);
    expect(fixtureProblemsOf(collect(page('azure.role-assignments'))[0]!, fixture(1))).toEqual([
      "row 0: privileged = 1, the query sends 'true'/'false'",
    ]);
  });
});

describe('pages fixed for Resource Graph 1/0 booleans render their fixtures correctly', () => {
  const fetchFixture = createFixtureFetch(path.join(repoRoot, 'tests/fixtures'));
  const NOW = '2026-10-15T12:00:00Z';
  const S1 = '00000000-0000-4000-8000-0000000000a1';
  const user = {
    oid: '00000000-0000-4000-8000-000000000001',
    upn: 'tester@example.com',
    roles: ['Portal.Reader'],
  };
  const env = { AF_SUBSCRIPTION_ID: S1 };
  const def = (id: string) => loaded.definitions.find((d) => d.def.id === id)!.def as Def;

  /** Runs the page's Resource Graph datasources against the fixtures, as DATA_MODE=fixtures does. */
  async function run(id: string, input: Record<string, unknown>) {
    const params = await resolveParams(def(id).params, input, { env, now: NOW, user } as never);
    const ds: Record<string, Def> = {};
    for (const [name, d] of Object.entries<Def>(def(id).datasources)) {
      if (d.source !== 'resourceGraph') continue;
      const scope = { params, env, now: NOW, user, ds };
      const query = (await renderString(d.query, scope)) as string;
      const res = await fetchFixture(
        'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01',
        { method: 'POST', body: JSON.stringify({ query, options: { resultFormat: 'objectArray' } }) },
      );
      expect([id, name, res.status]).toEqual([id, name, 200]);
      const value = { value: ((await res.json()) as { data: unknown[] }).data };
      ds[name] = d.transform ? await renderString(d.transform, { ...scope, value }) : value;
    }
    return ds;
  }

  const PAGES: Array<[string, Record<string, unknown>]> = [
    ['azure.role-assignments', {}],
    [
      'azure.resource',
      {
        id: `/subscriptions/${S1}/resourceGroups/rg-example-functions/providers/Microsoft.Web/sites/func-example`,
      },
    ],
    ['azure.subscription', { id: S1 }],
    ['azure.function-apps', {}],
    [
      'azure.function-app',
      { subscriptionId: S1, resourceGroup: 'rg-example-functions', name: 'func-example' },
    ],
    [
      'azure.arc-server',
      {
        id: `/subscriptions/${S1}/resourceGroups/rg-example-arc/providers/Microsoft.HybridCompute/machines/srv-example-01`,
      },
    ],
    ['azure.log-analytics', {}],
    ['security.cloud-alerts', {}],
  ];

  it.each(PAGES)(
    '%s: every flag value in a table hits its status map (a label, never a raw 1/0)',
    async (id, input) => {
      const ds = await run(id, input);
      let checked = 0;
      for (const w of objects(def(id).layout ?? def(id).tabs).filter((o) => o.widget === 'table')) {
        const rows = (w.data as string).split('.').reduce<Def>((o, k) => o?.[k], ds);
        if (!Array.isArray(rows)) continue;
        for (const col of (w.columns as Def[]).filter((c) => c.map && ('true' in c.map || 'false' in c.map)))
          for (const r of rows) {
            expect([id, col.field, r[col.field]]).toEqual([
              id,
              col.field,
              expect.stringMatching(/^(true|false)$/),
            ]);
            checked++;
          }
      }
      expect(checked).toBeGreaterThan(0);
    },
  );

  it('azure.role-assignments counts privileged assignments', async () => {
    const { assignments } = await run('azure.role-assignments', {});
    expect(assignments.privileged).toBe(assignments.rows.filter((r: Def) => r.privileged === 'true').length);
    expect(assignments.privileged).toBe(4);
  });

  it('azure.function-apps counts apps that allow plain HTTP', async () => {
    const { apps } = await run('azure.function-apps', {});
    expect(apps.httpAllowed).toBe(apps.rows.filter((r: Def) => r.httpsOnly === 'false').length);
    expect(apps.httpAllowed).toBe(1);
  });

  it('azure.resource offers Remove assignment only on assignments made on the resource itself', async () => {
    const { access } = await run('azure.resource', PAGES[1]![1]);
    const table = objects(def('azure.resource').tabs).find(
      (o) => o.widget === 'table' && o.data === 'access.value',
    )!;
    const remove = (table.rowActions as Def[]).find((a) => a.playbook === 'azure.remove-role-assignment');
    const shown = [];
    for (const row of access.value) shown.push([row.inherited, await renderString(remove.when, { row })]);
    expect(shown.filter(([, s]) => s === true)).toEqual([['false', true]]);
    expect(shown).toHaveLength(8);
  });
});
