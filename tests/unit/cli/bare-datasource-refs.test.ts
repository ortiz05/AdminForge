import { bareDatasourceRefs } from '@adminforge/cli/src/commands/content';

// Inside a datasource, other datasources are `ds.<name>`; a bare name is undefined there, so the datasource is silently
// skipped (`when`) or calls the wrong path. `adminforge validate` reports it.
describe('bareDatasourceRefs', () => {
  it('flags a bare datasource name in when, request and runner parameters', () => {
    const def = {
      datasources: {
        group: { source: 'graph', request: { path: '/groups/x' } },
        team: { source: 'graph', when: '${ group.isTeam = true }', request: { path: '/teams/x' } },
        members: {
          source: 'graph',
          request: { path: "/groups/${ $encode($guid(group['id'])) }/members" },
        },
        policies: { source: 'runner', script: 'x.ps1', parameters: { identity: '${ group.mail }' } },
      },
    };
    expect(bareDatasourceRefs(def)).toEqual([
      { path: 'datasources.team.when', name: 'group', datasource: 'team' },
      { path: 'datasources.members.request.path', name: 'group', datasource: 'members' },
      { path: 'datasources.policies.parameters.identity', name: 'group', datasource: 'policies' },
    ]);
  });

  it('accepts ds.<name>, string literals, row fields in transforms and the datasource itself', () => {
    const def = {
      datasources: {
        owners: { source: 'graph', request: { path: '/groups/x/owners' } },
        group: {
          source: 'graph',
          when: "${ $exists(ds.owners.value) and params.kind != 'owners.x' }",
          request: { path: '/groups/${ $encode(params.id) }', query: { $filter: '${ "owners.y" }' } },
          transform: '${ value.value.{ "n": $count(owners.displayName), "g": group.id } }',
        },
      },
    };
    expect(bareDatasourceRefs(def)).toEqual([]);
    expect(bareDatasourceRefs({ kind: 'playbook' })).toEqual([]);
  });
});
