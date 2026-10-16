import { randomUUID } from 'node:crypto';
import type { CliContext } from '@adminforge/cli/src/commands/context';
import {
  provisionEntra,
  provisionStatus,
  provisionTestIdentities,
} from '@adminforge/cli/src/commands/provision';
import {
  buildDesiredIdentities,
  planIdentities,
  type IdentityState,
} from '@adminforge/cli/src/provision/identities-plan';
import { createFakeCloud, type FakeCloudOptions } from './fake-cloud';

// Entra's Microsoft-managed registration campaign ("Sign in faster with your face, fingerprint or PIN") interrupts the
// validation user's unattended sign-in with a page headless Chrome can't complete. `provision test-identities`
// excludes that one user and leaves the rest of the campaign exactly as the tenant has it.
const TENANT = randomUUID();
const PROVISIONER = { clientId: randomUUID(), secret: 'provisioner-secret-never-printed' };
const TITLE = 'AF Tester excluded from the authentication methods registration campaign (sign-in nudge)';

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
  const lines: string[] = [];
  const ctx: CliContext = {
    env,
    writeEnv: (u) => Object.assign(env, u),
    out: (l) => lines.push(l),
    fetch: cloud.fetch,
    sleep: async () => {},
    contentScopes: {},
  };
  return { cloud, env, lines, ctx };
}

type Campaign = {
  state: string;
  snoozeDurationInDays: number;
  includeTargets: Array<Record<string, unknown>>;
  excludeTargets: Array<{ id: string; targetType: string }>;
};
const campaignOf = (cloud: ReturnType<typeof createFakeCloud>) =>
  cloud.authMethodsPolicy.registrationEnforcement
    .authenticationMethodsRegistrationCampaign as unknown as Campaign;
const policyPatches = (cloud: ReturnType<typeof createFakeCloud>) =>
  cloud.calls.filter((c) => c === 'PATCH graph.microsoft.com/v1.0/policies/authenticationMethodsPolicy');
const testerOf = (cloud: ReturnType<typeof createFakeCloud>) =>
  cloud.users.find((u) => u.userPrincipalName === 'af-tester@example.com')!;

describe('registration campaign exclusion: plan', () => {
  const desired = buildDesiredIdentities({ label: 'test', domain: 'example.com' });
  const testerId = randomUUID();
  const state = (campaign: IdentityState['registrationCampaign'], tester = true): IdentityState => ({
    ...(tester
      ? { tester: { id: testerId, userPrincipalName: desired.tester.upn, displayName: 'AF Tester' } }
      : {}),
    testerGroupIds: [],
    testerRoleIds: [],
    portalGroups: {},
    targets: {},
    env: { upn: desired.tester.upn, password: 'stored' },
    ...(campaign ? { registrationCampaign: campaign } : {}),
  });
  const op = (s: IdentityState) => planIdentities(desired, s).find((o) => o.kind === 'campaignExclusion');

  it('plans the exclusion for a tester the campaign still targets (and for one about to be created)', () => {
    const other = { id: randomUUID(), targetType: 'user' };
    expect(op(state({ state: 'default', excludeTargets: [other] }))).toMatchObject({
      action: 'create',
      section: 'Test identities',
      title: TITLE,
    });
    expect(op(state({ state: 'default', excludeTargets: [] }, false))?.action).toBe('create');
  });

  it('is a no-op once the tester is excluded (ids compared case-insensitively) and names the campaign state', () => {
    expect(
      op(state({ state: 'default', excludeTargets: [{ id: testerId.toUpperCase(), targetType: 'user' }] })),
    ).toMatchObject({ action: 'noop', detail: 'campaign Microsoft-managed' });
    expect(op(state({ state: 'disabled', excludeTargets: [{ id: testerId }] }))?.detail).toBe(
      'campaign disabled',
    );
  });

  it('skips with the reason when the policy cannot be read, and plans nothing when it was not read', () => {
    expect(op(state({ unreadable: 'no access' }))).toMatchObject({ action: 'skip', changes: ['no access'] });
    expect(op(state(undefined))).toBeUndefined();
  });
});

describe('registration campaign exclusion: provision test-identities against Graph', () => {
  it('adds only the validation user and sends the rest of the campaign back unchanged', async () => {
    const { cloud, ctx, lines } = setup();
    // The tenant already excludes someone else (a user and a group): both stay, in order.
    const others = [
      { id: randomUUID(), targetType: 'user' },
      { id: randomUUID(), targetType: 'group' },
    ];
    campaignOf(cloud).excludeTargets.push(...others);
    const before = structuredClone(campaignOf(cloud));
    await provisionEntra(ctx);

    const run = await provisionTestIdentities(ctx);
    expect(run.ops.find((o) => o.kind === 'campaignExclusion')?.action).toBe('create');
    const tester = testerOf(cloud);
    const after = campaignOf(cloud);
    expect(after.excludeTargets).toEqual([...others, { id: tester.id, targetType: 'user' }]);
    const { excludeTargets: _a, ...restAfter } = after;
    const { excludeTargets: _b, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore); // state, includeTargets, snooze
    expect(JSON.stringify(after)).not.toContain('@odata');
    expect(policyPatches(cloud)).toHaveLength(1);
    expect(lines.join('\n')).toContain(`✓ excluded: ${TITLE}`);
    expect(lines.join('\n')).not.toContain(tester.id as string);

    // Idempotent: the second run reads, finds the exclusion and writes nothing.
    const again = await provisionTestIdentities(ctx);
    expect(again.ops.find((o) => o.kind === 'campaignExclusion')?.action).toBe('noop');
    expect(policyPatches(cloud)).toHaveLength(1);
  });

  it('never excludes anyone else: the AF-Test-* targets and other users stay in the campaign', async () => {
    const { cloud, ctx } = setup();
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    await provisionTestIdentities(ctx);
    const excluded = campaignOf(cloud).excludeTargets.map((t) => t.id);
    expect(excluded).toEqual([testerOf(cloud).id]);
    for (const u of cloud.users.filter((x) => x !== testerOf(cloud))) expect(excluded).not.toContain(u.id);
  });

  it('--dry-run plans the exclusion without writing the policy', async () => {
    const { cloud, ctx } = setup();
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx, { dryRun: true });
    expect(policyPatches(cloud)).toEqual([]);
    expect(campaignOf(cloud).excludeTargets).toEqual([]);
  });

  it('provision status shows ✓ when excluded, ✗ when the exclusion was removed, and the next run restores it', async () => {
    const { cloud, ctx, lines } = setup();
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    lines.length = 0;
    expect((await provisionStatus(ctx)).failures).not.toContain(TITLE);
    expect(lines).toContain(`    ✓ ${TITLE}`);
    expect(lines).toContain('        campaign Microsoft-managed');

    campaignOf(cloud).excludeTargets.length = 0; // someone edited the campaign in the Entra admin centre
    lines.length = 0;
    const status = await provisionStatus(ctx);
    expect(status.ok).toBe(false);
    expect(status.failures).toContain(TITLE);
    expect(lines.some((l) => l.startsWith(`    ✗ ${TITLE}`))).toBe(true);

    await provisionTestIdentities(ctx);
    expect(campaignOf(cloud).excludeTargets).toEqual([{ id: testerOf(cloud).id, targetType: 'user' }]);
  });

  it('a policy the provisioner may not read is a skip with a hint; everything else still converges', async () => {
    const { cloud, ctx, lines } = setup({ authMethodsPolicyReadable: false });
    await provisionEntra(ctx);
    const run = await provisionTestIdentities(ctx);
    const campaign = run.ops.find((o) => o.kind === 'campaignExclusion')!;
    expect(campaign.action).toBe('skip');
    expect(campaign.changes?.join(' ')).toMatch(/Global Administrator|Registration campaign/);
    expect(policyPatches(cloud)).toEqual([]);
    expect(testerOf(cloud)).toBeDefined();
    lines.length = 0;
    const status = await provisionStatus(ctx);
    expect(status.failures).not.toContain(TITLE);
    expect(lines.some((l) => l.startsWith(`    ⚠ ${TITLE}`))).toBe(true);
  });
});
