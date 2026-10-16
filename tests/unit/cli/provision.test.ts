import { randomUUID } from 'node:crypto';
import type { CliContext } from '@adminforge/cli/src/commands/context';
import {
  provisionEntra,
  provisionStatus,
  provisionTestIdentities,
} from '@adminforge/cli/src/commands/provision';
import { createFakeCloud, type FakeCloudOptions } from './fake-cloud';

const TENANT = randomUUID();
const PROVISIONER = { clientId: randomUUID(), secret: 'provisioner-secret-never-printed' };

function setup(opts: Partial<FakeCloudOptions> = {}) {
  const cloud = createFakeCloud({ tenantId: TENANT, provisioner: PROVISIONER, ...opts });
  const env: Record<string, string | undefined> = {
    AF_TENANT_ID: TENANT,
    AF_PROVISIONER_CLIENT_ID: PROVISIONER.clientId,
    AF_PROVISIONER_CLIENT_SECRET: PROVISIONER.secret,
    AF_SUBSCRIPTION_ID: randomUUID(),
    AF_PRIMARY_DOMAIN: 'example.com',
    AF_ENV_LABEL: 'test',
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
    // The fake Graph publishes a small permission catalog; content-derived scopes are tested in entra-plan tests.
    contentScopes: {},
  };
  return { cloud, env, written, lines, ctx };
}

const changed = <T extends { action: string }>(ops: T[]): T[] =>
  ops.filter((o) => o.action === 'create' || o.action === 'update');

describe('adminforge provision entra (against a fake Graph/ARM)', () => {
  it('--dry-run reads only and changes nothing', async () => {
    const { cloud, ctx, written } = setup();
    const run = await provisionEntra(ctx, { dryRun: true });
    expect(changed(run.ops).length).toBeGreaterThan(40);
    expect(cloud.calls.filter((c) => !c.startsWith('GET ') && !c.includes('/oauth2/v2.0/token'))).toEqual([]);
    expect(written).toEqual([]);
  });

  it('creates everything, writes ids and secrets to the env file without printing them, and is a no-op the second time', async () => {
    const { cloud, ctx, env, written, lines } = setup({ spReplicationMisses: 2 });
    await provisionEntra(ctx);

    expect(cloud.apps.map((a) => a.displayName).sort()).toEqual([
      'AdminForge Automation [test]',
      'AdminForge Read [test]',
      'AdminForge Write [test]',
    ]);
    expect(cloud.apps.map((a) => a.uniqueName).sort()).toEqual([
      'adminforge-automation-test',
      'adminforge-read-test',
      'adminforge-write-test',
    ]);
    expect(cloud.groups.map((g) => g.displayName)).toHaveLength(5);
    expect(cloud.grants).toHaveLength(5); // Read: Graph, ARM, Log Analytics; Write: Graph, ARM (Exchange absent)
    expect(cloud.grants.every((g) => g.consentType === 'AllPrincipals')).toBe(true);
    expect(cloud.armAssignments).toHaveLength(1);
    expect(cloud.armAssignments[0]!.properties).toMatchObject({ principalType: 'ServicePrincipal' });

    const keys = written.flatMap((w) => Object.keys(w)).sort();
    expect(keys).toEqual([
      'AF_AUTOMATION_CLIENT_ID',
      'AF_AUTOMATION_CLIENT_SECRET',
      'AF_READ_CLIENT_ID',
      'AF_READ_CLIENT_SECRET',
      'AF_WRITE_CLIENT_ID',
      'AF_WRITE_CLIENT_SECRET',
    ]);
    const output = lines.join('\n');
    for (const k of ['AF_READ_CLIENT_SECRET', 'AF_WRITE_CLIENT_SECRET', 'AF_AUTOMATION_CLIENT_SECRET'])
      expect(output).not.toContain(env[k]!);
    expect(output).not.toContain(PROVISIONER.secret);
    expect(output).toContain('waiting'); // replication retry was exercised
    expect(output).toContain('Office 365 Exchange Online');

    const again = await provisionEntra(ctx);
    expect(changed(again.ops)).toEqual([]);
    expect(lines.join('\n')).toContain('Nothing to do');
  });

  it('includes Exchange.Manage when the Exchange Online service principal exists', async () => {
    const { cloud, ctx } = setup({ withExchange: true });
    const run = await provisionEntra(ctx);
    expect(run.ops.filter((o) => o.action === 'skip')).toEqual([]);
    expect(cloud.grants).toHaveLength(7);
  });

  it('falls back to query-then-create when the alternate-key upsert is not supported', async () => {
    const { cloud, ctx } = setup({ upsertSupported: false });
    await provisionEntra(ctx);
    expect(cloud.calls).toContain('POST graph.microsoft.com/v1.0/applications');
    expect(cloud.calls).toContain('POST graph.microsoft.com/v1.0/servicePrincipals');
    expect(cloud.apps.every((a) => typeof a.uniqueName === 'string')).toBe(true);
    expect(changed((await provisionEntra(ctx)).ops)).toEqual([]);
  });

  it('repairs drift: a removed redirect URI and a narrowed consent grant are updated, not recreated', async () => {
    const { cloud, ctx } = setup();
    await provisionEntra(ctx);
    const read = cloud.apps.find((a) => a.uniqueName === 'adminforge-read-test')!;
    (read.web as { redirectUris: string[] }).redirectUris = [];
    cloud.grants[0]!.scope = 'openid';
    const run = await provisionEntra(ctx);
    expect(changed(run.ops).map((o) => `${o.action} ${o.section}`)).toEqual([
      'update Applications',
      'update Consent grants',
    ]);
    expect((read.web as { redirectUris: string[] }).redirectUris).toEqual([
      'http://localhost:5173/auth/callback',
      'http://localhost:5173/auth/signed-out',
    ]);
    expect(cloud.apps).toHaveLength(3);
  });
});

describe('adminforge provision test-identities and status', () => {
  it('creates the tester, memberships, roles, and AF-Test-* targets; stores only the tester password; then no-op', async () => {
    const { cloud, ctx, env, written, lines } = setup();
    await provisionEntra(ctx);
    written.length = 0;
    const run = await provisionTestIdentities(ctx);
    // 11 identity objects + the validation user's exclusion from the registration campaign.
    expect(changed(run.ops)).toHaveLength(12);
    expect(cloud.users.map((u) => u.userPrincipalName).sort()).toEqual([
      'af-test-user-01@example.com',
      'af-test-user-02@example.com',
      'af-test-user-03@example.com',
      'af-tester@example.com',
    ]);
    const tester = cloud.users.find((u) => u.userPrincipalName === 'af-tester@example.com')!;
    expect(tester.passwordProfile).toMatchObject({ forceChangePasswordNextSignIn: false });
    expect(cloud.members.filter((m) => m.memberId === tester.id)).toHaveLength(3);
    expect(
      cloud.roleAssignments.filter((r) => r.principalId === tester.id && r.directoryScopeId === '/'),
    ).toHaveLength(2);
    expect(cloud.groups.some((g) => g.displayName === 'AF-Test-Group-01')).toBe(true);
    expect(written.flatMap((w) => Object.keys(w))).toEqual(['AF_TEST_USER_UPN', 'AF_TEST_USER_PASSWORD']);
    expect(lines.join('\n')).not.toContain(env.AF_TEST_USER_PASSWORD!);
    // Provisioner gets 403 on the policy; the automation identity (Policy.Read.All) can read it.
    expect(run.securityDefaults).toBe(false);

    expect(changed((await provisionTestIdentities(ctx)).ops)).toEqual([]);
  });

  it('status is all ✓ after provisioning, verifies the automation token roles, and never prints secrets', async () => {
    const { ctx, env, lines } = setup();
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    lines.length = 0;
    const status = await provisionStatus(ctx);
    expect(status.failures).toEqual([]);
    expect(status.ok).toBe(true);
    const output = lines.join('\n');
    expect(output).toContain('app-only token carries 17/17 expected roles');
    expect(output).toContain('authorize URL is well-formed');
    expect(output).not.toContain('✗');
    for (const k of [
      'AF_READ_CLIENT_SECRET',
      'AF_WRITE_CLIENT_SECRET',
      'AF_AUTOMATION_CLIENT_SECRET',
      'AF_TEST_USER_PASSWORD',
    ])
      expect(output).not.toContain(env[k]!);
  });

  it('status reports ✗ for missing objects and a stale stored secret', async () => {
    const { cloud, ctx } = setup();
    await provisionEntra(ctx);
    ctx.env.AF_WRITE_CLIENT_SECRET = 'stale-secret';
    cloud.groups.splice(0, 1);
    const status = await provisionStatus(ctx);
    expect(status.ok).toBe(false);
    expect(status.failures).toEqual(
      expect.arrayContaining([
        'AF_WRITE_CLIENT_SECRET',
        'SG-AdminForge-test-Portal.Reader',
        'AdminForge Write [test]: client-credentials token',
      ]),
    );
  });
});
