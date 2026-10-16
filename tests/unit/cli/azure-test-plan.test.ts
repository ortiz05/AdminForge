import { randomUUID } from 'node:crypto';
import { LOG_ANALYTICS_READER_ROLE_ID } from '@adminforge/cli/src/provision/catalog';
import {
  ACTIVITY_LOG_CATEGORIES,
  buildDesiredAzureTest,
  DAILY_CAP_GB,
  notProvisioned,
  planAzureTest,
  type AzureTestState,
  type DesiredAzureTest,
} from '@adminforge/cli/src/provision/azure-test-plan';

const SUB = randomUUID();
const AUTOMATION = randomUUID();
const TESTER = randomUUID();
const CUSTOMER = randomUUID();

const desired = (location = 'eastus') =>
  buildDesiredAzureTest({ label: 'test', subscriptionId: SUB, location });

const empty = (): AzureTestState => ({
  principals: { automation: AUTOMATION, tester: TESTER },
  missing: {},
  assignments: {},
  env: {},
});

/** The state right after a successful run. */
function provisioned(d: DesiredAzureTest): AzureTestState {
  const assignment = (scope: string, principalId: string, role: string) => ({
    id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${randomUUID()}`,
    name: randomUUID(),
    properties: {
      scope,
      principalId,
      roleDefinitionId: `${d.subscriptionScope}/providers/Microsoft.Authorization/roleDefinitions/${role}`,
    },
  });
  return {
    resourceGroup: {
      id: d.resourceGroup.id,
      name: d.resourceGroup.name,
      location: 'eastus',
      tags: d.resourceGroup.tags,
    },
    workspace: {
      id: d.workspace.id,
      name: d.workspace.name,
      location: 'eastus',
      properties: {
        customerId: CUSTOMER,
        provisioningState: 'Succeeded',
        sku: { name: 'PerGB2018' },
        retentionInDays: 30,
        workspaceCapping: { dailyQuotaGb: 0.1 },
      },
    },
    diagnostic: {
      name: d.diagnostic.name,
      properties: {
        workspaceId: d.workspace.id,
        logs: ACTIVITY_LOG_CATEGORIES.map((category) => ({ category, enabled: true })),
      },
    },
    principals: { automation: AUTOMATION, tester: TESTER },
    missing: {},
    assignments: {
      [d.workspace.id.toLowerCase()]: [
        assignment(d.workspace.id, AUTOMATION, LOG_ANALYTICS_READER_ROLE_ID),
        assignment(d.workspace.id, TESTER, LOG_ANALYTICS_READER_ROLE_ID),
      ],
      [d.subscriptionScope.toLowerCase()]: [
        assignment(d.subscriptionScope, TESTER, 'acdd72a7-3385-48ef-bd42-f606fba81ae7'),
      ],
    },
    env: { workspaceId: CUSTOMER, location: 'eastus' },
  };
}

const summary = (ops: Array<{ action: string; section: string; title: string }>) =>
  ops.map((o) => `${o.action} ${o.section}: ${o.title}`);

describe('azure-test desired state', () => {
  it('names everything from the label and bounds the cost', () => {
    const d = desired('West Europe');
    expect(d.settings.location).toBe('westeurope');
    expect(d.resourceGroup.name).toBe('AF-Test-test');
    expect(d.resourceGroup.id).toBe(`/subscriptions/${SUB}/resourceGroups/AF-Test-test`);
    expect(d.workspace.name).toBe('af-test-law-test');
    expect(d.workspace.body.properties).toEqual({
      sku: { name: 'PerGB2018' },
      retentionInDays: 30,
      workspaceCapping: { dailyQuotaGb: 0.1 },
      publicNetworkAccessForIngestion: 'Enabled',
      publicNetworkAccessForQuery: 'Enabled',
    });
    expect(DAILY_CAP_GB).toBe(0.1);
    expect(d.diagnostic).toEqual({
      name: 'adminforge-test',
      id: `/subscriptions/${SUB}/providers/Microsoft.Insights/diagnosticSettings/adminforge-test`,
      categories: [
        'Administrative',
        'Policy',
        'Security',
        'ServiceHealth',
        'Alert',
        'Recommendation',
        'ResourceHealth',
      ],
    });
    expect(
      d.roles.map(
        (r) =>
          `${r.principal} ${r.roleName} ${r.scope === d.workspace.id ? 'workspace' : r.scope === d.subscriptionScope ? 'subscription' : r.scope}`,
      ),
    ).toEqual([
      'automation Log Analytics Reader workspace',
      'tester Reader subscription',
      'tester Log Analytics Reader workspace',
    ]);
    expect(d.resourceGroup.tags).toMatchObject({ 'adminforge-env': 'test', 'managed-by': 'adminforge-cli' });
  });
});

describe('azure-test plan', () => {
  it('creates everything in order on an empty subscription', () => {
    const d = desired();
    const ops = planAzureTest(d, empty());
    expect(summary(ops)).toEqual([
      'create Azure test environment: Resource group AF-Test-test (eastus)',
      'create Azure test environment: Log Analytics workspace af-test-law-test (PerGB2018, 30-day retention, daily cap 0.1 GB)',
      'create Activity log export: Subscription activity log → af-test-law-test (diagnostic setting adminforge-test: Administrative, Policy, Security, ServiceHealth, Alert, Recommendation, ResourceHealth)',
      'create Azure RBAC: AdminForge Automation [test] → Log Analytics Reader on workspace af-test-law-test',
      'create Azure RBAC: Validation user (AF_TEST_USER_UPN) → Reader on subscription (AF_SUBSCRIPTION_ID)',
      'create Azure RBAC: Validation user (AF_TEST_USER_UPN) → Log Analytics Reader on workspace af-test-law-test',
      'create Env file: AF_LOG_ANALYTICS_WORKSPACE_ID (workspace id of af-test-law-test)',
      'create Env file: AF_TEST_LOCATION (eastus)',
    ]);
    expect(notProvisioned(empty())).toBe(true);
  });

  it('is all no-op once provisioned, and never puts ids or UPNs in titles', () => {
    const d = desired();
    const ops = planAzureTest(d, provisioned(d));
    expect(ops.filter((o) => o.action !== 'noop')).toEqual([]);
    const text = JSON.stringify(ops.map((o) => [o.title, o.changes, o.detail]));
    for (const id of [SUB, AUTOMATION, TESTER, CUSTOMER]) expect(text).not.toContain(id);
    expect(notProvisioned(provisioned(d))).toBe(false);
  });

  it('repairs drift: daily cap, retention and tier; diagnostic categories and destination; env pointing elsewhere', () => {
    const d = desired();
    const s = provisioned(d);
    s.workspace!.properties!.workspaceCapping = { dailyQuotaGb: -1 };
    s.workspace!.properties!.retentionInDays = 90;
    s.diagnostic!.properties!.logs = s.diagnostic!.properties!.logs!.filter((l) => l.category !== 'Policy');
    s.diagnostic!.properties!.workspaceId = `${d.resourceGroup.id}/providers/Microsoft.OperationalInsights/workspaces/other`;
    s.env.workspaceId = randomUUID();
    const changed = planAzureTest(d, s).filter((o) => o.action !== 'noop');
    expect(changed.map((o) => [o.action, o.section, o.changes])).toEqual([
      ['update', 'Azure test environment', ['retention 90 → 30 days', 'daily cap none → 0.1 GB']],
      ['update', 'Activity log export', ['sends to a different workspace', 'categories missing: Policy']],
      ['update', 'Env file', ['points at a different workspace']],
    ]);
    expect(changed.find((o) => o.kind === 'env')).toMatchObject({ value: CUSTOMER });
  });

  it('only counts role assignments at the exact scope, for the right principal and role', () => {
    const d = desired();
    const s = provisioned(d);
    const ws = d.workspace.id.toLowerCase();
    // Tester's workspace assignment is for another role; automation's moved to the resource group (inherited only).
    s.assignments[ws] = [
      {
        ...s.assignments[ws]![1]!,
        properties: {
          ...s.assignments[ws]![1]!.properties,
          roleDefinitionId: `${d.subscriptionScope}/providers/Microsoft.Authorization/roleDefinitions/${randomUUID()}`,
        },
      },
      {
        ...s.assignments[ws]![0]!,
        properties: { ...s.assignments[ws]![0]!.properties, scope: d.resourceGroup.id },
      },
    ];
    expect(summary(planAzureTest(d, s).filter((o) => o.action === 'create'))).toEqual([
      'create Azure RBAC: AdminForge Automation [test] → Log Analytics Reader on workspace af-test-law-test',
      'create Azure RBAC: Validation user (AF_TEST_USER_UPN) → Log Analytics Reader on workspace af-test-law-test',
    ]);
  });

  it('skips roles whose principal is missing, with the command that fixes it', () => {
    const d = desired();
    const s = empty();
    s.principals = { automation: AUTOMATION };
    s.missing = {
      tester: 'AF_TEST_USER_UPN is not set — run `pnpm adminforge provision test-identities` first',
    };
    const skipped = planAzureTest(d, s).filter((o) => o.action === 'skip');
    expect(skipped.map((o) => [o.title, o.changes])).toEqual([
      [
        'Validation user (AF_TEST_USER_UPN) → Reader on subscription (AF_SUBSCRIPTION_ID)',
        ['AF_TEST_USER_UPN is not set — run `pnpm adminforge provision test-identities` first'],
      ],
      [
        'Validation user (AF_TEST_USER_UPN) → Log Analytics Reader on workspace af-test-law-test',
        ['AF_TEST_USER_UPN is not set — run `pnpm adminforge provision test-identities` first'],
      ],
    ]);
  });

  it('does not try to move a workspace or resource group to another region', () => {
    const d = desired('westus2');
    const s = provisioned(desired());
    const ops = planAzureTest(d, s);
    expect(ops[0]).toMatchObject({
      kind: 'resourceGroup',
      action: 'noop',
      detail: expect.stringContaining('cannot move'),
    });
    expect(ops[1]).toMatchObject({
      kind: 'skipped',
      action: 'skip',
      changes: [expect.stringContaining('--destroy')],
    });
    expect(ops.find((o) => o.kind === 'env' && o.title.startsWith('AF_TEST_LOCATION'))).toMatchObject({
      action: 'update',
      value: 'westus2',
    });
  });
});
