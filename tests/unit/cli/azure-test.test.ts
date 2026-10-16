import { randomUUID } from 'node:crypto';
import {
  azureTestStatus,
  destroyAzureTestRun,
  provisionAzureTest,
} from '@adminforge/cli/src/commands/azure-test';
import { provisionerClients, type CliContext } from '@adminforge/cli/src/provision/clients';
import { provisionSettings } from '@adminforge/cli/src/provision/settings';
import { createAzureFake, type AzureFakeOptions } from './azure-test-fake';

const TENANT = randomUUID();
const PROVISIONER = { clientId: randomUUID(), secret: 'provisioner-secret-never-printed' };
const AUTOMATION = { clientId: randomUUID(), secret: 'automation-secret-never-printed' };

function setup(opts: Partial<AzureFakeOptions> = {}, envOverrides: Record<string, string | undefined> = {}) {
  const subscriptionId = randomUUID();
  const cloud = createAzureFake({
    tenantId: TENANT,
    subscriptionId,
    provisioner: PROVISIONER,
    automation: AUTOMATION,
    testerUpn: 'af-tester@example.com',
    ...opts,
  });
  const env: Record<string, string | undefined> = {
    AF_TENANT_ID: TENANT,
    AF_PROVISIONER_CLIENT_ID: PROVISIONER.clientId,
    AF_PROVISIONER_CLIENT_SECRET: PROVISIONER.secret,
    AF_SUBSCRIPTION_ID: subscriptionId,
    AF_ENV_LABEL: 'test',
    AF_AUTOMATION_CLIENT_ID: AUTOMATION.clientId,
    AF_AUTOMATION_CLIENT_SECRET: AUTOMATION.secret,
    AF_TEST_USER_UPN: 'af-tester@example.com',
    ...envOverrides,
  };
  const written: Array<Record<string, string>> = [];
  const lines: string[] = [];
  const ctx: CliContext = {
    env,
    writeEnv: (u) => {
      written.push(u);
      Object.assign(env, u);
    },
    out: (l) => lines.push(l),
    fetch: cloud.fetch,
    sleep: async () => {},
  };
  return { cloud, env, written, lines, ctx, subscriptionId };
}

const changed = <T extends { action: string }>(ops: T[]) =>
  ops.filter((o) => o.action === 'create' || o.action === 'update');
const writes = (calls: string[]) =>
  calls.filter(
    (c) => !c.startsWith('GET ') && !c.includes('/oauth2/v2.0/token') && !c.includes('api.loganalytics.io'),
  );

describe('adminforge provision azure-test (against a fake ARM / Graph / Log Analytics)', () => {
  it('--dry-run reads only and changes nothing', async () => {
    const { cloud, ctx, written, lines } = setup();
    const run = await provisionAzureTest(ctx, { dryRun: true });
    expect(changed(run.ops)).toHaveLength(8);
    expect(writes(cloud.calls)).toEqual([]);
    expect(written).toEqual([]);
    expect(lines.join('\n')).toContain('Dry run: nothing was changed.');
  });

  it('creates the environment, waits out replication and provisioning, writes the env file, verifies as the automation identity, then is a no-op', async () => {
    const { cloud, ctx, env, written, lines, subscriptionId } = setup({
      principalNotFound: 2,
      creatingPolls: 2,
      laForbidden: 2,
      activityRows: 7,
    });
    const run = await provisionAzureTest(ctx);

    const [rg] = [...cloud.resourceGroups.values()];
    expect(rg).toMatchObject({
      name: 'AF-Test-test',
      location: 'eastus',
      tags: { 'adminforge-env': 'test', 'managed-by': 'adminforge-cli' },
    });
    const [ws] = [...cloud.workspaces.values()] as Array<{
      name: string;
      properties: Record<string, unknown>;
    }>;
    expect(ws!.name).toBe('af-test-law-test');
    expect(ws!.properties).toMatchObject({
      sku: { name: 'PerGB2018' },
      retentionInDays: 30,
      workspaceCapping: { dailyQuotaGb: 0.1 },
    });
    const [diag] = [...cloud.diagnostics.values()] as Array<{
      name: string;
      properties: { workspaceId: string; logs: Array<{ category: string; enabled: boolean }> };
    }>;
    expect(diag!.name).toBe('adminforge-test');
    expect(diag!.properties.workspaceId).toMatch(/\/workspaces\/af-test-law-test$/);
    expect(diag!.properties.logs.map((l) => l.category)).toEqual([
      'Administrative',
      'Policy',
      'Security',
      'ServiceHealth',
      'Alert',
      'Recommendation',
      'ResourceHealth',
    ]);

    // Deterministic assignment names, the right principal types, and the right scopes.
    expect(
      cloud.assignments.map((a) => [
        a.properties.principalType,
        String(a.properties.roleDefinitionId).split('/').pop(),
        String(a.properties.scope).split('/').pop(),
      ]),
    ).toEqual([
      ['ServicePrincipal', '73c42c96-874c-492b-b04d-ab87d138a893', 'af-test-law-test'],
      ['User', 'acdd72a7-3385-48ef-bd42-f606fba81ae7', subscriptionId],
      ['User', '73c42c96-874c-492b-b04d-ab87d138a893', 'af-test-law-test'],
    ]);
    expect(cloud.assignments[0]!.properties.principalId).toBe(cloud.automationSp.id);
    expect(cloud.assignments[1]!.properties.principalId).toBe(cloud.tester.id);

    const customerId = (ws!.properties as { customerId: string }).customerId;
    expect(written.flatMap((w) => Object.entries(w))).toEqual([
      ['AF_LOG_ANALYTICS_WORKSPACE_ID', customerId],
      ['AF_TEST_LOCATION', 'eastus'],
    ]);
    expect(run.verify).toEqual({ ok: true, activityRows: 7 });
    expect(cloud.laQueries).toEqual(['print ok = 1', 'AzureActivity | summarize rows = count()']);

    const output = lines.join('\n');
    expect(output).toContain('waiting'); // PrincipalNotFound retry and RBAC propagation were exercised
    expect(output).toContain('✓ Automation identity can query af-test-law-test');
    expect(output).toContain('AzureActivity: 7 rows in the last 24 hours');
    // Names only: no tenant, subscription, object or workspace ids, no UPN, no secrets.
    for (const secret of [
      TENANT,
      subscriptionId,
      customerId,
      cloud.automationSp.id,
      cloud.tester.id,
      'af-tester@example.com',
      PROVISIONER.secret,
      AUTOMATION.secret,
      AUTOMATION.clientId,
    ])
      expect(output).not.toContain(secret);
    expect(env.AF_LOG_ANALYTICS_WORKSPACE_ID).toBe(customerId);

    const again = await provisionAzureTest(ctx);
    expect(changed(again.ops)).toEqual([]);
    expect(lines.join('\n')).toContain('Nothing to do');
    expect(cloud.assignments).toHaveLength(3);
  });

  it('reports an empty workspace as reachable (AzureActivity not there yet)', async () => {
    const { ctx, lines } = setup({ activityRows: null });
    const run = await provisionAzureTest(ctx);
    expect(run.verify).toEqual({ ok: true, activityRows: null });
    expect(lines.join('\n')).toContain('AzureActivity has no data yet');
  });

  it('repairs drift by updating, not recreating', async () => {
    const { cloud, ctx } = setup();
    await provisionAzureTest(ctx, { verify: false });
    const ws = [...cloud.workspaces.values()][0] as { properties: Record<string, unknown> };
    const customerId = ws.properties.customerId;
    ws.properties.workspaceCapping = { dailyQuotaGb: -1 };
    const run = await provisionAzureTest(ctx, { verify: false });
    expect(changed(run.ops).map((o) => [o.action, o.changes])).toEqual([
      ['update', ['daily cap none → 0.1 GB']],
    ]);
    expect(
      ([...cloud.workspaces.values()][0] as { properties: Record<string, unknown> }).properties,
    ).toMatchObject({ customerId, workspaceCapping: { dailyQuotaGb: 0.1 } });
  });

  it('skips the validation user without AF_TEST_USER_UPN and still provisions the rest', async () => {
    const { cloud, ctx, lines } = setup({}, { AF_TEST_USER_UPN: undefined });
    const run = await provisionAzureTest(ctx, { verify: false });
    expect(run.ops.filter((o) => o.action === 'skip')).toHaveLength(2);
    expect(cloud.assignments).toHaveLength(1);
    expect(lines.join('\n')).toContain('provision test-identities');
  });

  it('status: optional when absent, ✓ with a live query once provisioned, ✗ on drift', async () => {
    const { cloud, ctx, lines } = setup();
    const clients = provisionerClients(ctx, provisionSettings(ctx.env));
    expect((await azureTestStatus(ctx, clients)).failures).toEqual([]);
    expect(lines.join('\n')).toContain('Azure test environment — not provisioned');

    await provisionAzureTest(ctx, { verify: false });
    lines.length = 0;
    const ok = await azureTestStatus(ctx, clients);
    expect(ok.failures).toEqual([]);
    const output = lines.join('\n');
    expect(output).toContain('✓ Resource group AF-Test-test (eastus)');
    expect(output).toContain('✓ AF_LOG_ANALYTICS_WORKSPACE_ID (workspace id of af-test-law-test)');
    expect(output).toContain('✓ Automation identity can query af-test-law-test');
    expect(output).not.toContain('✗');

    cloud.diagnostics.clear();
    lines.length = 0;
    const drift = await azureTestStatus(ctx, clients);
    expect(drift.failures).toEqual([expect.stringContaining('diagnostic setting adminforge-test')]);
    expect(lines.join('\n')).toContain('✗ Subscription activity log');
  });

  it('--destroy asks for the resource group name, then deletes the export, the workspace (no soft delete), the subscription role and the group', async () => {
    const { cloud, ctx, env, lines } = setup();
    await provisionAzureTest(ctx, { verify: false });

    expect(await destroyAzureTestRun(ctx, { confirm: async () => 'nope' })).toBeNull();
    expect(cloud.resourceGroups.size).toBe(1);
    expect(lines.join('\n')).toContain('Nothing was deleted.');
    await expect(destroyAzureTestRun(ctx, {})).rejects.toThrow(/--yes/);

    const result = await destroyAzureTestRun(ctx, {
      confirm: async (q) => (expect(q).toContain('AF-Test-test'), 'AF-Test-test'),
      poll: { intervalMs: 0 },
    });
    expect(result).toEqual({
      diagnostic: 'deleted',
      workspace: 'deleted',
      resourceGroup: 'deleted',
      subscriptionRoles: 1,
    });
    expect(cloud.calls).toContainEqual(
      expect.stringMatching(/^DELETE management\.azure\.com.*\/workspaces\/af-test-law-test$/),
    );
    expect(cloud.resourceGroups.size).toBe(0);
    expect(cloud.diagnostics.size).toBe(0);
    expect(cloud.assignments).toEqual([]);
    expect(env.AF_LOG_ANALYTICS_WORKSPACE_ID).toBe('');

    // Idempotent: a second destroy finds nothing.
    expect(await destroyAzureTestRun(ctx, { yes: true })).toEqual({
      diagnostic: 'absent',
      workspace: 'absent',
      resourceGroup: 'absent',
      subscriptionRoles: 0,
    });
  });

  it('refuses a missing subscription or a bad location with a config error', async () => {
    await expect(provisionAzureTest(setup({}, { AF_SUBSCRIPTION_ID: '' }).ctx)).rejects.toThrow(
      /AF_SUBSCRIPTION_ID/,
    );
    await expect(provisionAzureTest(setup({}, { AF_TEST_LOCATION: 'east us; drop' }).ctx)).rejects.toThrow(
      /AF_TEST_LOCATION/,
    );
  });
});
