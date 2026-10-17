/**
 * The `directory` test fixture's plan (pure): the catalogue (provision/directory-fixture-catalog.ts) against what the
 * tenant has → one operation per user, the guest, each group and the administrative unit (create, update with what
 * differs, or nothing), or the removal plan. Graph I/O: provision/directory-fixture-io.ts.
 *
 * Ownership: a user or the guest is provisioning's when it carries DIRECTORY_MARKER in `employeeType` (and has its
 * catalogue display name); a group or the administrative unit when its description carries the marker. Anything else
 * with the same UPN or name is refused (blocked) and never changed or removed — the guest too (the invitation and the
 * marking are one step: a guest that can't be marked is deleted again). AF-Test-User-01..03 and AF-Test-Group-01 are
 * used (members, nesting) only when they are the ones the test identities created.
 *
 * Licences come from AF_TEST_LICENCE_SKU: one direct licence (a disabled user) and the licence group's members, all
 * planned only when the subscription has that many free seats; without AF_TEST_LICENCE_SKU they are skipped.
 */
import {
  DIRECTORY_MARKER,
  DYNAMIC_RULE,
  PROFILE_ATTRIBUTES,
  directorySeats,
  type DirectoryGroupKey,
  type DirectoryGroupSpec,
  type DirectoryUserKey,
  type DirectoryUserSpec,
  type MemberRef,
} from './directory-fixture-catalog';
import { isUnreadable, type DesiredFixtures, type FixtureOp, type Unreadable } from './fixtures-model';
import { TESTER_MARKER } from './identities-plan';

export const DIRECTORY_SECTION = 'Test fixtures: directory';

export interface DirectoryUserState {
  id: string;
  userPrincipalName: string;
  displayName?: string;
  employeeType?: string | null;
  accountEnabled?: boolean;
  passwordPolicies?: string | null;
  givenName?: string | null;
  surname?: string | null;
  department?: string | null;
  jobTitle?: string | null;
  employeeId?: string | null;
  usageLocation?: string | null;
  skuIds: string[];
  /** The manager's object id; null = none. */
  managerId?: string | null;
}

export interface DirectoryGroupState {
  id: string;
  displayName: string;
  description?: string | null;
  groupTypes: string[];
  membershipRule?: string | null;
  memberIds: string[];
  ownerIds: string[];
  licences: Array<{ skuId: string; disabledPlans: string[] }>;
}

export interface DirectoryState {
  users: Partial<Record<DirectoryUserKey, DirectoryUserState>>;
  /** AF-Test-User-01..03 (base write-test targets) by lower-case UPN → object id. */
  targets: Record<string, string | undefined>;
  /** AF-Test-Group-01's id (nested into AF-Test-Nested-01) — only when it is the group the test identities created. */
  testGroupId?: string;
  /** Base targets (lower-case UPN) and AF-Test-Group-01 found at their names but not provisioning's: never used. */
  foreignTargets?: string[];
  testGroupForeign?: boolean;
  /** Users with the guest's address (normally none or one). */
  guests: Array<{
    id: string;
    displayName?: string;
    mail?: string | null;
    employeeType?: string | null;
    userType?: string | null;
  }>;
  /** Groups with each catalogue display name. */
  groups: Partial<Record<DirectoryGroupKey, DirectoryGroupState[]>>;
  /**
   * Whether the tenant allows guest invitations (`authorizationPolicy.allowInvitesFrom` isn't "none"); undefined when
   * it couldn't be read. A tenant-wide setting provisioning never changes.
   */
  invitesAllowed?: boolean;
  /** Administrative units with the catalogue's display name. */
  aus: Array<{ id: string; displayName: string; description?: string | null; memberIds: string[] }>;
  /** AF_TEST_LICENCE_SKU: its id, free seats and service plan ids by name; null = not a subscription; absent = not set. */
  licence?:
    | { skuId: string; partNumber: string; free: number; seats: string; planIds: Record<string, string> }
    | null
    | Unreadable;
}

export type DirectoryStep =
  | {
      op: 'user';
      key: DirectoryUserKey;
      create: boolean;
      /** Attributes to set (null = clear), `accountEnabled`, `passwordPolicies`. */
      patch: Record<string, unknown>;
      manager?: DirectoryUserKey;
      licenceSkuId?: string;
    }
  | { op: 'guest' }
  | {
      op: 'group';
      key: DirectoryGroupKey;
      create: boolean;
      patch?: Record<string, unknown>;
      addMembers: MemberRef[];
      removeMemberIds: string[];
      addOwners: DirectoryUserKey[];
      licence?: { skuId: string; disabledPlanIds: string[] };
    }
  | { op: 'au'; create: boolean; addMembers: MemberRef[] }
  | { op: 'delete'; what: 'user' | 'guest' | 'group' | 'au'; id: string };

// Each operation resolves what it needs and fails on its own: one refusal doesn't stop the others.
const base = { fixture: 'directory', section: DIRECTORY_SECTION, independent: true } as const;
const FOREIGN = 'not created by provisioning (no marker) — left alone';

const blocked = (title: string, why: string): FixtureOp => ({
  ...base,
  kind: 'note',
  action: 'skip',
  blocked: true,
  title,
  changes: [why],
});

const step = (
  action: FixtureOp['action'],
  title: string,
  s: DirectoryStep,
  changes?: string[],
): FixtureOp => ({
  ...base,
  kind: 'directory',
  action,
  title,
  step: s,
  ...(changes?.length ? { changes } : {}),
});

/** Whether a user is the directory fixture's own: its catalogue display name and the marker. */
export const isDirectoryUser = (
  spec: DirectoryUserSpec,
  u: Pick<DirectoryUserState, 'displayName' | 'employeeType'>,
) => u.employeeType === DIRECTORY_MARKER && u.displayName === spec.displayName;

/** Whether a group or administrative unit is provisioning's: the marker in its description. */
export const hasMarker = (o: { description?: string | null }) =>
  (o.description ?? '').includes(TESTER_MARKER);

const userTitle = (u: DirectoryUserSpec) => `${u.displayName} (user)`;
const groupTitle = (g: DirectoryGroupSpec) => `${g.displayName} (${g.kind})`;
const GUEST_TITLE = (name: string) => `${name} (guest, invitation never redeemed — none is sent)`;
const AU_TITLE = (name: string) => `${name} (administrative unit, every AF-Test user)`;

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '') === (b ?? '');

/** Pure: what differs between a user and its catalogue entry (attributes, sign-in, password expiry). */
export function userPatch(
  spec: DirectoryUserSpec,
  u: DirectoryUserState | undefined,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const a of PROFILE_ATTRIBUTES) {
    const want = spec.attributes[a];
    if (!same(u?.[a], want)) patch[a] = want ?? null;
  }
  if (!u || (u.accountEnabled ?? true) !== spec.accountEnabled) patch.accountEnabled = spec.accountEnabled;
  const neverExpires = (u?.passwordPolicies ?? '').includes('DisablePasswordExpiration');
  if (!!spec.passwordNeverExpires !== neverExpires)
    patch.passwordPolicies = spec.passwordNeverExpires ? 'DisablePasswordExpiration' : 'None';
  return patch;
}

const describePatch = (patch: Record<string, unknown>) =>
  Object.entries(patch).map(([k, v]) =>
    k === 'accountEnabled'
      ? v
        ? 'enable sign-in'
        : 'disable sign-in'
      : k === 'passwordPolicies'
        ? v === 'None'
          ? 'password expires'
          : 'password never expires'
        : v === null
          ? `clear ${k}`
          : `${k} → ${String(v)}`,
  );

/** The object id a member reference names in the read state (undefined: doesn't exist yet). */
function memberId(s: DirectoryState, ref: MemberRef): string | undefined {
  if ('user' in ref) return s.users[ref.user]?.id;
  if ('target' in ref) return s.targets[ref.target.toLowerCase()];
  return s.testGroupId;
}

const refName = (d: DesiredFixtures, ref: MemberRef) =>
  'user' in ref
    ? `AF-Test-User-${ref.user}`
    : 'target' in ref
      ? (d.licensed.find((u) => u.upn.toLowerCase() === ref.target.toLowerCase())?.displayName ?? ref.target)
      : d.testGroup.displayName;

/** Whether a member reference names a base target or AF-Test-Group-01 that isn't provisioning's. */
const foreignRef = (s: DirectoryState, ref: MemberRef) =>
  'target' in ref
    ? (s.foreignTargets ?? []).includes(ref.target.toLowerCase())
    : 'testGroup' in ref
      ? !!s.testGroupForeign
      : false;

/** Every AF-Test user (base targets and the catalogue's), the administrative unit's members. */
const allTestUsers = (d: DesiredFixtures): MemberRef[] => [
  ...d.licensed.filter((u) => /^af-test-user-/i.test(u.upn)).map((u) => ({ target: u.upn })),
  ...d.directory.users.map((u) => ({ user: u.key })),
];

/** Pure: the directory fixture's operations (`provision test-identities`, `provision status`). */
export function planDirectory(
  d: DesiredFixtures,
  s: DirectoryState | Unreadable | undefined,
  remove: boolean,
): FixtureOp[] {
  const cat = d.directory;
  if (isUnreadable(s)) return [blocked('AF-Test users, guest, groups and administrative unit', s.unreadable)];
  if (!s) return [];
  if (remove) return planRemoval(d, s);
  const ops: FixtureOp[] = [];

  // Licences: planned only when the subscription has the seats for all of them.
  const licence = s.licence;
  let skuId: string | undefined;
  if (d.settings.licenceSku) {
    const title = `${d.settings.licenceSku} for the directory fixture (${directorySeats(cat)} seats)`;
    if (isUnreadable(licence)) ops.push(blocked(title, licence.unreadable));
    else if (!licence)
      ops.push(blocked(title, 'not a subscription of this tenant — check AF_TEST_LICENCE_SKU'));
    else {
      const needed =
        cat.users.filter((u) => u.directLicence && !s.users[u.key]?.skuIds.includes(licence.skuId)).length +
        cat.groups
          .filter(
            (g) =>
              g.licence &&
              !(s.groups[g.key] ?? []).some((x) => x.licences.some((l) => l.skuId === licence.skuId)),
          )
          .reduce((n, g) => n + g.members.length, 0);
      if (needed > licence.free)
        ops.push(blocked(title, `no free seat: ${licence.seats}, ${needed} needed — add seats or free some`));
      else {
        skuId = licence.skuId;
        ops.push({ ...base, kind: 'note', action: 'noop', title: `${licence.partNumber}: ${licence.seats}` });
      }
    }
  } else
    ops.push({
      ...base,
      kind: 'note',
      action: 'skip',
      title: 'Licences of the directory fixture (one direct, two through AF-Test-Licence-01)',
      changes: [
        'AF_TEST_LICENCE_SKU is not set — the users and the licence group are created without licences',
      ],
    });

  for (const spec of cat.users) {
    const u = s.users[spec.key];
    if (u && !isDirectoryUser(spec, u)) {
      ops.push(blocked(userTitle(spec), FOREIGN));
      continue;
    }
    const patch = userPatch(spec, u);
    const managerId = spec.managerKey ? s.users[spec.managerKey]?.id : undefined;
    const managerDiffers = !!spec.managerKey && (!u || !managerId || u.managerId !== managerId);
    const wantsLicence = spec.directLicence && skuId && !u?.skuIds.includes(skuId);
    const changes = [
      ...(u
        ? describePatch(patch)
        : [
            ...(spec.accountEnabled ? [] : ['created disabled']),
            ...(spec.passwordNeverExpires ? ['password never expires'] : []),
          ]),
      ...(managerDiffers ? [`manager → AF-Test-User-${spec.managerKey}`] : []),
      ...(wantsLicence ? [`licence ${d.settings.licenceSku} (direct)`] : []),
    ];
    if (u && !changes.length) {
      ops.push({ ...base, kind: 'note', action: 'noop', title: userTitle(spec) });
      continue;
    }
    ops.push(
      step(
        u ? 'update' : 'create',
        userTitle(spec),
        {
          op: 'user',
          key: spec.key,
          create: !u,
          patch,
          ...(managerDiffers ? { manager: spec.managerKey } : {}),
          ...(wantsLicence ? { licenceSkuId: skuId } : {}),
        },
        u ? changes : [...changes, 'random password, not stored'],
      ),
    );
  }

  // Groups.
  for (const g of cat.groups) {
    const found = s.groups[g.key] ?? [];
    const ours = found.filter(hasMarker);
    if (found.length && !ours.length) {
      ops.push(
        blocked(
          groupTitle(g),
          `a group with this name exists without the "${TESTER_MARKER}" marker — ${FOREIGN}`,
        ),
      );
      continue;
    }
    if (ours.length > 1) {
      ops.push(
        blocked(
          groupTitle(g),
          `${ours.length} groups with this name carry the marker — delete the extra ones`,
        ),
      );
      continue;
    }
    const have = ours[0];
    const present = new Set(have?.memberIds ?? []);
    for (const ref of g.members.filter((r) => foreignRef(s, r)))
      ops.push(blocked(`${groupTitle(g)}: member ${refName(d, ref)}`, `${FOREIGN} — not added`));
    const addMembers = g.members.filter((ref) => {
      if (foreignRef(s, ref)) return false;
      const id = memberId(s, ref);
      return !id || !present.has(id);
    });
    const wanted = new Set(g.members.map((ref) => memberId(s, ref)).filter(Boolean));
    const removeMemberIds = g.exactMembers && have ? have.memberIds.filter((id) => !wanted.has(id)) : [];
    const owners = new Set(have?.ownerIds ?? []);
    const addOwners = g.owners.filter((k) => {
      const id = s.users[k]?.id;
      return !id || !owners.has(id);
    });
    const patch =
      have && g.key === 'dynamic' && (have.membershipRule ?? '') !== DYNAMIC_RULE
        ? { membershipRule: DYNAMIC_RULE, membershipRuleProcessingState: 'On' }
        : undefined;
    let groupLicence: { skuId: string; disabledPlanIds: string[] } | undefined;
    if (g.licence && skuId && !isUnreadable(licence) && licence) {
      const planId = licence.planIds[g.licence.disabledPlan];
      const disabledPlanIds = planId ? [planId] : [];
      const assigned = have?.licences.find((l) => l.skuId === skuId);
      const sameDisabled =
        assigned &&
        assigned.disabledPlans.length === disabledPlanIds.length &&
        disabledPlanIds.every((p) => assigned.disabledPlans.includes(p));
      if (!sameDisabled) groupLicence = { skuId, disabledPlanIds };
    }
    const changes = [
      ...(patch ? ['membership rule → the test department'] : []),
      ...addMembers.map((ref) => `+ member ${refName(d, ref)}`),
      ...(removeMemberIds.length ? [`− ${removeMemberIds.length} member(s) (it stays empty)`] : []),
      ...addOwners.map((k) => `+ owner AF-Test-User-${k}`),
      ...(groupLicence
        ? [
            `licence ${d.settings.licenceSku}${groupLicence.disabledPlanIds.length ? ` without ${g.licence!.disabledPlan}` : ''} for its members`,
          ]
        : []),
    ];
    if (have && !changes.length) {
      ops.push({ ...base, kind: 'note', action: 'noop', title: groupTitle(g) });
      continue;
    }
    ops.push(
      step(
        have ? 'update' : 'create',
        groupTitle(g),
        {
          op: 'group',
          key: g.key,
          create: !have,
          ...(patch ? { patch } : {}),
          addMembers,
          removeMemberIds,
          addOwners,
          ...(groupLicence ? { licence: groupLicence } : {}),
        },
        changes,
      ),
    );
  }

  // The administrative unit.
  const auTitle = AU_TITLE(cat.au.displayName);
  const aus = s.aus.filter((a) => a.displayName === cat.au.displayName);
  const ourAus = aus.filter(hasMarker);
  if (aus.length && !ourAus.length) ops.push(blocked(auTitle, FOREIGN));
  else if (ourAus.length > 1)
    ops.push(blocked(auTitle, `${ourAus.length} administrative units with this name carry the marker`));
  else {
    const have = ourAus[0];
    const present = new Set(have?.memberIds ?? []);
    for (const ref of allTestUsers(d).filter((r) => foreignRef(s, r)))
      ops.push(blocked(`${auTitle}: member ${refName(d, ref)}`, `${FOREIGN} — not added`));
    const addMembers = allTestUsers(d).filter((ref) => {
      if (foreignRef(s, ref)) return false;
      const id = memberId(s, ref);
      return !id || !present.has(id);
    });
    if (have && !addMembers.length) ops.push({ ...base, kind: 'note', action: 'noop', title: auTitle });
    else
      ops.push(
        step(have ? 'update' : 'create', auTitle, { op: 'au', create: !have, addMembers }, [
          `+ ${addMembers.length} member(s)`,
          ...(have
            ? []
            : ['no role is scoped to it (an option for the validation user’s User Administrator role)']),
        ]),
      );
  }
  return ops;
}

/** `--remove-fixtures`: the administrative unit, groups, guest and users that carry the marker. */
function planRemoval(d: DesiredFixtures, s: DirectoryState): FixtureOp[] {
  const cat = d.directory;
  const ops: FixtureOp[] = [];
  const del = (title: string, what: 'user' | 'guest' | 'group' | 'au', id: string) =>
    ops.push(step('delete', title, { op: 'delete', what, id }));
  for (const a of s.aus)
    if (a.displayName === cat.au.displayName && hasMarker(a)) del(AU_TITLE(a.displayName), 'au', a.id);
  for (const g of cat.groups)
    for (const x of (s.groups[g.key] ?? []).filter(hasMarker)) del(groupTitle(g), 'group', x.id);
  for (const spec of cat.users) {
    const u = s.users[spec.key];
    if (u && isDirectoryUser(spec, u)) del(userTitle(spec), 'user', u.id);
  }
  return ops;
}

export const GUEST_SECTION = 'Test fixtures: guest';
const guestBase = { fixture: 'guest', section: GUEST_SECTION } as const;
const guestBlocked = (title: string, why: string): FixtureOp => ({
  ...guestBase,
  kind: 'note',
  action: 'skip',
  blocked: true,
  title,
  changes: [why],
});
const guestStep = (
  action: FixtureOp['action'],
  title: string,
  s: DirectoryStep,
  changes?: string[],
): FixtureOp => ({
  ...guestBase,
  kind: 'directory',
  action,
  title,
  step: s,
  ...(changes?.length ? { changes } : {}),
});

/**
 * Pure: the `guest` fixture — AF-Test-Guest-01, invited without an email to an example.com address, so it stays
 * "never redeemed". Its own opt-in: Microsoft refuses guest invitations in some tenants (new ones especially) even
 * where the external collaboration settings allow them, and the rest of the directory fixture doesn't depend on it.
 */
export function planGuest(
  d: DesiredFixtures,
  s: DirectoryState | Unreadable | undefined,
  remove: boolean,
): FixtureOp[] {
  const cat = d.directory;
  const guestTitle = GUEST_TITLE(cat.guest.displayName);
  if (isUnreadable(s)) return [guestBlocked(guestTitle, s.unreadable)];
  if (!s) return [];
  if (remove)
    return s.guests
      .filter(
        (g) =>
          g.displayName === cat.guest.displayName &&
          (g.mail ?? '').toLowerCase() === cat.guest.email.toLowerCase() &&
          g.employeeType === DIRECTORY_MARKER,
      )
      .map((g) => guestStep('delete', guestTitle, { op: 'delete', what: 'guest', id: g.id }));
  const ops: FixtureOp[] = [];
  const guests = s.guests.filter((g) => (g.mail ?? '').toLowerCase() === cat.guest.email.toLowerCase());
  const marked = guests.filter(
    (g) => g.employeeType === DIRECTORY_MARKER && g.displayName === cat.guest.displayName,
  );
  if (guests.length > 1)
    ops.push(guestBlocked(guestTitle, `${guests.length} accounts have this address — left alone`));
  else if (marked.length) ops.push({ ...guestBase, kind: 'note', action: 'noop', title: guestTitle });
  else if (guests.length) ops.push(guestBlocked(guestTitle, FOREIGN));
  else if (s.invitesAllowed === false)
    ops.push({
      ...guestBase,
      kind: 'note',
      action: 'skip',
      title: guestTitle,
      changes: [
        "the tenant doesn't allow guest invitations (External collaboration settings) — no guest; that tenant-wide setting is the owner's to change",
      ],
    });
  else
    ops.push(
      guestStep('create', guestTitle, { op: 'guest' }, [
        'invited without an email (sendInvitationMessage: false), marked at once (deleted again if it can’t be)',
      ]),
    );

  return ops;
}
