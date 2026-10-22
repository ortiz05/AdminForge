import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { provisionEntra, provisionStatus } from '@adminforge/cli/src/commands/provision';
import { DIRECTORY_ROLES } from '@adminforge/cli/src/provision/catalog';
import type { CliContext } from '@adminforge/cli/src/provision/clients';
import { createFakeCloud } from './fake-cloud';

// `provision status` flags directory roles held by AdminForge's own apps (2026-10-22 review): provisioning assigns
// none, and an app's directory role works without any signed-in user — Exchange or SharePoint Administrator on the
// automation identity would reach far past its Exchange.ManageAsApp or Sites permissions. Names and counts only.

async function provisioned(opts: { eligibilityReadable?: boolean } = {}) {
  const tenant = randomUUID();
  const provisioner = { clientId: randomUUID(), secret: 'provisioner-secret' };
  const cloud = createFakeCloud({ tenantId: tenant, provisioner, ...opts });
  const env: Record<string, string | undefined> = {
    AF_TENANT_ID: tenant,
    AF_PROVISIONER_CLIENT_ID: provisioner.clientId,
    AF_PROVISIONER_CLIENT_SECRET: provisioner.secret,
    AF_SUBSCRIPTION_ID: randomUUID(),
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
  await provisionEntra(ctx);
  const sp = (unique: string) => {
    const app = cloud.apps.find((a) => a.uniqueName === unique)!;
    return cloud.sps.find((s) => s.appId === app.appId)!;
  };
  const status = async () => {
    lines.length = 0;
    const result = await provisionStatus(ctx);
    return { ...result, output: lines.join('\n') };
  };
  return { cloud, sp, status };
}

describe('provision status: directory roles of the AdminForge apps', () => {
  it('passes when no app holds a directory role', async () => {
    const { status } = await provisioned();
    const s = await status();
    expect(s.failures.filter((f) => /directory role/.test(f))).toEqual([]);
    expect(s.output).not.toMatch(/could not read (eligible )?directory role/);
  });

  it('fails on an active or eligible role, by role name, without printing ids', async () => {
    const { cloud, sp, status } = await provisioned();
    const automation = sp('adminforge-automation-test');
    const read = sp('adminforge-read-test');
    cloud.roleAssignments.push({
      id: randomUUID(),
      principalId: automation.id,
      roleDefinitionId: DIRECTORY_ROLES['User Administrator'],
      directoryScopeId: '/',
    });
    cloud.roleEligibilitySchedules.push({
      id: randomUUID(),
      principalId: read.id,
      roleDefinitionId: DIRECTORY_ROLES['Global Reader'],
      directoryScopeId: '/',
    });
    const s = await status();
    expect(s.ok).toBe(false);
    expect(s.failures).toEqual(
      expect.arrayContaining([
        'AdminForge Automation [test]: directory roles — 1 directory role provisioning did not assign — User Administrator',
        'AdminForge Read [test]: directory roles — eligible (PIM) for 1 directory role — Global Reader',
      ]),
    );
    for (const id of [automation.id, read.id, automation.appId as string]) expect(s.output).not.toContain(id);
  });

  it('still checks active roles where PIM eligibility cannot be read, and says so', async () => {
    const { cloud, sp, status } = await provisioned({ eligibilityReadable: false });
    cloud.roleAssignments.push({
      id: randomUUID(),
      principalId: sp('adminforge-write-test').id,
      roleDefinitionId: DIRECTORY_ROLES['Groups Administrator'],
      directoryScopeId: '/',
    });
    const s = await status();
    expect(s.failures).toContain(
      'AdminForge Write [test]: directory roles — 1 directory role provisioning did not assign — Groups Administrator',
    );
    expect(s.output).toContain('could not read eligible directory roles (PIM needs Microsoft Entra ID P2)');
  });
});
