import { randomUUID } from 'node:crypto';
import { ConfigError } from '@adminforge/cli/src/shared/errors';
import {
  ADMIN_ROLES,
  CA_AUDIT_POLICIES,
  CA_AUDIT_PREFIX,
  REPORT_ONLY,
  assertReportOnly,
  blocks,
  DIRECTORY_SYNC_ROLE,
  assertNoState,
  auditPolicyPatch,
  buildAuditPolicy,
  protectedUserIds,
  type AuditPolicyBody,
} from '@adminforge/cli/src/provision/ca-audit-catalog';
import { planCaAudit, policyDrift } from '@adminforge/cli/src/provision/ca-audit-plan';
import {
  NAMED_LOCATION,
  namedPermissions,
  refusalHint,
  type CaPolicyState,
  type FixtureState,
} from '@adminforge/cli/src/provision/fixtures-model';
import {
  buildDesiredFixtures,
  fixtureSettings,
  planFixtureRemoval,
  planFixtures,
} from '@adminforge/cli/src/provision/fixtures-plan';
import { buildDesiredIdentities } from '@adminforge/cli/src/provision/identities-plan';
import { asGraphStores } from './fixtures-fake';

// The ca-audit fixture (portal/tools/cli/src/provision/ca-audit-catalog.ts, ca-audit-plan.ts): example Conditional
// Access policies that are only ever report-only, device-dependent ones scoped to AF-Test-Group-01, break-glass
// accounts excluded, and only provisioning's own (catalogue name, not on) changed or removed.

const GROUP = randomUUID();
const LOCATION = randomUUID();
const BREAK_GLASS = randomUUID();
const identities = buildDesiredIdentities({ label: 'test', domain: 'example.com' });
const desired = (fixtures = 'ca-audit,named-location', protectedIds = [BREAK_GLASS]) =>
  buildDesiredFixtures({
    identities,
    settings: fixtureSettings({ AF_TEST_FIXTURES: fixtures }),
    domain: 'example.com',
    protectedUserIds: protectedIds,
  });
const ids = { testGroupId: GROUP, protectedUserIds: [BREAK_GLASS], testLocationId: LOCATION };
const location = {
  id: LOCATION,
  displayName: NAMED_LOCATION.displayName,
  isTrusted: false,
  cidrs: ['192.0.2.0/24'],
};

/** A catalogue policy as Graph stores it (the fake's shape: every list present, unset parts null). */
function stored(spec = CA_AUDIT_POLICIES[0]!, extra: Partial<CaPolicyState> = {}): CaPolicyState {
  const g = asGraphStores(buildAuditPolicy(spec, ids) as never) as unknown as CaPolicyState;
  return { ...g, id: randomUUID(), ...extra };
}
const allStored = () => CA_AUDIT_POLICIES.map((p) => stored(p));
const state = (caPolicies: CaPolicyState[], extra: Partial<FixtureState> = {}): FixtureState => ({
  users: {},
  caPolicies,
  testGroupId: GROUP,
  namedLocations: [location],
  ...extra,
});
const plan = (s: FixtureState, remove = false, locationPlanned = true) =>
  planCaAudit(desired(), s, { remove, locationPlanned });
const summary = (ops: ReturnType<typeof plan>) =>
  ops.map((o) => `${o.action}${o.blocked ? '!' : ''} ${o.title}`);

const DEVICE_GRANTS = [
  'compliantDevice',
  'domainJoinedDevice',
  'compliantApplication',
  'approvedApplication',
];
const bodies = () => CA_AUDIT_POLICIES.map((p) => buildAuditPolicy(p, ids));
const usersOf = (b: AuditPolicyBody) => b.conditions.users as Record<string, unknown>;

describe('the catalogue', () => {
  it('has a dozen-odd uniquely named AF-Audit policies, each saying what it shows', () => {
    expect(CA_AUDIT_POLICIES.length).toBeGreaterThanOrEqual(12);
    const names = CA_AUDIT_POLICIES.map((p) => p.displayName);
    expect(new Set(names).size).toBe(names.length);
    for (const p of CA_AUDIT_POLICIES) {
      expect(p.displayName.startsWith(CA_AUDIT_PREFIX)).toBe(true);
      expect(p.shows.length).toBeGreaterThan(10);
    }
  });

  it('builds every policy report-only — the only state it can produce', () => {
    for (const b of bodies()) expect(b.state).toBe(REPORT_ONLY);
    // @ts-expect-error — the body type allows no other state
    const on: AuditPolicyBody = { ...bodies()[0]!, state: 'enabled' };
    expect(() => assertReportOnly(on)).toThrow(/only creates report-only policies/);
    expect(() => assertReportOnly({ ...bodies()[0]!, state: 'disabled' } as never)).toThrow();
    expect(() => assertReportOnly(bodies()[0]!)).not.toThrow();
  });

  it('scopes device-dependent and location policies to AF-Test-Group-01 only (report-only device policies can prompt for a certificate)', () => {
    for (const b of bodies()) {
      const grants = (b.grantControls?.builtInControls as string[] | undefined) ?? [];
      const deviceBased = grants.some((g) => DEVICE_GRANTS.includes(g)) || !!b.conditions.locations;
      if (!deviceBased) continue;
      expect(usersOf(b)).toEqual({ includeGroups: [GROUP] });
    }
    const scoped = bodies().filter((b) => (usersOf(b).includeGroups as string[] | undefined)?.length);
    expect(scoped.length).toBeGreaterThanOrEqual(3);
  });

  it('excludes the break-glass accounts (AF_PROTECTED_USER_IDS) from every policy not scoped to the test group', () => {
    for (const b of bodies()) {
      const u = usersOf(b);
      if (u.includeGroups) expect(u.excludeUsers).toBeUndefined();
      else expect(u.excludeUsers).toEqual([BREAK_GLASS]);
    }
    const none = buildAuditPolicy(CA_AUDIT_POLICIES[2]!, { ...ids, protectedUserIds: [] });
    expect(usersOf(none)).toEqual({ includeUsers: ['All'], excludeRoles: [DIRECTORY_SYNC_ROLE] });
  });

  it('targets the privileged admin roles, all users, guests and the risk levels like Microsoft’s templates', () => {
    const by = (name: string) =>
      buildAuditPolicy(
        CA_AUDIT_POLICIES.find((p) => p.displayName.endsWith(name))!,
        ids,
      );
    expect(usersOf(by('Require MFA for administrators')).includeRoles).toEqual(Object.values(ADMIN_ROLES));
    expect(usersOf(by('Require MFA for all users')).includeUsers).toEqual(['All']);
    expect(usersOf(by('guests and external users')).includeGuestsOrExternalUsers).toBeTruthy();
    expect(by('Block legacy authentication').conditions.clientAppTypes).toEqual([
      'exchangeActiveSync',
      'other',
    ]);
    expect(by('high user risk').grantControls).toEqual({
      operator: 'AND',
      builtInControls: ['mfa', 'passwordChange'],
    });
    expect(by('outside AF-Test-Location').conditions.locations).toEqual({
      includeLocations: ['All'],
      excludeLocations: [LOCATION],
    });
  });
});

describe('AF_PROTECTED_USER_IDS', () => {
  it('reads a comma-separated list of object ids', () => {
    const a = randomUUID();
    expect(protectedUserIds({ AF_PROTECTED_USER_IDS: ` ${a}, ${BREAK_GLASS} ` })).toEqual([a, BREAK_GLASS]);
    expect(protectedUserIds({})).toEqual([]);
  });

  it('refuses anything else, naming the key but never the value', () => {
    try {
      protectedUserIds({ AF_PROTECTED_USER_IDS: 'breakglass@contoso.example' });
      throw new Error('expected a ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/AF_PROTECTED_USER_IDS/);
      expect((err as Error).message).not.toContain('contoso');
    }
  });
});

describe('opting in', () => {
  it('plans nothing without "ca-audit" in AF_TEST_FIXTURES', () => {
    const d = buildDesiredFixtures({
      identities,
      settings: fixtureSettings({ AF_TEST_FIXTURES: 'named-location' }),
      domain: 'example.com',
    });
    expect(planFixtures(d, state([])).some((o) => o.fixture === 'ca-audit')).toBe(false);
    expect(fixtureSettings({ AF_TEST_FIXTURES: 'ca-audit' }).fixtures).toEqual(['ca-audit']);
  });
});

describe('the plan', () => {
  it('creates every catalogue policy (report-only) in an empty tenant', () => {
    const ops = plan(state([]));
    expect(ops).toHaveLength(CA_AUDIT_POLICIES.length);
    expect(ops.every((o) => o.kind === 'caPolicy' && o.action === 'create' && o.independent)).toBe(true);
    expect(ops[0]!.changes?.[0]).toMatch(/^report-only — shows /);
  });

  it('has nothing to do once they exist as Graph stores them', () => {
    expect(plan(state(allStored())).every((o) => o.action === 'noop')).toBe(true);
  });

  it('puts back a policy someone widened or changed, keeping it report-only', () => {
    const policies = allStored();
    // Someone added a group to "Require MFA for all users"'s exclusions and dropped MFA from the admin policy.
    (policies[2]!.conditions!.users as Record<string, unknown>).excludeGroups = [randomUUID()];
    policies[0]!.grantControls = { ...policies[0]!.grantControls, builtInControls: ['block'] };
    const ops = plan(state(policies));
    expect(summary(ops).filter((s) => s.startsWith('update'))).toEqual([
      `update ${CA_AUDIT_POLICIES[0]!.displayName}`,
      `update ${CA_AUDIT_POLICIES[2]!.displayName}`,
    ]);
    expect(ops[0]!.changes).toEqual(['grant controls differ from the catalogue — put back']);
    expect(ops[2]!.changes).toEqual([
      'conditions (who, apps, platforms, locations, risk) differ from the catalogue — put back',
    ]);
  });

  it('leaves a policy someone turned off alone (only report-only policies are updated), and can remove it', () => {
    const policies = allStored();
    policies[3]!.state = 'disabled';
    const op = plan(state(policies))[3]!;
    expect(op).toMatchObject({ kind: 'note', action: 'skip', blocked: true });
    expect(op.changes?.[0]).toMatch(/^turned off by someone — left alone/);
    const removal = plan(state(policies), true);
    expect(removal.some((o) => o.kind === 'caPolicyRemove' && o.id === policies[3]!.id)).toBe(true);
  });

  it('leaves a policy in a state it doesn’t know alone — not updated, not removed', () => {
    const policies = allStored();
    policies[5]!.state = 'somethingNew';
    expect(plan(state(policies))[5]).toMatchObject({
      blocked: true,
      changes: ['in a state provisioning doesn’t know — left alone'],
    });
    expect(
      plan(state(policies), true).some((o) => o.kind === 'caPolicyRemove' && o.id === policies[5]!.id),
    ).toBe(false);
  });

  it('blocks the group-scoped examples while AF-Test-Group-01 has strangers, is dynamic, or can’t be read', () => {
    const scoped = CA_AUDIT_POLICIES.map((p, i) => [p, i] as const).filter(([p]) => p.scope === 'testGroup');
    const stranger = {
      type: '#microsoft.graph.user',
      userPrincipalName: 'someone@example.com',
      displayName: 'Someone',
    };
    const cases: Array<[Partial<FixtureState>, RegExp]> = [
      [{ testGroupMembers: [stranger] }, /has 1 member\(s\) that aren't provisioning's test accounts/],
      [{ testGroupDynamic: true }, /uses dynamic membership/],
      [
        { testGroupMembers: { unreadable: 'could not be read (500 x)' } },
        /AF-Test-Group-01's members: could not be read/,
      ],
    ];
    for (const [extra, why] of cases) {
      const ops = plan(state(allStored(), extra));
      for (const [, i] of scoped) {
        expect(ops[i]).toMatchObject({ blocked: true });
        expect(ops[i]!.changes?.[0]).toMatch(why);
      }
      // The all-users / admin / guest policies don't depend on the group.
      expect(ops.filter((o) => o.blocked)).toHaveLength(scoped.length);
    }
  });

  it('refuses a same-named policy that is ON (enforced): never changed, never removed', () => {
    const policies = allStored();
    policies[1]!.state = 'enabled';
    policies[1]!.grantControls = { operator: 'OR', builtInControls: ['block'] };
    const ops = plan(state(policies));
    expect(ops[1]).toMatchObject({ action: 'skip', blocked: true, kind: 'note' });
    expect(ops[1]!.changes?.[0]).toMatch(/is ON \(enforced\) — not created by provisioning, left alone/);
    const removal = plan(state(policies), true);
    expect(removal.map((o) => (o.kind === 'caPolicyRemove' ? o.id : ''))).not.toContain(policies[1]!.id);
    expect(removal).toHaveLength(CA_AUDIT_POLICIES.length - 1);
  });

  it('refuses a name held by several report-only policies (which one is ours is unclear)', () => {
    const policies = [...allStored(), stored(CA_AUDIT_POLICIES[4]!)];
    expect(plan(state(policies))[4]).toMatchObject({
      blocked: true,
      changes: ['2 policies have this name — delete the extras'],
    });
  });

  it('needs AF-Test-Location for the location example: blocked without the named-location fixture, pending with it', () => {
    const loc = CA_AUDIT_POLICIES.findIndex((p) => p.outsideTestLocation);
    const without = plan(state([], { namedLocations: [] }), false, false)[loc]!;
    expect(without).toMatchObject({
      blocked: true,
      changes: ['needs AF-Test-Location — add "named-location" to AF_TEST_FIXTURES'],
    });
    const pending = plan(state([], { namedLocations: [] }), false, true)[loc]!;
    expect(pending).toMatchObject({ kind: 'caPolicy', action: 'create' });
    expect(pending.changes).toContain('after AF-Test-Location is created');
  });

  it('shows the permission when the policies can’t be read', () => {
    const ops = plan(state([], { caPolicies: { unreadable: 'grant it Policy.Read.All', forbidden: true } }));
    expect(ops).toEqual([expect.objectContaining({ blocked: true, changes: ['grant it Policy.Read.All'] })]);
  });

  it('removes only catalogue-named policies that are not on', () => {
    const own = allStored();
    const someoneElses = { ...stored(), displayName: 'Contoso MFA', id: randomUUID() };
    const ops = plan(state([...own, someoneElses]), true);
    expect(ops.map((o) => o.kind)).toEqual(CA_AUDIT_POLICIES.map(() => 'caPolicyRemove'));
    expect(ops.map((o) => (o.kind === 'caPolicyRemove' ? o.id : ''))).not.toContain(someoneElses.id);
  });
});

describe('policyDrift', () => {
  it('ignores Graph’s nulls, empty lists, casing and order, and the expanded authentication strength', () => {
    for (const spec of CA_AUDIT_POLICIES) {
      const body = buildAuditPolicy(spec, ids);
      const g = asGraphStores(body as never) as unknown as CaPolicyState;
      expect(policyDrift(body, g)).toEqual([]);
    }
  });

  it('flags a session control someone added to a policy that has none', () => {
    const body = buildAuditPolicy(CA_AUDIT_POLICIES[0]!, ids);
    const g = asGraphStores({
      ...body,
      sessionControls: { persistentBrowser: { isEnabled: true, mode: 'always' } },
    } as never);
    expect(policyDrift(body, g as unknown as CaPolicyState)).toEqual([
      'session controls differ from the catalogue — put back',
    ]);
  });
});

describe('blocking all users', () => {
  const GLOBAL_ADMIN = ADMIN_ROLES['Global Administrator'];
  it('excludes the Global Administrator role from every all-users block (Graph refuses to block everyone)', () => {
    const blockers = CA_AUDIT_POLICIES.filter((p) => p.scope === 'allUsers' && blocks(p));
    expect(blockers.map((p) => p.displayName)).toEqual([
      `${CA_AUDIT_PREFIX}Block legacy authentication`,
      `${CA_AUDIT_PREFIX}Block unknown device platforms`,
    ]);
    for (const spec of blockers)
      for (const protectedIds of [[BREAK_GLASS], []]) {
        const u = usersOf(buildAuditPolicy(spec, { ...ids, protectedUserIds: protectedIds }));
        expect(u.excludeRoles).toEqual([GLOBAL_ADMIN, DIRECTORY_SYNC_ROLE]);
      }
    // Policies that don't block keep every admin in scope (that's what they report on).
    for (const spec of CA_AUDIT_POLICIES.filter((p) => !blocks(p)))
      expect((usersOf(buildAuditPolicy(spec, ids)).excludeRoles as string[] | undefined) ?? []).not.toContain(
        GLOBAL_ADMIN,
      );
  });

  it('excludes the Directory Synchronization Accounts role from every all-users policy (as Microsoft’s templates do)', () => {
    for (const spec of CA_AUDIT_POLICIES) {
      const roles = (usersOf(buildAuditPolicy(spec, ids)).excludeRoles as string[] | undefined) ?? [];
      expect(roles.includes(DIRECTORY_SYNC_ROLE)).toBe(spec.scope === 'allUsers');
    }
  });

  it('puts the exclusion on an existing block policy created without it', () => {
    const policies = allStored();
    const legacy = CA_AUDIT_POLICIES.findIndex((p) => p.displayName.endsWith('Block legacy authentication'));
    (policies[legacy]!.conditions!.users as Record<string, unknown>).excludeRoles = [];
    const op = plan(state(policies))[legacy]!;
    expect(op).toMatchObject({ kind: 'caPolicy', action: 'update', existingId: policies[legacy]!.id });
  });
});

describe('refusal messages', () => {
  const NEEDS_APP_READ =
    'Insufficient privileges to create or update policy. Application.Read.All scope is required to add/edit application condition.';

  it('finds the Graph permission a message names', () => {
    expect(namedPermissions(NEEDS_APP_READ)).toEqual(['Application.Read.All']);
    expect(namedPermissions('Requires Policy.ReadWrite.ConditionalAccess or Policy.Read.All.')).toEqual([
      'Policy.ReadWrite.ConditionalAccess',
      'Policy.Read.All',
    ]);
    expect(namedPermissions('Insufficient privileges to complete the operation.')).toEqual([]);
  });

  it('shows Graph’s reason and the named permission when there is one, the fixture’s permissions otherwise', () => {
    const named = refusalHint('ca-audit', NEEDS_APP_READ);
    expect(named).toContain(`Graph: "${NEEDS_APP_READ}"`);
    expect(named).toContain(
      'grant the provisioner the Microsoft Graph application permission Application.Read.All',
    );
    // Several the fixture needs: either one helps.
    expect(
      refusalHint('ca-audit', 'Requires Policy.Read.All or Policy.ReadWrite.ConditionalAccess.'),
    ).toContain('permission Policy.Read.All or Policy.ReadWrite.ConditionalAccess (with admin consent)');
    const generic = refusalHint('ca-audit', 'Insufficient privileges to complete the operation.');
    expect(generic).toMatch(
      /grant it the Microsoft Graph application permission Policy\.Read\.All and Policy\.ReadWrite\.ConditionalAccess and Application\.Read\.All/,
    );
  });

  it('names only permissions the fixture needs — anything else Graph mentions gets the fixture’s own list', () => {
    const hint = refusalHint('ca-audit', 'Directory.ReadWrite.All scope is required.');
    expect(hint).not.toContain('Directory.ReadWrite.All');
    expect(hint).toMatch(/grant it the Microsoft Graph application permission Policy\.Read\.All/);
  });

  it('strips control characters from Graph’s message', () => {
    const hint = refusalHint('ca-audit', 'Application.Read.All scope\u001b[31m is required\r\nfake line');
    expect([...hint].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)).toBe(false);
    expect(hint).toContain('Application.Read.All');
  });
});

describe('updates', () => {
  it('send every scope list the catalogue omits explicitly empty (Graph merges a PATCH), and no state', () => {
    const body = buildAuditPolicy(
      CA_AUDIT_POLICIES.find((p) => p.scope === 'testGroup')!,
      ids,
    );
    const patch = auditPolicyPatch(body) as unknown as Record<string, Record<string, unknown>>;
    expect('state' in patch).toBe(false);
    expect(() => assertNoState(patch)).not.toThrow();
    expect(() => assertNoState({ ...patch, state: 'enabled' })).toThrow(/never changes one/);
    const users = patch.conditions!.users as Record<string, unknown>;
    expect(users).toMatchObject({
      includeUsers: [],
      includeGroups: [GROUP],
      excludeRoles: [],
      includeGuestsOrExternalUsers: null,
    });
    expect(patch.conditions).toMatchObject({
      platforms: null,
      locations: null,
      signInRiskLevels: [],
      devices: null,
      clientApplications: null,
    });
    expect(patch.conditions!.applications).toMatchObject({
      includeApplications: ['All'],
      includeUserActions: [],
      excludeApplications: [],
    });
    expect(patch.grantControls).toMatchObject({ authenticationStrength: null, termsOfUse: [] });
    expect(patch.sessionControls).toBeNull();
  });
});

describe('removal order', () => {
  it('deletes the audit policies before the named location they refer to', () => {
    const d = desired('named-location,ca-audit');
    const ops = planFixtureRemoval(d, state(allStored()));
    const lastCa = ops.map((o) => o.kind).lastIndexOf('caPolicyRemove');
    const loc = ops.findIndex((o) => o.kind === 'namedLocationRemove');
    expect(loc).toBeGreaterThan(lastCa);
  });
});
