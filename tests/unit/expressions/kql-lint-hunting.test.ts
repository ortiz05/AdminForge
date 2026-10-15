import { lintExpressions } from '@adminforge/expressions';

// Defender advanced hunting goes through Graph (POST /security/runHuntingQuery, body { Query }); its KQL gets the same
// "user data only through $kql()" lint as Resource Graph / Log Analytics queries.
const hunting = (query: string) => ({
  datasources: {
    vulns: {
      source: 'graph',
      request: { method: 'POST', path: '/security/runHuntingQuery', body: { Query: query } },
    },
  },
});

describe('KQL lint on advanced hunting bodies', () => {
  it('flags user data that reaches body.Query without $kql()', () => {
    const issues = lintExpressions(
      hunting("DeviceInfo\n| where DeviceName startswith '${ params.q }'\n| take 10"),
    );
    expect(issues.map((i) => i.path)).toEqual(['datasources.vulns.request.body.Query']);
    expect(issues[0]!.message).toMatch(/without \$kql\(\)/);
  });

  it('accepts quoted values and allowlisted choices', () => {
    expect(
      lintExpressions(
        hunting(
          [
            'DeviceTvmSoftwareVulnerabilities',
            "${ params.q ? '| where DeviceName startswith ' & $kql(params.q) : '' }",
            "${ params.severity in ['Critical', 'High'] ? '| where VulnerabilitySeverityLevel == ' & $kql(params.severity) : '' }",
          ].join('\n'),
        ),
      ),
    ).toEqual([]);
  });

  it('leaves other body fields and capitalised keys elsewhere alone', () => {
    expect(
      lintExpressions({
        steps: [{ request: { body: { Title: 'x ${ inputs.name }' } } }],
        datasources: { a: { Query: 'x ${ params.q }' } },
      }),
    ).toEqual([]);
  });
});
