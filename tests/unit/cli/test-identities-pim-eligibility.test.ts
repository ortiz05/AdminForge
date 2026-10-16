import { randomUUID } from 'node:crypto';
import type { CliContext } from '@adminforge/cli/src/provision/clients';
import {
  provisionEntra,
  provisionStatus,
  provisionTestIdentities,
} from '@adminforge/cli/src/commands/provision';
import { unexpectedEligibleRoles } from '@adminforge/cli/src/provision/eligibility';
import { FIXTURE_ROLES } from '@adminforge/cli/src/provision/fixtures-model';
import { createFixturesCloud, type FixturesCloudOptions } from './fixtures-fake';

// `provision status` checks the validation accounts' PIM-eligible roles (portal/tools/cli/src/provision/eligibility.ts):
// an eligible role can be activated with the stored password, so eligibility provisioning didn't grant is unexpected
// privilege (✗), with or without the pim fixture. An unreadable answer is a ⚠ with the reason, not a failure.

const TENANT = randomUUID();
const PROVISIONER = { clientId: randomUUID(), secret: 'provisioner-secret-never-printed' };
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';

async function provisioned(
  extra: Record<string, string> = {},
  cloudOpts: Partial<FixturesCloudOptions> = {},
) {
  const cloud = createFixturesCloud({ tenantId: TENANT, provisioner: PROVISIONER, ...cloudOpts });
  const env: Record<string, string | undefined> = {
    AF_TENANT_ID: TENANT,
    AF_PROVISIONER_CLIENT_ID: PROVISIONER.clientId,
    AF_PROVISIONER_CLIENT_SECRET: PROVISIONER.secret,
    AF_SUBSCRIPTION_ID: randomUUID(),
    AF_PRIMARY_DOMAIN: 'example.com',
    AF_ENV_LABEL: 'test',
    ...extra,
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
  await provisionTestIdentities(ctx);
  lines.length = 0;
  const tester = cloud.users.find((u) => u.userPrincipalName === 'af-tester@example.com')!;
  return { cloud, ctx, lines, tester };
}

describe('PIM-eligible roles of the validation user', () => {
  it('none: ✓', async () => {
    const { ctx, lines } = await provisioned();
    await provisionStatus(ctx);
    expect(lines).toContain('    ✓ AF Tester: no PIM-eligible roles beyond the ones provisioning manages');
  });

  it('an eligibility provisioning did not grant fails status — named, never by id', async () => {
    const { cloud, ctx, lines, tester } = await provisioned();
    cloud.eligibility.push({
      principalId: String(tester.id),
      roleDefinitionId: GLOBAL_ADMIN,
      directoryScopeId: '/',
      expiration: {},
    });
    const status = await provisionStatus(ctx);
    expect(status.ok).toBe(false);
    const line = lines.find((l) => l.includes('PIM-eligible for'))!;
    expect(line).toMatch(
      /✗ AF Tester is PIM-eligible for (Global Administrator|a directory role whose name could not be read) \(directory scope \/\)/,
    );
    expect(line).not.toContain(GLOBAL_ADMIN);
  });

  it('the pim fixture’s own eligibility is expected', async () => {
    const { ctx, lines } = await provisioned({ AF_TEST_FIXTURES: 'pim' });
    const status = await provisionStatus(ctx);
    expect(lines).toContain('    ✓ AF Tester: no PIM-eligible roles beyond the ones provisioning manages');
    expect(status.failures.filter((f) => /eligible/i.test(f))).toEqual([]);
  });

  it('a refused read is a ⚠ naming the permission, not a failure', async () => {
    const { ctx, lines } = await provisioned({}, { forbid: ['pim'] });
    const status = await provisionStatus(ctx);
    expect(lines.join('\n')).toMatch(
      /⚠ AF Tester: PIM-eligible roles — the provisioner may not read PIM eligibility — grant it RoleEligibilitySchedule\.Read\.Directory/,
    );
    expect(status.failures.filter((f) => /eligib/i.test(f))).toEqual([]);
  });
});

describe('unexpectedEligibleRoles', () => {
  it('allows only the granted roles at directory scope /', () => {
    const allowed = [FIXTURE_ROLES['Message Center Reader']];
    expect(
      unexpectedEligibleRoles(
        'AF Tester',
        [
          {
            roleDefinitionId: FIXTURE_ROLES['Message Center Reader'],
            directoryScopeId: '/',
            name: 'Message Center Reader',
          },
          {
            roleDefinitionId: FIXTURE_ROLES['Message Center Reader'],
            directoryScopeId: '/administrativeUnits/x',
            name: 'Message Center Reader',
          },
          { roleDefinitionId: randomUUID(), directoryScopeId: '/' },
        ],
        allowed,
      ),
    ).toEqual([
      expect.stringMatching(/Message Center Reader \(a scoped assignment\)/),
      expect.stringMatching(/a directory role whose name could not be read \(directory scope \/\)/),
    ]);
  });
});
