import { ResourceGraphDatasource, startsWithUnion } from '@adminforge/schemas';
import { ENVELOPE, errors, ok } from './helpers';

// Resource Graph rejects `union a, b` at the start of a query ("Failed to resolve table expression named 'resources'"),
// which fixtures never show; validation catches it before it reaches Microsoft.

describe('Resource Graph queries starting with union', () => {
  it.each([
    'union resources, resourcecontainers | take 1',
    '// af:azure.resource#resource\nunion resources, resourcecontainers\n| take 1',
    '  UNION (resources), (resourcecontainers)',
  ])('rejects %j', (query) => {
    expect(startsWithUnion(query)).toBe(true);
    const r = ResourceGraphDatasource.safeParse({ source: 'resourceGraph', query });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/can't start a query with union/);
  });

  it.each([
    "resources\n| where id == 'x'\n| union (resourcecontainers | where id == 'x')",
    '// comment that mentions union\nresources | take 1',
    'resourcecontainers | where name has "union"',
  ])('accepts %j', (query) => {
    expect(startsWithUnion(query)).toBe(false);
    expect(ResourceGraphDatasource.safeParse({ source: 'resourceGraph', query }).success).toBe(true);
  });

  const probe = (source: string, query: string) =>
    `${ENVELOPE('probe', 'probes.example')}check:\n  kind: kql\n  source: ${source}\n  query: "${query}"\n${
      source === 'logAnalytics' ? '  workspace: "${ env.AF_LOG_ANALYTICS_WORKSPACE_ID }"\n' : ''
    }`;

  it('rejects it in a resourceGraph probe check', () => {
    const e = errors(probe('resourceGraph', 'union resources, resourcecontainers'));
    expect(e.map((x) => x.message).join('\n')).toMatch(/can't start a query with union/);
  });

  it('still allows a leading union in Log Analytics, where it is valid', () => {
    ok(probe('logAnalytics', 'union AzureActivity, AzureDiagnostics | take 1'));
  });
});
