import { randomUUID } from 'node:crypto';
import type { CliContext } from '@adminforge/cli/src/provision/clients';
import {
  provisionEntra,
  provisionStatus,
  provisionTestIdentities,
} from '@adminforge/cli/src/commands/provision';
import { removeTestFixtures } from '@adminforge/cli/src/commands/test-fixtures';
import { CA_AUDIT_POLICIES, REPORT_ONLY } from '@adminforge/cli/src/provision/ca-audit-catalog';
import { createFixturesCloud, type FixturesCloudOptions } from './fixtures-fake';

// `provision test-identities` with the ca-audit fixture, against the fake cloud: the example Conditional Access
// policies are created report-only (never anything else), have nothing to do on the next run, show ✓ in
// `provision status`, are removed by `--remove-fixtures` — and a same-named policy that is ON is never touched.

const TENANT = randomUUID();
const PROVISIONER = { clientId: randomUUID(), secret: 'provisioner-secret-never-printed' };
const BREAK_GLASS = randomUUID();
const CA = { AF_TEST_FIXTURES: 'named-location,ca-audit', AF_PROTECTED_USER_IDS: BREAK_GLASS };

function setup(extra: Record<string, string> = {}, cloudOpts: Partial<FixturesCloudOptions> = {}) {
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
  return { cloud, lines, ctx };
}

/** Every write the fake received for Conditional Access policies. */
const caWrites = (cloud: ReturnType<typeof createFixturesCloud>) =>
  cloud.calls.filter((c) => /^(POST|PATCH|DELETE) .*conditionalAccess\/policies/.test(c));

describe('the ca-audit fixture', () => {
  it('creates every catalogue policy report-only, after the named location, then has nothing to do', async () => {
    const { cloud, ctx, lines } = setup(CA);
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    expect(cloud.caPolicies.map((p) => p.displayName)).toEqual(CA_AUDIT_POLICIES.map((p) => p.displayName));
    expect(cloud.caPolicies.every((p) => p.state === REPORT_ONLY)).toBe(true);
    // The location example excludes AF-Test-Location; the group-scoped ones target AF-Test-Group-01.
    const group = cloud.groups.find((g) => g.uniqueName === 'af-test-group-01')!;
    const loc = cloud.caPolicies.find((p) => String(p.displayName).endsWith('outside AF-Test-Location'))!;
    expect((loc.conditions as { locations: unknown }).locations).toEqual({
      includeLocations: ['All'],
      excludeLocations: [cloud.namedLocations[0]!.id],
    });
    expect((loc.conditions as { users: { includeGroups: string[] } }).users.includeGroups).toEqual([
      group.id,
    ]);
    const all = cloud.caPolicies.find((p) => String(p.displayName).endsWith('Require MFA for all users'))!;
    expect((all.conditions as { users: { excludeUsers: string[] } }).users.excludeUsers).toEqual([
      BREAK_GLASS,
    ]);
    expect(lines.join('\n')).toMatch(/✓ created \(report-only\): AF-Audit: Require MFA for all users/);

    lines.length = 0;
    const writes = caWrites(cloud).length;
    const again = await provisionTestIdentities(ctx);
    expect(again.fixtureOps.filter((o) => o.fixture === 'ca-audit').every((o) => o.action === 'noop')).toBe(
      true,
    );
    expect(caWrites(cloud)).toHaveLength(writes);
    expect(lines).toContain('Nothing to do: everything is already in the desired state.');
  });

  it('shows ✓ per policy in `provision status`, and ✗ for one someone changed', async () => {
    const { cloud, ctx, lines } = setup(CA);
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    const legacy = cloud.caPolicies.find((p) =>
      String(p.displayName).endsWith('Block legacy authentication'),
    )!;
    legacy.conditions = { ...(legacy.conditions as object), clientAppTypes: ['all'] };
    lines.length = 0;
    await provisionStatus(ctx).catch(() => undefined);
    const text = lines.join('\n');
    expect(text).toContain('Test fixtures: Conditional Access (report-only)');
    expect(text).toMatch(/✓ AF-Audit: Require MFA for administrators/);
    expect(text).toMatch(/✗ AF-Audit: Block legacy authentication/);
  });

  it('never touches a same-named policy that is ON — not on apply, not on removal', async () => {
    const { cloud, ctx, lines } = setup(CA);
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    const target = cloud.caPolicies.find((p) => String(p.displayName).endsWith('Require MFA for all users'))!;
    target.state = 'enabled'; // someone switched it on: it is theirs now
    target.grantControls = { operator: 'OR', builtInControls: ['block'] };
    const before = caWrites(cloud).length;
    // Refused (✗ cannot, exit 1 like any fixture that can't be done), the rest stays in the desired state.
    await expect(provisionTestIdentities(ctx)).rejects.toThrow(/could not be provisioned \(ca-audit\)/);
    expect(lines.join('\n')).toMatch(/✗ cannot {2}AF-Audit: Require MFA for all users .*is ON \(enforced\)/);
    expect(
      caWrites(cloud)
        .slice(before)
        .some((c) => c.includes(String(target.id))),
    ).toBe(false);

    await removeTestFixtures(ctx);
    expect(cloud.caPolicies.map((p) => p.id)).toEqual([target.id]);
    expect(target.state).toBe('enabled');
  });

  it('a policy Graph rejects prints ✗; the other policies are still created', async () => {
    const rejected = CA_AUDIT_POLICIES[5]!.displayName;
    const { cloud, ctx, lines } = setup(CA, { caReject: [rejected] });
    await provisionEntra(ctx);
    await expect(provisionTestIdentities(ctx)).rejects.toThrow(/could not be provisioned \(ca-audit\)/);
    expect(lines.join('\n')).toContain(`✗ ${rejected} — 400 BadRequest`);
    expect(cloud.caPolicies).toHaveLength(CA_AUDIT_POLICIES.length - 1);
  });

  it('without Policy.ReadWrite.ConditionalAccess: ✗ naming the permission, other fixtures go on', async () => {
    const { cloud, ctx, lines } = setup(CA, { forbid: ['ca-audit'] });
    await provisionEntra(ctx);
    await expect(provisionTestIdentities(ctx)).rejects.toThrow(/could not be provisioned/);
    expect(lines.join('\n')).toMatch(/Policy\.Read\.All and Policy\.ReadWrite\.ConditionalAccess/);
    expect(cloud.namedLocations).toHaveLength(1);
    expect(cloud.caPolicies).toHaveLength(0);
  });

  it('creates the block policies without any break-glass ids (Global Administrator excluded, so Graph accepts them)', async () => {
    const { cloud, ctx } = setup({ AF_TEST_FIXTURES: 'named-location,ca-audit' });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    expect(cloud.caPolicies).toHaveLength(CA_AUDIT_POLICIES.length);
  });

  it('a 403 that names a permission prints Graph’s reason and that permission; the other policies are created', async () => {
    const { cloud, ctx, lines } = setup(CA, { caNoApplicationRead: true });
    await provisionEntra(ctx);
    await expect(provisionTestIdentities(ctx)).rejects.toThrow(/could not be provisioned \(ca-audit\)/);
    const line = lines.find((l) => l.includes('✗ AF-Audit: Require MFA for Azure management'))!;
    expect(line).toContain(
      'Graph: "Insufficient privileges to create or update policy. Application.Read.All scope is required',
    );
    expect(line).toContain('Microsoft Graph application permission Application.Read.All');
    expect(cloud.caPolicies).toHaveLength(CA_AUDIT_POLICIES.length - 1);
  });

  it('undoes widening although Graph merges a PATCH (every omitted list sent empty), and reads the result back', async () => {
    const { cloud, ctx, lines } = setup(CA);
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    const device = cloud.caPolicies.find((p) =>
      String(p.displayName).endsWith('compliant or hybrid-joined device'),
    )!;
    const users = (device.conditions as { users: Record<string, unknown> }).users;
    users.includeUsers = ['All']; // someone widened the test-group example to everyone
    lines.length = 0;
    await provisionTestIdentities(ctx);
    const after = cloud.caPolicies.find((p) => p.id === device.id)!;
    expect((after.conditions as { users: { includeUsers: string[] } }).users.includeUsers).toEqual([]);
    expect(after.state).toBe(REPORT_ONLY);
    expect(lines.join('\n')).toMatch(
      /✓ updated \(report-only, read back\): AF-Audit: Require compliant or hybrid-joined device/,
    );
    lines.length = 0;
    await provisionStatus(ctx).catch(() => undefined);
    expect(lines.join('\n')).toMatch(/✓ AF-Audit: Require compliant or hybrid-joined device/);
  });

  it('prints ✗ when the read-back still differs after an update', async () => {
    const { cloud, ctx, lines } = setup(CA, { caPatchNoop: true });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    const legacy = cloud.caPolicies.find((p) =>
      String(p.displayName).endsWith('Block legacy authentication'),
    )!;
    legacy.conditions = { ...(legacy.conditions as object), clientAppTypes: ['all'] };
    lines.length = 0;
    await expect(provisionTestIdentities(ctx)).rejects.toThrow(/could not be provisioned \(ca-audit\)/);
    expect(lines.join('\n')).toMatch(
      /✗ AF-Audit: Block legacy authentication — 409 NotApplied: updated, but Graph still holds a different policy/,
    );
    expect(lines.join('\n')).not.toMatch(/✓ updated .*Block legacy/);
  });

  it('a throttled update waits, re-checks ownership, and leaves alone a policy an admin switched on meanwhile', async () => {
    const throttle: { times: number; then?: () => void } = { times: 0 };
    const { cloud, ctx, lines } = setup(CA, { caThrottle: throttle });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    const legacy = cloud.caPolicies.find((p) =>
      String(p.displayName).endsWith('Block legacy authentication'),
    )!;
    legacy.conditions = { ...(legacy.conditions as object), clientAppTypes: ['all'] };
    throttle.times = 1;
    throttle.then = () => {
      legacy.state = 'enabled'; // an administrator switches it on while we wait
    };
    lines.length = 0;
    await expect(provisionTestIdentities(ctx)).rejects.toThrow(/could not be provisioned \(ca-audit\)/);
    const text = lines.join('\n');
    expect(text).toMatch(/throttled by Graph; trying again/);
    expect(text).toMatch(
      /✗ AF-Audit: Block legacy authentication — 409 NotProvisioned: switched ON \(enforced\) since the plan — left alone/,
    );
    expect(legacy.state).toBe('enabled');
    expect((legacy.conditions as { clientAppTypes: string[] }).clientAppTypes).toEqual(['all']);
  });

  it('a throttled write is sent again after the wait', async () => {
    const { cloud, ctx, lines } = setup(CA, { caThrottle: { times: 1 } });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    expect(lines.join('\n')).toMatch(/throttled by Graph; trying again/);
    expect(cloud.caPolicies).toHaveLength(CA_AUDIT_POLICIES.length);
  });

  it('leaves alone a policy someone turned off (✗), and --remove-fixtures may delete it', async () => {
    const { cloud, ctx, lines } = setup(CA);
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    const target = cloud.caPolicies.find((p) => String(p.displayName).endsWith('Require MFA for all users'))!;
    target.state = 'disabled';
    const before = caWrites(cloud).length;
    lines.length = 0;
    await expect(provisionTestIdentities(ctx)).rejects.toThrow(/could not be provisioned/);
    expect(lines.join('\n')).toMatch(
      /✗ cannot {2}AF-Audit: Require MFA for all users .*turned off by someone — left alone/,
    );
    expect(caWrites(cloud).slice(before)).toEqual([]);
    await removeTestFixtures(ctx);
    expect(cloud.caPolicies).toHaveLength(0);
  });

  it('blocks the group-scoped examples while AF-Test-Group-01 has a stranger or dynamic membership, with a ⚠', async () => {
    const { cloud, ctx, lines } = setup(CA);
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    const group = cloud.groups.find((g) => g.uniqueName === 'af-test-group-01')!;
    cloud.addMember(String(group.id), {
      id: randomUUID(),
      '@odata.type': '#microsoft.graph.device',
      displayName: 'LAPTOP-42',
    });
    lines.length = 0;
    await provisionStatus(ctx).catch(() => undefined);
    let text = lines.join('\n');
    expect(text).toMatch(/✗ AF-Audit: Require compliant or hybrid-joined device .*has 1 member\(s\)/);
    expect(text).toMatch(/⚠ AF-Test-Group-01 has 1 member\(s\) .*group-scoped AF-Audit policies/);
    expect(text).toMatch(/✓ AF-Audit: Require MFA for all users/);

    const clean = setup(CA);
    await provisionEntra(clean.ctx);
    await provisionTestIdentities(clean.ctx);
    clean.cloud.groups.find((g) => g.uniqueName === 'af-test-group-01')!.groupTypes = ['DynamicMembership'];
    clean.lines.length = 0;
    await provisionStatus(clean.ctx).catch(() => undefined);
    text = clean.lines.join('\n');
    expect(text).toMatch(/✗ AF-Audit: Block access outside AF-Test-Location .*uses dynamic membership/);
  });

  it('warns (plan and status) while AF_PROTECTED_USER_IDS is empty', async () => {
    const WARNING =
      /⚠ The AF-Audit Conditional Access policies have no break-glass exclusion — set AF_PROTECTED_USER_IDS/;
    const without = setup({ AF_TEST_FIXTURES: 'named-location,ca-audit' });
    await provisionEntra(without.ctx);
    await provisionTestIdentities(without.ctx, { dryRun: true });
    expect(without.lines.join('\n')).toMatch(WARNING);
    await provisionTestIdentities(without.ctx);
    without.lines.length = 0;
    await provisionStatus(without.ctx).catch(() => undefined);
    expect(without.lines.join('\n')).toMatch(WARNING);

    const withIds = setup(CA);
    await provisionEntra(withIds.ctx);
    await provisionTestIdentities(withIds.ctx, { dryRun: true });
    expect(withIds.lines.join('\n')).not.toMatch(WARNING);
  });

  it('--remove-fixtures deletes the policies before the named location they refer to', async () => {
    const { cloud, ctx } = setup(CA);
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    await removeTestFixtures(ctx);
    expect(cloud.caPolicies).toHaveLength(0);
    expect(cloud.namedLocations).toHaveLength(0);
  });

  it('is not planned, read or written without the opt-in', async () => {
    const { cloud, ctx } = setup({ AF_TEST_FIXTURES: 'named-location' });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    expect(cloud.calls.some((c) => c.includes('conditionalAccess/policies'))).toBe(false);
  });
});
