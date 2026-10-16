import { randomUUID } from 'node:crypto';
import { ConfigError } from '@adminforge/cli/src/shared/errors';
import {
  APPROVER_MARKER,
  buildDesiredIdentities,
  planIdentities,
  TESTER_MARKER,
} from '@adminforge/cli/src/provision/identities-plan';
import {
  FIXTURE_DESCRIPTION,
  FIXTURE_ROLES,
  GROUP_TARGET,
  NAMED_LOCATION,
  permissionHint,
  type ApproverState,
  type FixtureState,
  type FixtureUser,
} from '@adminforge/cli/src/provision/fixtures-model';
import {
  buildDesiredFixtures,
  fixtureSettings,
  planFixtureRemoval,
  planFixtures,
  unexpectedGroupMembers,
} from '@adminforge/cli/src/provision/fixtures-plan';

// The licensed test fixtures plan (portal/tools/cli/src/provision/fixtures-plan.ts, approver-plan.ts): opt-in, only
// provisioning's own objects are changed or removed, and a fixture that can't be done is blocked with the reason.

const SKU = randomUUID();
const identities = buildDesiredIdentities({ label: 'test', domain: 'example.com' });
const desiredFor = (env: Record<string, string>) =>
  buildDesiredFixtures({ identities, settings: fixtureSettings(env), domain: 'example.com' });

const user = (upn: string, displayName: string, extra: Partial<FixtureUser> = {}): FixtureUser => ({
  id: randomUUID(),
  userPrincipalName: upn,
  displayName,
  usageLocation: 'US',
  skuIds: [],
  ...extra,
});
const testUsers = (extra: Partial<FixtureUser> = {}) =>
  Object.fromEntries(
    [identities.tester, ...identities.targets].map((u) => [u.upn, user(u.upn, u.displayName, extra)]),
  );
const sku = (consumed = 0, enabled = 25, status = 'Enabled') => ({
  skuId: SKU,
  skuPartNumber: 'SPE_E5',
  capabilityStatus: status,
  consumedUnits: consumed,
  enabledUnits: enabled,
});
const summary = (ops: ReturnType<typeof planFixtures>) =>
  ops.map((o) => `${o.action}${o.blocked ? '!' : ''} ${o.title}`);

describe('opting in (AF_TEST_LICENCE_SKU, AF_TEST_FIXTURES)', () => {
  it('is off by default: no fixture is planned', () => {
    const settings = fixtureSettings({});
    expect(settings).toEqual({ fixtures: [] });
    expect(planFixtures(desiredFor({}), { users: {} })).toEqual([]);
  });

  it('reads a SKU part number and a list of fixtures (case and spaces ignored, duplicates dropped)', () => {
    expect(fixtureSettings({ AF_TEST_LICENCE_SKU: 'SPE_E5', AF_TEST_FIXTURES: ' PIM, intune ,pim' })).toEqual(
      {
        licenceSku: 'SPE_E5',
        fixtures: ['pim', 'intune'],
      },
    );
  });

  it('refuses an unknown fixture or a SKU that is not a part number — naming the key, never the value', () => {
    expect(() => fixtureSettings({ AF_TEST_FIXTURES: 'pim,secret-thing' })).toThrow(ConfigError);
    expect(() => fixtureSettings({ AF_TEST_FIXTURES: 'pim,secret-thing' })).toThrow(/^(?!.*secret-thing)/s);
    expect(() => fixtureSettings({ AF_TEST_LICENCE_SKU: 'contoso.com' })).toThrow(/AF_TEST_LICENCE_SKU/);
    expect(() => fixtureSettings({ AF_TEST_LICENCE_SKU: 'contoso.com' })).toThrow(/^(?!.*contoso)/s);
  });

  it('plans only the opted-in fixtures', () => {
    const ops = planFixtures(desiredFor({ AF_TEST_FIXTURES: 'named-location' }), {
      users: {},
      namedLocations: [],
    });
    expect(new Set(ops.map((o) => o.fixture))).toEqual(new Set(['named-location']));
  });
});

describe('licences', () => {
  const desired = desiredFor({ AF_TEST_LICENCE_SKU: 'SPE_E5' });

  it('assigns the SKU to the validation user and AF-Test-User-01..03, with the seat count', () => {
    const ops = planFixtures(desired, { sku: sku(1), users: testUsers() });
    expect(summary(ops)).toEqual([
      'noop SPE_E5: 1 of 25 seats used',
      'create AF Tester: SPE_E5',
      'create AF-Test-User-01: SPE_E5',
      'create AF-Test-User-02: SPE_E5',
      'create AF-Test-User-03: SPE_E5',
    ]);
  });

  it('is a no-op for users that hold it, and plans users not created yet after their creation', () => {
    const users = testUsers({ skuIds: [SKU] });
    delete users[identities.targets[2]!.upn];
    const ops = planFixtures(desired, { sku: sku(3), users });
    expect(ops.filter((o) => o.action === 'noop')).toHaveLength(4);
    expect(ops.find((o) => o.action === 'create')).toMatchObject({
      title: 'AF-Test-User-03: SPE_E5',
      changes: ['after the user is created'],
    });
  });

  it("sets a missing usage location from the organisation's country first", () => {
    const ops = planFixtures(desired, { sku: sku(), users: testUsers({ usageLocation: null }) });
    expect(ops.find((o) => o.kind === 'licence')?.changes).toEqual([
      "sets its usage location to the organisation's country first",
    ]);
  });

  it('never touches an account provisioning did not create', () => {
    const users = testUsers();
    users[identities.targets[0]!.upn] = user(identities.targets[0]!.upn, 'Jane Doe');
    const op = planFixtures(desired, { sku: sku(), users }).find((o) =>
      o.title.startsWith('AF-Test-User-01'),
    );
    expect(op).toMatchObject({
      action: 'skip',
      blocked: true,
      changes: [expect.stringMatching(/not created by provisioning/)],
    });
    expect(
      planFixtureRemoval(desired, { sku: sku(), users }).some((o) => o.title.startsWith('AF-Test-User-01')),
    ).toBe(false);
  });

  it('blocks when the SKU is missing, inactive, or out of seats', () => {
    expect(summary(planFixtures(desired, { sku: null, users: testUsers() }))).toEqual([
      'skip! SPE_E5 for the test users',
    ]);
    expect(planFixtures(desired, { sku: sku(0, 25, 'Suspended'), users: testUsers() })[0]).toMatchObject({
      blocked: true,
      changes: [expect.stringMatching(/Suspended/)],
    });
    const full = planFixtures(desired, { sku: sku(23), users: testUsers() });
    expect(full.filter((o) => o.kind === 'licence').every((o) => o.action === 'skip' && o.blocked)).toBe(
      true,
    );
    expect(full.find((o) => o.kind === 'licence')?.changes?.[0]).toMatch(
      /no free seat: 23 of 25 seats used, 4 needed/,
    );
  });

  it('removal takes the SKU back from the test users that hold it, nothing else', () => {
    const users = testUsers({ skuIds: [SKU, randomUUID()] });
    users[identities.targets[1]!.upn]!.skuIds = [];
    const ops = planFixtureRemoval(desired, { sku: sku(3), users });
    expect(ops.filter((o) => o.kind === 'licenceRemove').map((o) => o.title)).toEqual([
      'AF Tester: SPE_E5',
      'AF-Test-User-01: SPE_E5',
      'AF-Test-User-03: SPE_E5',
    ]);
  });
});

describe('PIM eligibility', () => {
  const desired = desiredFor({ AF_TEST_FIXTURES: 'pim' });
  const users = testUsers();
  const target = identities.targets[0]!.upn;
  const tester = identities.tester.upn;

  it('makes AF-Test-User-01 eligible for Reports Reader and the validation user for Message Center Reader', () => {
    const ops = planFixtures(desired, { users, eligibility: { [target]: [], [tester]: [] } });
    expect(ops.map((o) => [o.action, o.title, o.kind === 'eligibility' ? o.roleDefinitionId : ''])).toEqual([
      [
        'create',
        'AF-Test-User-01 eligible for Reports Reader (directory scope /, not active)',
        FIXTURE_ROLES['Reports Reader'],
      ],
      [
        'create',
        'AF Tester eligible for Message Center Reader (directory scope /, not active)',
        FIXTURE_ROLES['Message Center Reader'],
      ],
    ]);
  });

  it('is a no-op when eligible at directory scope /, and removal takes exactly those back', () => {
    const eligibility = {
      [target]: [{ roleDefinitionId: FIXTURE_ROLES['Reports Reader'], directoryScopeId: '/' }],
      [tester]: [
        {
          roleDefinitionId: FIXTURE_ROLES['Message Center Reader'],
          directoryScopeId: '/administrativeUnits/x',
        },
      ],
    };
    expect(summary(planFixtures(desired, { users, eligibility }))).toEqual([
      'noop AF-Test-User-01 eligible for Reports Reader (directory scope /, not active)',
      'create AF Tester eligible for Message Center Reader (directory scope /, not active)',
    ]);
    expect(planFixtureRemoval(desired, { users, eligibility }).map((o) => o.kind)).toEqual([
      'eligibilityRemove',
    ]);
  });

  it('a refused read blocks the fixture with the permission it needs', () => {
    const ops = planFixtures(desired, {
      users,
      eligibility: { unreadable: permissionHint('pim'), forbidden: true },
    });
    expect(ops).toEqual([
      expect.objectContaining({
        action: 'skip',
        blocked: true,
        changes: [
          expect.stringMatching(
            /RoleEligibilitySchedule\.ReadWrite\.Directory.*remove "pim" from AF_TEST_FIXTURES/,
          ),
        ],
      }),
    ]);
  });
});

describe('named location', () => {
  const desired = desiredFor({ AF_TEST_FIXTURES: 'named-location' });
  const ours = {
    id: randomUUID(),
    displayName: NAMED_LOCATION.displayName,
    isTrusted: false,
    cidrs: [NAMED_LOCATION.cidr],
  };

  it('creates AF-Test-Location (documentation range, not trusted), no-op when it exists', () => {
    expect(summary(planFixtures(desired, { users: {}, namedLocations: [] }))).toEqual([
      'create AF-Test-Location (192.0.2.0/24, not trusted)',
    ]);
    expect(summary(planFixtures(desired, { users: {}, namedLocations: [ours] }))).toEqual([
      'noop AF-Test-Location (192.0.2.0/24, not trusted)',
    ]);
    expect(planFixtureRemoval(desired, { users: {}, namedLocations: [ours] })).toEqual([
      expect.objectContaining({ kind: 'namedLocationRemove', id: ours.id }),
    ]);
  });

  it('refuses a same-named location with other ranges or trusted, and never removes it', () => {
    for (const foreign of [
      { ...ours, cidrs: ['203.0.113.0/24'] },
      { ...ours, isTrusted: true },
    ]) {
      expect(planFixtures(desired, { users: {}, namedLocations: [foreign] })[0]).toMatchObject({
        action: 'skip',
        blocked: true,
      });
      expect(planFixtureRemoval(desired, { users: {}, namedLocations: [foreign] })).toEqual([]);
    }
  });
});

describe('Intune', () => {
  const desired = desiredFor({ AF_TEST_FIXTURES: 'intune' });
  const group = randomUUID();
  const include = (groupId: string) => ({ type: GROUP_TARGET, groupId });
  const policy = (
    displayName: string,
    description: string,
    targets: Array<{ type: string; groupId?: string }> = [],
  ) => ({
    id: randomUUID(),
    displayName,
    description,
    targets,
  });
  const state = (
    compliance: ReturnType<typeof policy>[],
    configuration: ReturnType<typeof policy>[] = [],
  ): FixtureState => ({
    users: {},
    testGroupId: group,
    intune: { compliance, configuration },
  });

  it('creates the compliance policy and configuration profile for AF-Test-Group-01', () => {
    expect(summary(planFixtures(desired, state([])))).toEqual([
      'create AF-Test Compliance (Windows) (compliance policy) → AF-Test-Group-01',
      'create AF-Test Configuration (Windows) (configuration profile) → AF-Test-Group-01',
    ]);
  });

  it('is ✓ only with exactly one target that includes AF-Test-Group-01', () => {
    const ops = planFixtures(
      desired,
      state(
        [policy('AF-Test Compliance (Windows)', FIXTURE_DESCRIPTION, [include(group)])],
        [policy('AF-Test Configuration (Windows)', FIXTURE_DESCRIPTION)],
      ),
    );
    expect(ops.map((o) => o.action)).toEqual(['noop', 'update']);
    expect(ops[1]).toMatchObject({ kind: 'intunePolicy', changes: ['assign to AF-Test-Group-01'] });
  });

  it('re-assigns to AF-Test-Group-01 only when other targets are there too (exclusion, all devices, another group)', () => {
    for (const targets of [
      [include(group), include(randomUUID())],
      [include(group), { type: '#microsoft.graph.exclusionGroupAssignmentTarget', groupId: randomUUID() }],
      [{ type: '#microsoft.graph.allDevicesAssignmentTarget' }],
      [{ type: '#microsoft.graph.exclusionGroupAssignmentTarget', groupId: group }],
    ]) {
      const [op] = planFixtures(
        desired,
        state([policy('AF-Test Compliance (Windows)', FIXTURE_DESCRIPTION, targets)]),
      );
      expect(op).toMatchObject({
        kind: 'intunePolicy',
        action: 'update',
        changes: [`assigned to ${targets.length} other target(s) — re-assign to AF-Test-Group-01 only`],
      });
    }
  });

  it('removal takes back only marked policies', () => {
    const s = state(
      [policy('AF-Test Compliance (Windows)', FIXTURE_DESCRIPTION, [include(group)])],
      [policy('AF-Test Configuration (Windows)', FIXTURE_DESCRIPTION)],
    );
    expect(planFixtureRemoval(desired, s).map((o) => o.kind)).toEqual([
      'intunePolicyRemove',
      'intunePolicyRemove',
    ]);
  });

  it('refuses a same-named policy without the marker, and never removes it', () => {
    const s = state([policy('AF-Test Compliance (Windows)', 'Someone else’s policy')]);
    expect(planFixtures(desired, s)[0]).toMatchObject({ action: 'skip', blocked: true });
    expect(planFixtureRemoval(desired, s)).toEqual([]);
    expect(FIXTURE_DESCRIPTION).toContain(TESTER_MARKER);
  });

  it('counts members of AF-Test-Group-01 that are not provisioning’s test accounts or AF-Test-* devices', () => {
    const user = (upn: string, displayName: string, employeeType: string | null = null) => ({
      type: '#microsoft.graph.user',
      userPrincipalName: upn,
      displayName,
      employeeType,
    });
    expect(
      unexpectedGroupMembers([
        user('af-tester@example.com', 'AF Tester', TESTER_MARKER),
        user('af-test-user-02@example.com', 'AF-Test-User-02'),
        { type: '#microsoft.graph.device', displayName: 'AF-Test-Win11' },
      ]),
    ).toBe(0);
    expect(
      unexpectedGroupMembers([
        user('jane@example.com', 'Jane Doe'),
        user('af-approver@example.com', 'AF Tester 2', APPROVER_MARKER),
        { type: '#microsoft.graph.device', displayName: 'LAPTOP-42' },
        { type: '#microsoft.graph.group', displayName: 'All staff' },
      ]),
    ).toBe(4);
  });
});

describe('approver', () => {
  const desired = desiredFor({ AF_TEST_FIXTURES: 'approver' });
  const readerGroup = { id: randomUUID(), displayName: 'SG-AdminForge-test-Portal.Reader' };
  const approverGroup = { id: randomUUID(), displayName: 'SG-AdminForge-test-Playbook.Approver' };
  const operatorGroup = { id: randomUUID(), displayName: 'SG-AdminForge-test-Portal.Operator' };
  const base = (extra: Partial<ApproverState> = {}): ApproverState => ({
    groupIds: [],
    roleAssignments: [],
    portalGroups: {
      'Portal.Reader': readerGroup,
      'Playbook.Approver': approverGroup,
      'Portal.Operator': operatorGroup,
    } as ApproverState['portalGroups'],
    registrationCampaign: { state: 'default', excludeTargets: [] },
    env: {},
    ...extra,
  });
  const account = (extra = {}) => ({
    id: randomUUID(),
    userPrincipalName: 'af-approver@example.com',
    displayName: 'AF Tester 2',
    employeeType: APPROVER_MARKER,
    accountEnabled: false,
    ...extra,
  });

  it('creates AF Tester 2 with Portal.Reader and Playbook.Approver and the campaign exclusion', () => {
    expect(desired.approver.upn).toBe('af-approver@example.com');
    expect(summary(planFixtures(desired, { users: {}, approver: base() }))).toEqual([
      'create AF Tester 2 (AF_TEST_APPROVER_UPN)',
      'create AF Tester 2 excluded from the authentication methods registration campaign (sign-in nudge)',
      'create AF Tester 2 ∈ SG-AdminForge-test-Portal.Reader',
      'create AF Tester 2 ∈ SG-AdminForge-test-Playbook.Approver',
    ]);
  });

  it('removes Operator (or Author/Admin) and every direct directory role; a role through a group is ✗', () => {
    const user = account();
    const ops = planFixtures(desired, {
      users: {},
      approver: base({
        user,
        groupIds: [readerGroup.id, approverGroup.id, operatorGroup.id],
        roleAssignments: [{ id: 'a1', roleDefinitionId: randomUUID() }],
        roleGrants: [
          { roleDefinitionId: randomUUID(), name: 'Helpdesk Administrator', scope: '/', via: 'group' },
        ],
        env: { upn: user.userPrincipalName, password: 'set' },
        registrationCampaign: { excludeTargets: [{ id: user.id }] },
      }),
    });
    expect(summary(ops)).toEqual([
      'noop AF Tester 2 (AF_TEST_APPROVER_UPN)',
      'noop AF Tester 2 excluded from the authentication methods registration campaign (sign-in nudge)',
      'noop AF Tester 2 ∈ SG-AdminForge-test-Portal.Reader',
      'noop AF Tester 2 ∈ SG-AdminForge-test-Playbook.Approver',
      'delete AF Tester 2 ∉ SG-AdminForge-test-Portal.Operator',
      'delete AF Tester 2: directory role assignments',
      'skip! AF Tester 2: Helpdesk Administrator through a group',
    ]);
  });

  it('resets the password when the env file lacks it', () => {
    const ops = planFixtures(desired, { users: {}, approver: base({ user: account(), env: {} }) });
    expect(ops[0]).toMatchObject({ kind: 'approver', mode: 'resetPassword', action: 'update' });
  });

  it('is refused where AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true', () => {
    const writes = buildDesiredFixtures({
      identities,
      settings: fixtureSettings({ AF_TEST_FIXTURES: 'approver' }),
      domain: 'example.com',
      automationWrites: true,
    });
    const ops = planFixtures(writes, { users: {}, approver: base() });
    expect(summary(ops)).toEqual(['skip! AF Tester 2 (AF_TEST_APPROVER_UPN)']);
    expect(ops[0]!.changes![0]).toMatch(/AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true/);
    // Removal is never refused for that reason.
    expect(planFixtureRemoval(writes, { users: {}, approver: base({ user: account() }) })[0]).toMatchObject({
      kind: 'approverRemove',
    });
  });

  it('needs its own marker: the validation user’s marker or display name alone is refused', () => {
    for (const foreign of [
      account({ employeeType: TESTER_MARKER }),
      account({ employeeType: null }),
      account({ displayName: 'Jane Doe', employeeType: null }),
    ]) {
      expect(summary(planFixtures(desired, { users: {}, approver: base({ user: foreign }) }))).toEqual([
        'skip! AF Tester 2 (AF_TEST_APPROVER_UPN)',
      ]);
      expect(planFixtureRemoval(desired, { users: {}, approver: base({ user: foreign }) })[0]).toMatchObject({
        action: 'skip',
        blocked: true,
      });
    }
  });

  it('refuses an AF_TEST_APPROVER_UPN that is not af-… or is the validation user’s (any case) — both ways', () => {
    const withUpn = (approverUpn: string) =>
      buildDesiredFixtures({
        identities,
        settings: fixtureSettings({ AF_TEST_FIXTURES: 'approver' }),
        domain: 'example.com',
        approverUpn,
      });
    expect(
      planFixtures(withUpn('jane@example.com'), { users: {}, approver: base() })[0]?.changes?.[0],
    ).toMatch(/must start with "af-"/);
    expect(
      planFixtures(withUpn('AF-Tester@Example.com'), { users: {}, approver: base() })[0]?.changes?.[0],
    ).toMatch(/name the same account/);
    // The other direction: the validation user's plan refuses the approver's UPN.
    const tester = buildDesiredIdentities({
      label: 'test',
      domain: 'example.com',
      testerUpn: 'af-approver@example.com',
    });
    const [op] = planIdentities(tester, {
      testerGroupIds: [],
      testerRoleIds: [],
      portalGroups: {},
      targets: {},
      env: {},
    });
    expect(op).toMatchObject({ kind: 'tester', refused: expect.stringMatching(/name the same account/) });
  });

  it('a marked approver while the fixture is not opted in is left over: ✗, and removed by --remove-fixtures', () => {
    const off = desiredFor({});
    const user = account();
    expect(summary(planFixtures(off, { users: {}, approver: base({ user }) }))).toEqual([
      'skip! AF Tester 2 (AF_TEST_APPROVER_UPN)',
    ]);
    expect(planFixtures(off, { users: {}, approver: base({ user }) })[0]!.changes![0]).toMatch(
      /left over.*--remove-fixtures/,
    );
    expect(planFixtureRemoval(off, { users: {}, approver: base({ user }) })).toEqual([
      expect.objectContaining({ kind: 'approverRemove', id: user.id }),
    ]);
    // Someone else's account at that UPN is no leftover of ours.
    expect(
      planFixtures(off, { users: {}, approver: base({ user: account({ employeeType: null }) }) }),
    ).toEqual([]);
  });

  it('removal deletes only its own account, and plans nothing when there is none', () => {
    const user = account();
    expect(planFixtureRemoval(desired, { users: {}, approver: base({ user }) })).toEqual([
      expect.objectContaining({ kind: 'approverRemove', action: 'delete', id: user.id }),
    ]);
    expect(planFixtureRemoval(desired, { users: {}, approver: base() })).toEqual([]);
  });
});
