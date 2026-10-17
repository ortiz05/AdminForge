import { randomUUID } from 'node:crypto';
import { provisionEntra, provisionStatus } from '@adminforge/cli/src/commands/provision';
import type { CliContext } from '@adminforge/cli/src/provision/clients';
import { applyEntraOps } from '@adminforge/cli/src/provision/entra-io';
import type { EntraOp, EntraState } from '@adminforge/cli/src/provision/model';
import { ApiError, type GraphClient } from '@adminforge/connectors';
import { createFakeCloud } from './fake-cloud';

// `provision entra --prune`: application permissions (app-role assignments) on AdminForge's own apps that provisioning
// doesn't grant — e.g. the automation identity's Defender permissions after that content was retired. Without --prune
// nothing is removed (one hint line counts them); with it only roles on resources provisioning knows are removed.

const TENANT = randomUUID();
const PROVISIONER = { clientId: randomUUID(), secret: 'provisioner-secret-never-printed' };
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';

function setup() {
  const cloud = createFakeCloud({ tenantId: TENANT, provisioner: PROVISIONER });
  const env: Record<string, string | undefined> = {
    AF_TENANT_ID: TENANT,
    AF_PROVISIONER_CLIENT_ID: PROVISIONER.clientId,
    AF_PROVISIONER_CLIENT_SECRET: PROVISIONER.secret,
    AF_SUBSCRIPTION_ID: randomUUID(),
    AF_PRIMARY_DOMAIN: 'example.com',
    AF_ENV_LABEL: 'test',
  };
  const lines: string[] = [];
  const ctx: CliContext = {
    env,
    writeEnv: (u) => Object.assign(env, u),
    out: (l) => lines.push(l),
    fetch: cloud.fetch,
    sleep: async () => {},
    contentScopes: {},
  };
  return { cloud, ctx, lines };
}

/** Provisions everything, then adds what provisioning doesn't grant: a Graph role it dropped and a foreign resource's role. */
async function withLeftovers() {
  const s = setup();
  await provisionEntra(s.ctx);
  const automation = s.cloud.sps.find((sp) => sp.displayName === 'AdminForge Automation [test]')!;
  const graph = s.cloud.sps.find((sp) => sp.appId === GRAPH_APP_ID)!;
  const role = (graph.appRoles as Array<{ id: string; value: string }>).find(
    (r) => r.value === 'SecurityIncident.Read.All',
  )!;
  const leftover = { id: randomUUID(), principalId: automation.id, resourceId: graph.id, appRoleId: role.id };
  const foreign = {
    id: randomUUID(),
    principalId: automation.id,
    resourceId: randomUUID(), // a resource provisioning doesn't know (a line-of-business API)
    appRoleId: randomUUID(),
  };
  s.cloud.assignments.push(leftover, foreign);
  s.lines.length = 0;
  s.cloud.calls.length = 0;
  return { ...s, leftover, foreign };
}

const writes = (calls: string[]) =>
  calls.filter((c) => !c.startsWith('GET ') && !c.includes('/oauth2/v2.0/token'));

describe('provision entra --prune', () => {
  it('without --prune plans no removal and says how many there are', async () => {
    const { ctx, lines, cloud } = await withLeftovers();
    const run = await provisionEntra(ctx, { dryRun: true });
    expect(run.ops.filter((o) => o.action === 'delete')).toEqual([]);
    expect(lines).toContain(
      "  ⚠ 1 application permission(s) provisioning doesn't grant — run with --prune to remove them (provision status lists them)",
    );
    expect(writes(cloud.calls)).toEqual([]);
  });

  it('--dry-run --prune plans removing only the unwanted role on a known resource, by name', async () => {
    const { ctx, lines, cloud, leftover, foreign } = await withLeftovers();
    const run = await provisionEntra(ctx, { dryRun: true, prune: true });
    const removals = run.ops.filter((o) => o.kind === 'appRoleRemove');
    expect(removals.map((o) => [o.action, o.section, o.title])).toEqual([
      [
        'delete',
        'App role assignments',
        'AdminForge Automation [test] → Microsoft Graph: SecurityIncident.Read.All',
      ],
    ]);
    expect(lines.some((l) => l.includes('run with --prune'))).toBe(false);
    expect(writes(cloud.calls)).toEqual([]);
    const text = lines.join('\n');
    expect(text).not.toContain(leftover.id);
    expect(text).not.toContain(foreign.id);
  });

  it('--prune removes it, leaves the foreign resource alone and then converges', async () => {
    const { ctx, lines, cloud, leftover, foreign } = await withLeftovers();
    await provisionEntra(ctx, { prune: true });
    expect(writes(cloud.calls).filter((c) => c.startsWith('DELETE '))).toHaveLength(1);
    expect(cloud.assignments.some((a) => a.id === leftover.id)).toBe(false);
    expect(cloud.assignments.some((a) => a.id === foreign.id)).toBe(true);
    expect(lines).toContain(
      '  ✓ removed application permission: AdminForge Automation [test] → Microsoft Graph: SecurityIncident.Read.All',
    );
    expect(lines.join('\n')).not.toContain(leftover.id);

    const again = await provisionEntra(ctx, { dryRun: true, prune: true });
    expect(again.ops.filter((o) => o.action === 'delete')).toEqual([]);
  });

  it('provision status points at --prune while there are removable leftovers', async () => {
    const { ctx, lines } = await withLeftovers();
    await provisionStatus(ctx).catch(() => undefined); // status fails on the unexpected privilege; output is what counts
    expect(
      lines.some((l) => l.includes('provision entra --prune` removes 1 of these application permission(s)')),
    ).toBe(true);
  });
});

describe('applyEntraOps: appRoleRemove', () => {
  const state = {
    resources: {},
    apps: {},
    sps: { automation: { id: 'sp-automation', appId: 'app-automation' } },
    grants: {},
    assignedTo: {},
    appPermissions: {},
    groups: {},
    arm: { assignments: [] },
    env: {},
  } as unknown as EntraState;
  const op: EntraOp = {
    kind: 'appRoleRemove',
    action: 'delete',
    section: 'App role assignments',
    title: 'AdminForge Automation [test] → Microsoft Graph: ThreatHunting.Read.All',
    app: 'automation',
    assignmentId: 'assignment-1',
  };

  it('deletes through the principal and treats 404 as already removed', async () => {
    const paths: string[] = [];
    const graph = {
      request: async (r: { method?: string; path: string }) => {
        paths.push(`${r.method} ${r.path}`);
        throw new ApiError(404, 'Request_ResourceNotFound', 'gone');
      },
    } as unknown as GraphClient;
    const log: string[] = [];
    await applyEntraOps([op], state, { graph, writeEnv: () => {}, log: (l: string) => log.push(l) } as never);
    expect(paths).toEqual(['DELETE /servicePrincipals/sp-automation/appRoleAssignments/assignment-1']);
    expect(log).toEqual([`  ✓ removed application permission: ${op.title}`]);
  });

  it('other errors still fail the run', async () => {
    const graph = {
      request: async () => {
        throw new ApiError(403, 'Authorization_RequestDenied', 'Insufficient privileges');
      },
    } as unknown as GraphClient;
    await expect(
      applyEntraOps([op], state, { graph, writeEnv: () => {}, log: () => {} } as never),
    ).rejects.toThrow(/Insufficient privileges/);
  });
});
