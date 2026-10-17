import { DatasourceRunner, type LoadedPage } from '@adminforge/api/src/datasources/executor';
import { ReauthRequired } from '@adminforge/api/src/auth/types';
import type { DefinitionRegistry } from '@adminforge/api/src/definitions/types';
import { ApiError } from '@adminforge/connectors';
import { Datasources } from '@adminforge/schemas';

// `optional: true` on a datasource: the datasources that use it (`ds.<name>`) see `null` when it fails, instead of
// failing with `dependency_failed`; its own result still carries the error.
const datasources = Datasources.parse({
  archived: {
    source: 'graph',
    optional: true,
    request: { path: '/teams', query: { $select: 'id,isArchived' } },
  },
  required: { source: 'graph', request: { path: '/organization' } },
  teams: {
    source: 'graph',
    request: { path: '/groups' },
    transform:
      "${ { 'archivedKnown': $exists(ds.archived) and ds.archived != null, 'groups': $count(value.value) } }",
  },
  strict: {
    source: 'static',
    data: '${ ds.required.value }',
  },
});

const page: LoadedPage = {
  kind: 'report',
  key: 'test.optional',
  version: '1.0.0',
  sha256: 'a'.repeat(64),
  def: { datasources } as LoadedPage['def'],
};

function runnerFor(failing: Set<string>) {
  const calls: string[] = [];
  const runner = new DatasourceRunner({
    definitions: { onChange: () => undefined } as unknown as DefinitionRegistry,
    outbound: {
      execute: async (_identity: unknown, call: { path: string }) => {
        calls.push(call.path);
        if (failing.has(call.path))
          throw new ApiError(403, 'Forbidden', 'Failed to get license information for the user.', 'req-1');
        return { data: { value: [{ id: 'g1' }, { id: 'g2' }] }, provenance: null };
      },
    } as unknown as ConstructorParameters<typeof DatasourceRunner>[0]['outbound'],
    env: () => ({}),
    now: () => new Date('2026-10-16T00:00:00Z'),
  });
  return { runner, calls };
}

const base = {
  identity: { kind: 'automation' as const, mode: 'read' as const },
  user: { oid: 'u', upn: 'u@example.com', name: 'U', roles: [] },
  page,
  params: {},
  correlationId: 'c',
};

describe('optional datasources', () => {
  it('execute-many: a failed optional datasource leaves its dependents running with null', async () => {
    const { runner } = runnerFor(new Set(['/teams']));
    const results = await runner.runMany(base, ['archived', 'teams']);
    expect(results.archived).toEqual({ error: expect.objectContaining({ code: 'upstream_forbidden' }) });
    expect(results.teams).toMatchObject({ data: { archivedKnown: false, groups: 2 } });
  });

  it('single execute: the dependency resolved server-side is null too', async () => {
    const { runner } = runnerFor(new Set(['/teams']));
    const out = await runner.run({ ...base, datasource: 'teams' });
    expect(out.data).toEqual({ archivedKnown: false, groups: 2 });
  });

  it('when the optional datasource works, dependents get its data', async () => {
    const { runner, calls } = runnerFor(new Set());
    const results = await runner.runMany(base, ['teams']);
    expect(results.teams).toMatchObject({ data: { archivedKnown: true, groups: 2 } });
    expect(calls.sort()).toEqual(['/groups', '/teams']);
  });

  it('a sign-in or arm problem is not swallowed by `optional`', async () => {
    const runner = new DatasourceRunner({
      definitions: { onChange: () => undefined } as unknown as DefinitionRegistry,
      outbound: {
        execute: async (_identity: unknown, call: { path: string }) => {
          if (call.path === '/teams') throw new ReauthRequired('read');
          return { data: { value: [] }, provenance: null };
        },
      } as unknown as ConstructorParameters<typeof DatasourceRunner>[0]['outbound'],
      env: () => ({}),
      now: () => new Date('2026-10-16T00:00:00Z'),
    });
    const results = await runner.runMany(base, ['teams']);
    expect(results.teams).toEqual({ error: expect.objectContaining({ code: 'dependency_failed' }) });
  });

  it('dependencies without `optional` still fail their dependents', async () => {
    const { runner } = runnerFor(new Set(['/organization']));
    const results = await runner.runMany(base, ['strict']);
    expect(results.strict).toEqual({
      error: expect.objectContaining({
        code: 'dependency_failed',
        // The dependency's own error, not the internal datasource names.
        message: expect.not.stringContaining('"required"'),
      }),
    });
  });
});
