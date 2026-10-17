/**
 * The `ca-audit` fixture's plan (pure): the catalogue (provision/ca-audit-catalog.ts) against the tenant's Conditional
 * Access policies → create / no-op / update / refuse, or the removal plan.
 *
 * Conditional Access policies have no description to carry a marker, so ownership is an allow-list of name and
 * state: provisioning updates a policy only when its name is exactly a catalogue name and its state is report-only.
 * A same-named policy in any other state is refused (✗) and left alone: on (enforced) — someone else's; off — someone
 * turned it off; anything else — unknown. Removal deletes report-only and off ones (never one that is on). Several
 * report-only policies with one name are refused too (which one is ours is unclear).
 *
 * The group-scoped examples are refused while AF-Test-Group-01 has members other than provisioning's test accounts
 * or uses dynamic membership: they would apply to whoever is in it.
 *
 * Drift: the fields the catalogue sets must match (lists as sets, ids and keywords case-insensitively), and every
 * scope list or condition it doesn't set must be empty — so a policy someone widened is put back. Updates never change
 * the state.
 */
import {
  CA_AUDIT_POLICIES,
  REPORT_ONLY,
  buildAuditPolicy,
  type AuditIds,
  type AuditPolicySpec,
} from './ca-audit-catalog';
import {
  isProvisionedLocation,
  isUnreadable,
  unexpectedGroupMembers,
  type CaPolicyState,
  type DesiredFixtures,
  type FixtureOp,
  type FixtureState,
} from './fixtures-model';

const SECTION = 'Test fixtures: Conditional Access (report-only)';
type Json = Record<string, unknown>;

/** Normalises a policy part for comparison: no nulls, empty lists or objects; lower-case text; sorted lists. */
function normalise(value: unknown, key = ''): unknown {
  if (value === null || value === undefined) return undefined;
  if (key === 'guestOrExternalUserTypes' && typeof value === 'string')
    return normalise(value.split(','), key);
  if (typeof value === 'string') return value.toLowerCase();
  if (Array.isArray(value)) {
    const items = value.map((v) => normalise(v)).filter((v) => v !== undefined);
    return items.length ? items.map((v) => JSON.stringify(v)).sort() : undefined;
  }
  if (typeof value === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      if (k.startsWith('@odata')) continue;
      // Graph returns the whole authentication strength object; the policy refers to it by id.
      const n =
        k === 'authenticationStrength' && v && typeof v === 'object'
          ? normalise({ id: (v as Json).id })
          : normalise(v, k);
      if (n !== undefined) out[k] = n;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

/** Whether every field `want` sets is equal in `have` (lists compared whole, as sets). */
function covers(want: unknown, have: unknown): boolean {
  if (want === undefined) return true;
  if (Array.isArray(want) || typeof want !== 'object') return JSON.stringify(want) === JSON.stringify(have);
  if (!have || typeof have !== 'object' || Array.isArray(have)) return false;
  return Object.entries(want as Json).every(([k, v]) => covers(v, (have as Json)[k]));
}

/**
 * Every scope list or condition (the same set an update sends empty — ca-audit-catalog.ts `auditPolicyPatch`):
 * non-empty in the tenant but not set by the catalogue = drift.
 */
const SCOPE_LISTS: ReadonlyArray<readonly string[]> = [
  ...[
    'includeUsers',
    'excludeUsers',
    'includeGroups',
    'excludeGroups',
    'includeRoles',
    'excludeRoles',
    'includeGuestsOrExternalUsers',
    'excludeGuestsOrExternalUsers',
  ].map((k) => ['conditions', 'users', k]),
  ...[
    'includeApplications',
    'excludeApplications',
    'includeUserActions',
    'includeAuthenticationContextClassReferences',
    'applicationFilter',
  ].map((k) => ['conditions', 'applications', k]),
  ...[
    'locations',
    'platforms',
    'signInRiskLevels',
    'userRiskLevels',
    'servicePrincipalRiskLevels',
    'clientApplications',
    'devices',
  ].map((k) => ['conditions', k]),
  ...['builtInControls', 'authenticationStrength', 'termsOfUse', 'customAuthenticationFactors'].map((k) => [
    'grantControls',
    k,
  ]),
  ['sessionControls'],
];

const at = (obj: unknown, path: readonly string[]) =>
  path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Json)[k] : undefined), obj);

/** Pure: what differs between a catalogue body and a policy in the tenant ([] = in the desired state). */
export function policyDrift(
  body: ReturnType<typeof buildAuditPolicy>,
  actual: Pick<CaPolicyState, 'conditions' | 'grantControls' | 'sessionControls'>,
): string[] {
  const want = normalise({
    conditions: body.conditions,
    grantControls: body.grantControls,
    sessionControls: body.sessionControls,
  }) as Json;
  const have = (normalise({
    conditions: actual.conditions,
    grantControls: actual.grantControls,
    sessionControls: actual.sessionControls,
  }) ?? {}) as Json;
  const parts = new Set<string>();
  for (const part of ['conditions', 'grantControls', 'sessionControls'])
    if (!covers(want[part], have[part])) parts.add(part);
  for (const path of SCOPE_LISTS)
    if (at(want, path) === undefined && at(have, path) !== undefined) parts.add(path[0]!);
  const label: Record<string, string> = {
    conditions: 'conditions (who, apps, platforms, locations, risk)',
    grantControls: 'grant controls',
    sessionControls: 'session controls',
  };
  return [...parts].map((p) => `${label[p]} differ from the catalogue — put back`);
}

/** The ids the bodies need, from the fetched state. */
function idsOf(d: DesiredFixtures, s: FixtureState): AuditIds {
  const locations = isUnreadable(s.namedLocations) ? [] : (s.namedLocations ?? []);
  return {
    testGroupId: s.testGroupId,
    protectedUserIds: d.protectedUserIds,
    testLocationId: locations.find(isProvisionedLocation)?.id,
  };
}

/** Why the group-scoped examples can't target AF-Test-Group-01 now, or undefined when they can. */
function testGroupProblem(s: FixtureState): string | undefined {
  const members = s.testGroupMembers;
  if (isUnreadable(members)) return `AF-Test-Group-01's members: ${members.unreadable}`;
  if (isUnreadable(s.testGroupDynamic))
    return `AF-Test-Group-01's membership type: ${s.testGroupDynamic.unreadable}`;
  if (s.testGroupDynamic)
    return 'AF-Test-Group-01 uses dynamic membership — anyone could fall into this policy; make it an assigned group';
  const others = members ? unexpectedGroupMembers(members) : 0;
  return others
    ? `AF-Test-Group-01 has ${others} member(s) that aren't provisioning's test accounts or AF-Test-* devices — remove them first`
    : undefined;
}

function base(spec: AuditPolicySpec) {
  return { fixture: 'ca-audit' as const, section: SECTION, title: spec.displayName, independent: true };
}

function blocked(spec: AuditPolicySpec, why: string): FixtureOp {
  return { ...base(spec), kind: 'note', action: 'skip', blocked: true, changes: [why] };
}

/**
 * Pure: the ca-audit operations. `locationPlanned`: the named-location fixture is opted in, so AF-Test-Location exists
 * or is created in this run before the policies.
 */
export function planCaAudit(
  d: DesiredFixtures,
  s: FixtureState,
  opts: { remove: boolean; locationPlanned: boolean },
): FixtureOp[] {
  const read = s.caPolicies;
  if (isUnreadable(read))
    return [
      {
        kind: 'note',
        fixture: 'ca-audit',
        section: SECTION,
        action: 'skip',
        blocked: true,
        title: 'Conditional Access audit policies (report-only)',
        changes: [read.unreadable],
      },
    ];
  const policies = read ?? [];
  const ids = idsOf(d, s);
  const groupProblem = testGroupProblem(s);
  const ops: FixtureOp[] = [];
  for (const spec of CA_AUDIT_POLICIES) {
    const same = policies.filter((p) => p.displayName === spec.displayName);
    const enforced = same.filter((p) => p.state === 'enabled');
    const off = same.filter((p) => p.state === 'disabled');
    const unknown = same.filter(
      (p) => p.state !== REPORT_ONLY && p.state !== 'enabled' && p.state !== 'disabled',
    );
    const own = same.filter((p) => p.state === REPORT_ONLY);
    if (opts.remove) {
      // Report-only and off ones; a policy that is on (or in a state we don't know) stays.
      for (const p of [...own, ...off])
        ops.push({
          ...base(spec),
          kind: 'caPolicyRemove',
          action: 'delete',
          displayName: spec.displayName,
          id: p.id,
        });
      continue;
    }
    if (enforced.length) {
      ops.push(
        blocked(
          spec,
          'a policy with this name is ON (enforced) — not created by provisioning, left alone; rename it or remove "ca-audit" from AF_TEST_FIXTURES',
        ),
      );
      continue;
    }
    if (off.length || unknown.length) {
      ops.push(
        blocked(
          spec,
          off.length
            ? 'turned off by someone — left alone; delete it (or --remove-fixtures) to have it created again'
            : 'in a state provisioning doesn’t know — left alone',
        ),
      );
      continue;
    }
    if (spec.scope === 'testGroup' && groupProblem) {
      ops.push(blocked(spec, groupProblem));
      continue;
    }
    if (own.length > 1) {
      ops.push(blocked(spec, `${own.length} policies have this name — delete the extras`));
      continue;
    }
    if (spec.outsideTestLocation && !ids.testLocationId && !opts.locationPlanned) {
      ops.push(blocked(spec, 'needs AF-Test-Location — add "named-location" to AF_TEST_FIXTURES'));
      continue;
    }
    const pending = [
      ...(spec.scope === 'testGroup' && !ids.testGroupId ? ['after AF-Test-Group-01 is created'] : []),
      ...(spec.outsideTestLocation && !ids.testLocationId ? ['after AF-Test-Location is created'] : []),
    ];
    const current = own[0];
    if (!current) {
      ops.push({
        ...base(spec),
        kind: 'caPolicy',
        action: 'create',
        displayName: spec.displayName,
        changes: [`report-only — shows ${spec.shows}`, ...pending],
      });
      continue;
    }
    const changes = policyDrift(buildAuditPolicy(spec, ids), current);
    ops.push(
      changes.length
        ? {
            ...base(spec),
            kind: 'caPolicy',
            action: 'update',
            displayName: spec.displayName,
            existingId: current.id,
            changes: [...changes, ...pending],
          }
        : { ...base(spec), kind: 'note', action: 'noop' },
    );
  }
  return ops;
}
