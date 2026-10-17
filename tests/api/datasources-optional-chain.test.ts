import { DatasourceRunner, type LoadedPage } from '@adminforge/api/src/datasources/executor';
import type { DefinitionRegistry } from '@adminforge/api/src/definitions/types';
import { OutboundError, PolicyDenied } from '@adminforge/api/src/execution/outbound';
import { exportPages, planExport, trackIncomplete } from '@adminforge/api/src/reports/export';
import { ApiError } from '@adminforge/connectors';
import { Datasources } from '@adminforge/schemas';

// `optional: true` never hides a failure the person has to see — a missing portal role, the request policy, a
// missing licence, sign-in or arming — anywhere in the chain behind it; what it does suppress is recorded in the
// dependents' `errors` (`ds.<name>`), logged, and reaches exports.

const datasources = Datasources.parse({
  // Needs a portal role the viewer doesn't hold (`forbidden`), when `secretRole` is set.
  secret: { source: 'graph', request: { path: '/secret' } },
  enrich: {
    source: 'graph',
    label: 'Enrichment',
    optional: true,
    request: { path: '/enrich' },
    transform: "${ { 'secretCount': $count(ds.secret.value) } }",
  },
  rows: {
    source: 'graph',
    request: { path: '/rows' },
    paging: 'all',
    transform: "${ { 'enriched': ds.enrich != null, 'value': value.value } }",
  },
  summary: { source: 'static', data: '${ $count(ds.rows.value) }' },
});

function page(secretRole = false): LoadedPage {
  const ds = structuredClone(datasources);
  if (secretRole) ds.secret!.requires = { portalRoles: ['Portal.Admin'] };
  return {
    kind: 'report',
    key: 'test.optional-chain',
    version: '1.0.0',
    sha256: (secretRole ? 'b' : 'a').repeat(64),
    def: {
      datasources: ds,
      layout: [{ widget: 'table', data: 'rows.value', columns: [{ field: 'id', label: 'Id' }] }],
      export: { formats: ['csv'], data: 'rows.value', columns: 'all' },
    } as unknown as LoadedPage['def'],
  };
}

function runnerFor(fail: Record<string, () => unknown>) {
  const warnings: Array<Record<string, unknown>> = [];
  const runner = new DatasourceRunner({
    definitions: { onChange: () => undefined } as unknown as DefinitionRegistry,
    outbound: {
      execute: async (_identity: unknown, call: { path: string }) => {
        const f = fail[call.path];
        if (f) throw f();
        return { data: { value: [{ id: 'a' }, { id: 'b' }] }, provenance: null };
      },
    } as unknown as ConstructorParameters<typeof DatasourceRunner>[0]['outbound'],
    env: () => ({}),
    now: () => new Date('2026-10-16T00:00:00Z'),
    log: { warn: (obj) => warnings.push(obj as Record<string, unknown>) },
  });
  return { runner, warnings };
}

const base = (p = page()) => ({
  identity: { kind: 'automation' as const, mode: 'read' as const },
  user: { oid: 'u', upn: 'u@example.com', name: 'U', roles: ['Portal.Reader'] },
  page: p,
  params: {},
  correlationId: 'c',
});

const upstream503 = () => new ApiError(503, 'ServiceUnavailable', 'Try later.', 'req-1');

describe('optional datasources: what is never swallowed', () => {
  it('a portal-role failure further up the chain fails the dependents (execute-many and single execute)', async () => {
    const { runner, warnings } = runnerFor({});
    const p = page(true);
    const results = await runner.runMany(base(p), ['rows', 'summary']);
    expect(results.rows).toEqual({
      error: expect.objectContaining({
        code: 'dependency_failed',
        // The person sees what really failed (the missing role), not the chain of internal datasource names.
        message: 'Datasource secret needs the Portal.Admin role.',
        hint: expect.stringContaining('Portal.Admin'),
      }),
    });
    expect(results.summary).toEqual({ error: expect.objectContaining({ code: 'dependency_failed' }) });
    await expect(runner.run({ ...base(p), datasource: 'rows' })).rejects.toMatchObject({
      code: 'dependency_failed',
    });
    expect(warnings).toEqual([]);
  });

  it('policy_denied on the optional datasource fails its dependents', async () => {
    const { runner } = runnerFor({ '/enrich': () => new PolicyDenied('Writes need an armed session.') });
    const results = await runner.runMany(base(), ['rows']);
    expect(results.rows).toEqual({ error: expect.objectContaining({ code: 'dependency_failed' }) });
    await expect(runner.run({ ...base(), datasource: 'rows' })).rejects.toMatchObject({
      code: 'dependency_failed',
    });
  });

  it('a missing tenant licence on the optional datasource fails its dependents', async () => {
    const { runner } = runnerFor({
      '/enrich': () =>
        new OutboundError(
          new ApiError(403, 'Forbidden', 'Tenant does not have a SPO license.'),
          'graph',
          'licence',
          true,
        ),
    });
    const results = await runner.runMany(base(), ['rows']);
    expect(results.rows).toEqual({ error: expect.objectContaining({ code: 'dependency_failed' }) });
  });
});

describe('optional datasources: what is suppressed is recorded', () => {
  it('the dependent runs with null and carries the failure as errors["ds.enrich"]; it is logged', async () => {
    const { runner, warnings } = runnerFor({ '/enrich': upstream503 });
    const results = await runner.runMany(base(), ['enrich', 'rows', 'summary']);
    expect(results.enrich).toEqual({ error: expect.objectContaining({ code: 'upstream_error' }) });
    expect(results.rows).toMatchObject({
      data: { enriched: false },
      errors: { 'ds.enrich': expect.objectContaining({ code: 'upstream_error' }) },
    });
    // Further down the chain too: the summary was built from incomplete rows.
    expect(results.summary).toMatchObject({
      data: 2,
      errors: { 'ds.enrich': expect.objectContaining({ code: 'upstream_error' }) },
    });
    expect(warnings).toEqual([
      expect.objectContaining({ datasource: 'rows', dependency: 'enrich', code: 'upstream_error' }),
    ]);
    // Names and codes only: no messages (they can carry Microsoft's text) in the log line.
    expect(JSON.stringify(warnings)).not.toContain('Try later');

    const single = await runner.run({ ...base(), datasource: 'summary' });
    expect(single.errors).toEqual({ 'ds.enrich': expect.objectContaining({ code: 'upstream_error' }) });
  });

  it('an ordinary failure behind the optional datasource is suppressed as dependency_failed (cause kept)', async () => {
    const { runner } = runnerFor({ '/secret': upstream503 });
    const results = await runner.runMany(base(), ['rows']);
    expect(results.rows).toMatchObject({
      data: { enriched: false },
      errors: {
        'ds.enrich': expect.objectContaining({
          code: 'dependency_failed',
          message: 'Try later.',
          hint: expect.stringContaining('request-id: req-1'),
        }),
      },
    });
  });

  it('nothing is recorded when the optional datasource works', async () => {
    const { runner, warnings } = runnerFor({});
    const results = await runner.runMany(base(), ['rows']);
    expect(results.rows).toMatchObject({ data: { enriched: true } });
    expect((results.rows as { errors?: unknown }).errors).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe('exports of a datasource with a failed optional dependency', () => {
  it('every page says the file is incomplete', async () => {
    const { runner } = runnerFor({ '/enrich': upstream503 });
    const p = page();
    const plan = await planExport(p, {}, 'csv', { maxRows: 100 });
    const tracked = trackIncomplete(exportPages(runner, base(p), plan));
    const pages = [];
    for await (const x of tracked.pages) pages.push(x);
    expect(pages[0]).toMatchObject({
      rows: [{ id: 'a' }, { id: 'b' }],
      incomplete: { 'ds.enrich': expect.objectContaining({ code: 'upstream_error' }) },
    });
    expect(tracked.incomplete).toEqual({ 'ds.enrich': expect.objectContaining({ code: 'upstream_error' }) });
  });

  it('a complete export has no `incomplete`', async () => {
    const { runner } = runnerFor({});
    const p = page();
    const plan = await planExport(p, {}, 'csv', { maxRows: 100 });
    const tracked = trackIncomplete(exportPages(runner, base(p), plan));
    for await (const x of tracked.pages) expect(x.incomplete).toBeUndefined();
    expect(tracked.incomplete).toEqual({});
  });
});
