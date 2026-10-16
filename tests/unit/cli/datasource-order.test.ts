import { datasourceOrderProblems } from '@adminforge/cli/src/content/lint';

// Authors declare a datasource's dependencies above it (readable files, no loops). The runtime doesn't rely on it.
describe('validate: datasource declaration order', () => {
  const graph = (path: string) => ({ source: 'graph', request: { path } });

  it('accepts dependencies declared first', () => {
    expect(
      datasourceOrderProblems({
        datasources: { users: graph('/users'), groups: { ...graph('/groups'), transform: '${ ds.users }' } },
      }),
    ).toEqual([]);
  });

  it('flags a reference to a datasource declared later, and one to itself', () => {
    const problems = datasourceOrderProblems({
      datasources: {
        early: { ...graph('/a'), transform: '${ ds.late.value }' },
        late: graph('/b'),
        self: { ...graph('/c'), when: '${ ds.self }' },
      },
    });
    expect(problems.map((p) => p.datasource)).toEqual(['early', 'self']);
    expect(problems[0]!.message).toMatch(/ds\.late, which is declared after it/);
    expect(problems[1]!.message).toMatch(/its own result/);
  });

  it('ignores names that are not datasources', () => {
    expect(
      datasourceOrderProblems({ datasources: { a: { ...graph('/a'), transform: '${ ds.row }' } } }),
    ).toEqual([]);
  });
});
