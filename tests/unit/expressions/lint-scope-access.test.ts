import { lintExpressions } from '@adminforge/expressions';

// The query lint must also see user data reached without naming it: the root scope (`$`, `$$`), a wildcard or a
// descendant (`$.*.q`, `**.q`), or a function given the scope (`$each($, …)`, `$sift($, …)`).
const graphQuery = (query: Record<string, string>) => ({
  datasources: { users: { source: 'graph', request: { path: '/users', query } } },
});
const flagged = (q: Record<string, string>) => lintExpressions(graphQuery(q)).map((i) => i.path);

describe('lint: user data reached through the scope', () => {
  it.each([
    ["startswith(displayName,'${ $.*.q }')"],
    ["startswith(displayName,'${ **.q }')"],
    ["startswith(displayName,'${ $$.params.q }')"],
    ["startswith(displayName,'${ $.params.q }')"],
    ["${ 'id eq ' & $join($each($, function($v) { $string($v) }), '') }"],
    ["${ 'id eq ' & $string($sift($, function($v, $k) { $k = 'params' })) }"],
  ])('flags %s in $filter', (filter) => {
    expect(flagged({ $filter: filter })).toEqual(['datasources.users.request.query.$filter']);
  });

  it('accepts the scope passed through a quoting helper', () => {
    expect(flagged({ $filter: 'startswith(displayName,${ $odata($.*.q) })' })).toEqual([]);
    expect(flagged({ $filter: 'id eq ${ $guid($.params.id) }' })).toEqual([]);
  });
});
