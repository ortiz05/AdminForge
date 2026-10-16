import { DatasourceRunner } from '@adminforge/api/src/datasources/executor';
import type { LoadedPage } from '@adminforge/api/src/datasources/executor';
import { AppError } from '@adminforge/api/src/errors';

// Published definitions live in a Postgres jsonb column, which returns object keys shorter-first instead of in the
// order they were written. Dependencies must therefore come from the `ds.<name>` references, never from key order.
// dependencies() needs no I/O: only the definitions' change hook is touched by the constructor.
const runner = new DatasourceRunner({
  definitions: { onChange: () => () => undefined },
} as unknown as ConstructorParameters<typeof DatasourceRunner>[0]);

const page = (datasources: Record<string, unknown>): LoadedPage =>
  ({
    kind: 'report',
    key: `test.order-${Math.random().toString(36).slice(2)}`,
    version: '1.0.0',
    sha256: Math.random().toString(36),
    def: { datasources },
  }) as unknown as LoadedPage;

const graph = (path: string) => ({ source: 'graph', request: { path } });

describe('datasource dependencies come from references, not key order', () => {
  it('a dependent that sorts before its dependency (as jsonb returns it) still resolves', () => {
    // jsonb order: "teams" (5 chars) before "archived" (8 chars); teams reads ds.archived.
    const p = page({
      teams: { ...graph('/groups'), transform: '${ ds.archived.ids }' },
      archived: graph('/teams'),
    });
    expect(runner.dependencies(p, 'teams')).toEqual(['archived']);
    expect(runner.dependencies(p, 'archived')).toEqual([]);
  });

  it('transitive chains in any key order resolve to the direct dependencies', () => {
    const p = page({
      c: { ...graph('/c'), transform: '${ ds.b }' },
      a: graph('/a'),
      b: { ...graph('/b'), when: '${ ds.a.value }' },
    });
    expect(runner.dependencies(p, 'c')).toEqual(['b']);
    expect(runner.dependencies(p, 'b')).toEqual(['a']);
  });

  it('references to names that are not datasources are ignored', () => {
    const p = page({ a: { ...graph('/a'), transform: '${ ds.nothing }' } });
    expect(runner.dependencies(p, 'a')).toEqual([]);
  });

  it('a loop (or a datasource referencing itself) is a content error that names the loop', () => {
    const loop = page({
      a: { ...graph('/a'), transform: '${ ds.b }' },
      b: { ...graph('/b'), transform: '${ ds.a }' },
    });
    expect(() => runner.dependencies(loop, 'a')).toThrow(AppError);
    expect(() => runner.dependencies(loop, 'a')).toThrow(/ds\.a → ds\.b → ds\.a/);
    const self = page({ a: { ...graph('/a'), transform: '${ ds.a }' } });
    expect(() => runner.dependencies(self, 'a')).toThrow(/loop/);
  });
});
