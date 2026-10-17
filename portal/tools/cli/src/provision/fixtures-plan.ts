/**
 * The licensed test fixtures plan (opt-in; see provision/fixtures-model.ts for what each fixture is and why).
 *
 * Pure: the opt-ins (`fixtureSettings`, from AF_TEST_LICENCE_SKU and AF_TEST_FIXTURES), the desired fixtures
 * (`buildDesiredFixtures`, from the test-identities plan's users and group) and the fetched state
 * (provision/fixtures-io.ts) → operations: `planFixtures` for `provision test-identities` and `provision status`,
 * `planFixtureRemoval` for `provision test-identities --remove-fixtures`. Objects provisioning did not create are
 * refused (blocked), never changed or removed; a part Graph refused to read is blocked with the permission it needs.
 * The approver is the exception to opt-in: a marked approver left behind is flagged, and removed by --remove-fixtures,
 * whether or not "approver" is in AF_TEST_FIXTURES.
 */
import { SKU_PART_NUMBER } from '@adminforge/config';
import { ConfigError } from '../shared/errors';
import { planApprover, planApproverRemoval, planLeftoverApprover } from './approver-plan';
import { APPS_SECTION, planApps } from './apps-fixture-plan';
import { AUTH_METHODS_SECTION, planAuthMethods } from './auth-methods-fixture';
import { planCaAudit } from './ca-audit-plan';
import { directoryCatalog } from './directory-fixture-catalog';
import { DIRECTORY_SECTION, GUEST_SECTION, planDirectory, planGuest } from './directory-fixture-plan';
import { INTUNE_MORE_SECTION, planIntuneMore } from './intune-more-fixture';
import { SIGN_INS_SECTION, planSignIns, signInAccounts } from './sign-ins-fixture';
import {
  APPROVER_DISPLAY_NAME,
  FIXTURE_NAMES,
  FIXTURE_ROLES,
  INTUNE_POLICIES,
  NAMED_LOCATION,
  isProvisionedAccount,
  isProvisionedLocation,
  isProvisionedPolicy,
  isUnreadable,
  testGroupProblem,
  wants,
  assignedOnlyTo,
  type DesiredFixtures,
  type FixtureKey,
  type FixtureName,
  type FixtureOp,
  type FixtureSettings,
  type FixtureState,
  type IntuneKind,
} from './fixtures-model';
import { TESTER_MARKER, type DesiredIdentities, type UserSpec } from './identities-plan';

/** The opt-ins from the env file. Throws (naming the key, never its value) on a malformed one. */
export function fixtureSettings(env: Readonly<Record<string, string | undefined>>): FixtureSettings {
  const licenceSku = env.AF_TEST_LICENCE_SKU?.trim() || undefined;
  if (licenceSku && !SKU_PART_NUMBER.test(licenceSku))
    throw new ConfigError(
      'AF_TEST_LICENCE_SKU must be a licence SKU part number such as SPE_E5 (upper-case letters, digits and _).',
    );
  const names = (env.AF_TEST_FIXTURES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.some((n) => !(FIXTURE_NAMES as readonly string[]).includes(n)))
    throw new ConfigError(
      `AF_TEST_FIXTURES names an unknown fixture — use a comma-separated list of: ${FIXTURE_NAMES.join(', ')}.`,
    );
  return { ...(licenceSku ? { licenceSku } : {}), fixtures: [...new Set(names as FixtureName[])] };
}

/** Pure: what the opted-in fixtures should look like, built on the test-identities plan's users and group. */
export function buildDesiredFixtures(opts: {
  identities: DesiredIdentities;
  settings: FixtureSettings;
  domain: string;
  /** AF_TEST_APPROVER_UPN (default af-approver@<domain>). */
  approverUpn?: string;
  /** AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true for this label (the approver fixture is refused then). */
  automationWrites?: boolean;
  /** AF_PROTECTED_USER_IDS (excluded from the ca-audit policies). */
  protectedUserIds?: string[];
}): DesiredFixtures {
  const { identities } = opts;
  const approverUpn = opts.approverUpn || `af-approver@${opts.domain}`;
  const target01 = identities.targets[0]!;
  return {
    label: identities.label,
    settings: opts.settings,
    tester: identities.tester,
    licensed: [identities.tester, ...identities.targets],
    eligibility: [
      { user: target01, roleName: 'Reports Reader', roleDefinitionId: FIXTURE_ROLES['Reports Reader'] },
      {
        user: identities.tester,
        roleName: 'Message Center Reader',
        roleDefinitionId: FIXTURE_ROLES['Message Center Reader'],
      },
    ],
    approver: {
      upn: approverUpn,
      displayName: APPROVER_DISPLAY_NAME,
      mailNickname: approverUpn.split('@')[0]!.replace(/[^A-Za-z0-9._-]/g, ''),
    },
    automationWrites: !!opts.automationWrites,
    protectedUserIds: opts.protectedUserIds ?? [],
    directory: directoryCatalog(opts.domain),
    signIns: signInAccounts(opts.domain),
    testGroup: {
      uniqueName: identities.testGroup.uniqueName,
      displayName: identities.testGroup.body.displayName,
      description: identities.testGroup.body.description,
    },
  };
}

const SECTIONS: Record<FixtureKey, string> = {
  licences: 'Test fixtures: licences',
  pim: 'Test fixtures: PIM eligibility',
  'named-location': 'Test fixtures: named location',
  intune: 'Test fixtures: Intune',
  approver: 'Test fixtures: approver',
  'ca-audit': 'Test fixtures: Conditional Access (report-only)',
  directory: DIRECTORY_SECTION,
  guest: GUEST_SECTION,
  apps: APPS_SECTION,
  'auth-methods': AUTH_METHODS_SECTION,
  'intune-more': INTUNE_MORE_SECTION,
  'sign-ins': SIGN_INS_SECTION,
};

const lower = (s: string) => s.toLowerCase();
/** Subscriptions licences can be assigned from (Warning = in its grace period, still active). */
const ACTIVE_SKU = new Set(['enabled', 'warning']);

/** One blocked note for a fixture whose state couldn't be read (or doesn't allow it). */
const blockedNote = (fixture: FixtureKey, title: string, why: string): FixtureOp => ({
  kind: 'note',
  fixture,
  section: SECTIONS[fixture],
  action: 'skip',
  blocked: true,
  title,
  changes: [why],
});

/** The user provisioning created for `spec`, `undefined` when it doesn't exist, or `'foreign'` when it isn't ours. */
function ownUser(state: FixtureState, spec: UserSpec) {
  const user = state.users[lower(spec.upn)];
  if (!user) return undefined;
  return isProvisionedAccount(spec, user) ? user : ('foreign' as const);
}

const FOREIGN = 'not created by provisioning — left alone';

function planLicences(d: DesiredFixtures, s: FixtureState, remove: boolean): FixtureOp[] {
  const skuName = d.settings.licenceSku!;
  const section = SECTIONS.licences;
  const sku = s.sku;
  if (isUnreadable(sku)) return [blockedNote('licences', `${skuName} for the test users`, sku.unreadable)];
  if (!sku)
    return [
      blockedNote(
        'licences',
        `${skuName} for the test users`,
        'not a subscription of this tenant — check AF_TEST_LICENCE_SKU (Microsoft 365 admin centre → Billing → Your products)',
      ),
    ];
  const ops: FixtureOp[] = [];
  const seats = `${sku.consumedUnits} of ${sku.enabledUnits} seats used`;
  if (!remove && !ACTIVE_SKU.has(lower(sku.capabilityStatus)))
    return [
      blockedNote(
        'licences',
        `${skuName} for the test users`,
        `the subscription is ${sku.capabilityStatus}: licences can only be assigned from an active one`,
      ),
    ];
  ops.push({ kind: 'note', fixture: 'licences', section, action: 'noop', title: `${skuName}: ${seats}` });
  const title = (u: UserSpec) => `${u.displayName}: ${skuName}`;
  for (const spec of d.licensed) {
    const user = ownUser(s, spec);
    const has = user && user !== 'foreign' && user.skuIds.includes(sku.skuId);
    if (user === 'foreign') {
      if (!remove) ops.push(blockedNote('licences', title(spec), FOREIGN));
      continue;
    }
    if (remove) {
      if (has)
        ops.push({
          kind: 'licenceRemove',
          fixture: 'licences',
          section,
          action: 'delete',
          title: title(spec),
          upn: spec.upn,
          skuId: sku.skuId,
        });
      continue;
    }
    if (has) {
      ops.push({ kind: 'note', fixture: 'licences', section, action: 'noop', title: title(spec) });
      continue;
    }
    ops.push({
      kind: 'licence',
      fixture: 'licences',
      section,
      action: 'create',
      title: title(spec),
      upn: spec.upn,
      skuId: sku.skuId,
      ...(!user
        ? { changes: ['after the user is created'] }
        : !user.usageLocation
          ? { changes: ["sets its usage location to the organisation's country first"] }
          : {}),
    });
  }
  const needed = ops.filter((o) => o.kind === 'licence').length;
  const free = sku.enabledUnits - sku.consumedUnits;
  if (needed > free)
    return ops.map((o) =>
      o.kind === 'licence'
        ? {
            ...o,
            action: 'skip' as const,
            blocked: true,
            changes: [`no free seat: ${seats}, ${needed} needed — add seats or free some`],
          }
        : o,
    );
  return ops;
}

function planEligibility(d: DesiredFixtures, s: FixtureState, remove: boolean): FixtureOp[] {
  const section = SECTIONS.pim;
  const read = s.eligibility;
  if (isUnreadable(read)) return [blockedNote('pim', 'PIM eligible assignments', read.unreadable)];
  const ops: FixtureOp[] = [];
  for (const e of d.eligibility) {
    const title = `${e.user.displayName} eligible for ${e.roleName} (directory scope /, not active)`;
    const user = ownUser(s, e.user);
    if (user === 'foreign') {
      if (!remove) ops.push(blockedNote('pim', title, FOREIGN));
      continue;
    }
    const has = (read?.[lower(e.user.upn)] ?? []).some(
      (a) => lower(a.roleDefinitionId) === e.roleDefinitionId && a.directoryScopeId === '/',
    );
    if (remove) {
      if (has)
        ops.push({
          kind: 'eligibilityRemove',
          fixture: 'pim',
          section,
          action: 'delete',
          title,
          upn: e.user.upn,
          roleDefinitionId: e.roleDefinitionId,
        });
      continue;
    }
    ops.push(
      has
        ? { kind: 'note', fixture: 'pim', section, action: 'noop', title }
        : {
            kind: 'eligibility',
            fixture: 'pim',
            section,
            action: 'create',
            title,
            upn: e.user.upn,
            roleDefinitionId: e.roleDefinitionId,
            changes: [user ? 'eligible only: activation is up to the user' : 'after the user is created'],
          },
    );
  }
  return ops;
}

function planNamedLocation(s: FixtureState, remove: boolean): FixtureOp[] {
  const section = SECTIONS['named-location'];
  const title = `${NAMED_LOCATION.displayName} (${NAMED_LOCATION.cidr}, not trusted)`;
  const read = s.namedLocations;
  if (isUnreadable(read)) return [blockedNote('named-location', title, read.unreadable)];
  const same = (read ?? []).filter((l) => l.displayName === NAMED_LOCATION.displayName);
  const ours = same.find(isProvisionedLocation);
  const foreign = same.find((l) => !isProvisionedLocation(l));
  const base = { fixture: 'named-location', section, title } as const;
  if (remove) return ours ? [{ ...base, kind: 'namedLocationRemove', action: 'delete', id: ours.id }] : [];
  if (ours) return [{ ...base, kind: 'note', action: 'noop' }];
  if (foreign)
    return [
      blockedNote(
        'named-location',
        title,
        'a named location with this name exists with other IP ranges or marked trusted — not created by provisioning, left alone; rename or delete it',
      ),
    ];
  return [{ ...base, kind: 'namedLocation', action: 'create' }];
}

function planIntune(d: DesiredFixtures, s: FixtureState, remove: boolean): FixtureOp[] {
  const section = SECTIONS.intune;
  const read = s.intune;
  if (isUnreadable(read))
    return [blockedNote('intune', 'Intune compliance policy and configuration profile', read.unreadable)];
  const ops: FixtureOp[] = [];
  for (const policy of ['compliance', 'configuration'] as IntuneKind[]) {
    const spec = INTUNE_POLICIES[policy];
    const what = policy === 'compliance' ? 'compliance policy' : 'configuration profile';
    const title = `${spec.displayName} (${what}) → ${d.testGroup.displayName}`;
    const same = (read?.[policy] ?? []).filter((p) => p.displayName === spec.displayName);
    const ours = same.find(isProvisionedPolicy);
    const base = { fixture: 'intune', section, title } as const;
    if (remove) {
      if (ours) ops.push({ ...base, kind: 'intunePolicyRemove', action: 'delete', policy, id: ours.id });
      continue;
    }
    if (!ours && same.length) {
      ops.push(
        blockedNote(
          'intune',
          title,
          `an Intune ${what} with this name exists without the "${TESTER_MARKER}" marker in its description — not created by provisioning, left alone`,
        ),
      );
      continue;
    }
    if (!ours) {
      ops.push({ ...base, kind: 'intunePolicy', action: 'create', policy });
      continue;
    }
    // ✓ only when the one assignment includes AF-Test-Group-01; anything else (none, more, an exclusion, all
    // devices) is replaced by exactly that.
    ops.push(
      assignedOnlyTo(ours, s.testGroupId)
        ? { ...base, kind: 'note', action: 'noop' }
        : {
            ...base,
            kind: 'intunePolicy',
            action: 'update',
            policy,
            existingId: ours.id,
            changes: [
              ours.targets.length
                ? `assigned to ${ours.targets.length} other target(s) — re-assign to ${d.testGroup.displayName} only`
                : `assign to ${d.testGroup.displayName}`,
            ],
          },
    );
  }
  return ops;
}

/** Pure: the opted-in fixtures + fetched state → operations (`provision test-identities`, `provision status`). */
export function planFixtures(
  desired: DesiredFixtures,
  state: FixtureState,
  /** `provision status`: an enterprise fixture no longer opted in whose marked objects are still there is ✗. */
  opts: { leftovers?: boolean } = {},
): FixtureOp[] {
  return plan(desired, state, false, !!opts.leftovers);
}

/**
 * Pure: `--remove-fixtures` — removes what the opted-in fixtures created, and every enterprise fixture's marked
 * objects whether or not it is opted in (the state then has them read) — only provisioning's own objects.
 */
export function planFixtureRemoval(desired: DesiredFixtures, state: FixtureState): FixtureOp[] {
  return plan(desired, state, true);
}

function plan(d: DesiredFixtures, s: FixtureState, remove: boolean, leftovers = false): FixtureOp[] {
  const ops: FixtureOp[] = [];
  // The audit policies come after the named location when provisioning (the location example excludes it) and before
  // it when removing (Graph refuses to delete a named location a policy still refers to).
  const caAudit = () =>
    wants(d.settings, 'ca-audit')
      ? planCaAudit(d, s, { remove, locationPlanned: wants(d.settings, 'named-location') })
      : [];
  if (remove) ops.push(...caAudit());
  // The enterprise fixtures, each in its own module; removed in reverse order (methods and apps before the users),
  // whether or not they are opted in (their state is read for removal and status).
  const newer = (): FixtureOp[] => {
    const planners: Array<[FixtureName, (removing: boolean) => FixtureOp[]]> = [
      ['directory', (r) => planDirectory(d, s.directory, r)],
      ['guest', (r) => planGuest(d, s.directory, r)],
      ['apps', (r) => planApps(d, s.apps, r)],
      ['auth-methods', (r) => planAuthMethods(d, s.authMethods, r)],
      ['intune-more', (r) => planIntuneMore(d, s.intuneMore, r, testGroupProblem(s))],
      ['sign-ins', (r) => planSignIns(d, s.signIns, r)],
    ];
    if (remove) return [...planners].reverse().flatMap(([, plan]) => plan(true));
    const ops = planners.filter(([name]) => wants(d.settings, name)).flatMap(([, plan]) => plan(false));
    // Not opted in, but its marked objects are still there: ✗ until --remove-fixtures takes them away.
    if (leftovers)
      for (const [name, plan] of planners) {
        if (wants(d.settings, name)) continue;
        const left = plan(true).filter((o) => o.action === 'delete').length;
        if (left)
          ops.push({
            kind: 'note',
            fixture: name,
            section: SECTIONS[name],
            action: 'skip',
            blocked: true,
            title: `${name}: ${left} object(s) left over — "${name}" is not in AF_TEST_FIXTURES`,
            changes: ['run `pnpm adminforge provision test-identities --remove-fixtures` (dry run first)'],
          });
      }
    return ops;
  };
  if (remove) ops.push(...newer());
  if (wants(d.settings, 'licences')) ops.push(...planLicences(d, s, remove));
  if (wants(d.settings, 'pim')) ops.push(...planEligibility(d, s, remove));
  if (wants(d.settings, 'named-location')) ops.push(...planNamedLocation(s, remove));
  if (wants(d.settings, 'intune')) ops.push(...planIntune(d, s, remove));
  if (!remove) ops.push(...caAudit(), ...newer());
  // The approver: provisioned when opted in; removed by --remove-fixtures and flagged as left over even when not.
  if (s.approver) {
    if (remove) ops.push(...planApproverRemoval(d, s.approver));
    else if (wants(d.settings, 'approver')) ops.push(...planApprover(d, s.approver));
    else ops.push(...planLeftoverApprover(d, s.approver));
  }
  return ops;
}

/** Re-exported for the callers that import it from here (it lives in fixtures-model.ts with the other rules). */
export { unexpectedGroupMembers } from './fixtures-model';
