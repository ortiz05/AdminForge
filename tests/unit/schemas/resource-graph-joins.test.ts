import { resourceGraphJoinProblem } from '@adminforge/schemas';
import { ENVELOPE, errors } from './helpers';

// Resource Graph refuses a query with more than three join/union operations, more than one join to another table
// (unless all of them are between resources and resourcecontainers) or a union across other tables — validate says
// so before anyone runs it.
describe('Resource Graph join limits', () => {
  it.each([
    ['resources | where type =~ "microsoft.compute/virtualmachines"'],
    ['resources | join kind=leftouter (resourcecontainers | where type == "x") on subscriptionId'],
    [
      'resources | join (resourcecontainers | project a) on subscriptionId | join kind=leftouter (resourcecontainers | project b) on resourceGroup | union (resourcecontainers | where 1 == 1)',
    ],
    [
      'desktopvirtualizationresources | join kind=leftouter (desktopvirtualizationresources | project h) on id',
    ],
    ['patchassessmentresources | join kind=leftouter (patchinstallationresources | project x) on id'],
    ['// af:probes.x\nsecurityresources | where name has "join resources" | union securityresources'],
    ['resources | where name == \'${ $kql(params.q & " | join a | join b | join c | join d") }\''],
  ])('accepts %s', (q) => expect(resourceGraphJoinProblem(q)).toBeNull());

  it('refuses a second join to another table', () =>
    expect(
      resourceGraphJoinProblem(
        'desktopvirtualizationresources | join kind=leftouter (resourcecontainers | project s) on subscriptionId | join kind=leftouter (resources | project v) on id',
      ),
    ).toMatch(
      /only one join to another table.*desktopvirtualizationresources to resourcecontainers, resources/,
    ));

  it('refuses more than three operations', () =>
    expect(
      resourceGraphJoinProblem(
        'resources | join (resources) on id | union (resources) | join (resources) on id | union resources',
      ),
    ).toMatch(/at most three join or union operations.*4/));

  it('refuses a union across tables other than resources and resourcecontainers', () =>
    expect(resourceGraphJoinProblem('resources | union (securityresources | where 1 == 1)')).toMatch(
      /only unions within one table/,
    ));

  it('is checked on Resource Graph datasources and KQL probes', () => {
    const bad =
      'resources | join kind=leftouter (patchassessmentresources) on id | join kind=leftouter (patchinstallationresources) on id';
    const page = `${ENVELOPE('page', 'azure.example')}template: dashboard\ndatasources:\n  x:\n    source: resourceGraph\n    query: ${JSON.stringify(bad)}\nlayout:\n  - { widget: markdown, text: Hi }\n`;
    expect(
      errors(page)
        .map((e) => e.message)
        .join('\n'),
    ).toMatch(/only one join to another table/);
    const probe = `${ENVELOPE('probe', 'probes.example')}check:\n  kind: kql\n  source: resourceGraph\n  query: ${JSON.stringify(bad)}\n`;
    expect(
      errors(probe)
        .map((e) => `${e.path}: ${e.message}`)
        .join('\n'),
    ).toMatch(/check.query: Resource Graph allows only one join/);
  });
});
