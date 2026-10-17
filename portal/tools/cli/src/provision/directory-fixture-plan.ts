/**
 * The `directory` test fixture's plan (pure): the catalogue (provision/directory-fixture-catalog.ts) against what the
 * tenant has → one operation per user, each guest, each group and the administrative unit (create, update with what
 * differs, or nothing), or the removal plan. Graph I/O: provision/directory-fixture-io.ts.
 *
 * Ownership: a user or a guest is provisioning's when it carries DIRECTORY_MARKER in `employeeType` (and has its
 * catalogue display name); a group or the administrative unit when its description carries the marker. Anything else
 * with the same UPN, address or name is refused (blocked) and never changed or removed — guests too (a directly created
 * guest carries the marker from the start; an invited one is marked at once or deleted again). AF-Test-User-01..03 and AF-Test-Group-01 are
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
  type DirectoryGuestSpec,
  type DirectoryUserKey,
  type DirectoryUserSpec,
  type MemberRef,
} from './directory-fixture-catalog';
import { isUnreadable, wants, type DesiredFixtures, type FixtureOp, type Unreadable } from './fixtures-model';
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
  /** The provisioner's service principal id (Graph makes it an owner of the Microsoft 365 groups it creates). */
  provisionerSpId?: string;
  /** Base targets (lower-case UPN) and AF-Test-Group-01 found at their names but not provisioning's: never used. */
  foreignTargets?: string[];
  testGroupForeign?: boolean;
  /** Users with a catalogue guest's address or UPN (normally none or one each). */
  guests: Array<{
    id: string;
    displayName?: string;
    mail?: string | null;
    userPrincipalName?: string | null;
    employeeType?: string | null;
    userType?: string | null;
    accountEnabled?: boolean | null;
    /** Sponsors (object ids) — read for provisioning's own guests only. */
    sponsorIds?: string[];
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
  | {
      op: 'guest';
      key: '01' | '02';
      create: boolean;
      /** Create: invite first (the tenant accepts invitations); a refused invitation falls back to a direct create. */
      invite?: boolean;
      /** `accountEnabled` to set on an existing guest. */
      patch?: Record<string, unknown>;
      /** The directory user to add as the guest's sponsor. */
      sponsor?: DirectoryUserKey;
    }
  | {
      op: 'group';
      key: DirectoryGroupKey;
      create: boolean;
      patch?: Record<string, unknown>;
      addMembers: MemberRef[];
      removeMemberIds: string[];
      addOwners: DirectoryUserKey[];
      /** The provisioner's own owner reference: removed (the no-owner group) or added (the person-and-app group). */
      provisionerOwner?: 'add' | 'remove';
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
const GUEST_TITLE = (g: DirectoryGuestSpec) =>
  `${g.displayName} (guest${g.accountEnabled ? '' : ', disabled'}, never signs in${g.sponsor ? `, sponsored by AF-Test-User-${g.sponsor}` : ''})`;
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
    // The provisioner as an owner: Graph adds it when the group is created with application permissions.
    const sp = s.provisionerSpId;
    const provisionerOwner =
      g.provisionerOwner === 'remove' && (!have || (sp && owners.has(sp)))
        ? ('remove' as const)
        : g.provisionerOwner === 'keep' && have && sp && !owners.has(sp)
          ? ('add' as const)
          : undefined;
    // Owners nobody asked for (not the catalogue's users, not the provisioner): a person's to remove.
    const allowed = new Set([...g.owners.map((k) => s.users[k]?.id), ...(g.provisionerOwner ? [sp] : [])]);
    const strangers = have ? have.ownerIds.filter((id) => !allowed.has(id)).length : 0;
    if (strangers && g.owners.length === 0) {
      ops.push(
        blocked(
          groupTitle(g),
          `has ${strangers} owner(s) provisioning didn't add — remove them to keep it ownerless`,
        ),
      );
      continue;
    }
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
      ...(provisionerOwner === 'remove'
        ? [`− owner: the provisioner${have ? '' : ' (Graph adds it on create)'}`]
        : provisionerOwner === 'add'
          ? ['+ owner: the provisioner (the app owner of a person-and-app owned group)']
          : []),
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
          ...(provisionerOwner ? { provisionerOwner } : {}),
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
// Each guest fails on its own, like the directory fixture's operations.
const guestBase = { fixture: 'guest', section: GUEST_SECTION, independent: true } as const;
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
 * Pure: the `guest` fixture — AF-Test-Guest-01 and -02. Its own opt-in, apart from `directory`. Guest-01 is invited
 * without an email where the tenant accepts invitations (a real "PendingAcceptance" guest); Microsoft refuses
 * invitations in some tenants (new ones especially) even where the external collaboration settings allow them, and
 * then — or where the settings don't allow them — it is created directly as a guest-type account with the UPN Entra
 * gives external users. Guest-02 (disabled) is always created directly. Neither ever signs in. A guest is
 * provisioning's when it carries DIRECTORY_MARKER and its catalogue name; anything else at its address or UPN is
 * refused and never changed or removed. The sponsor is added only when that user is the directory fixture's own.
 */
export function planGuest(
  d: DesiredFixtures,
  s: DirectoryState | Unreadable | undefined,
  remove: boolean,
): FixtureOp[] {
  const cat = d.directory;
  if (isUnreadable(s)) return cat.guests.map((g) => guestBlocked(GUEST_TITLE(g), s.unreadable));
  if (!s) return [];
  const at = (g: DirectoryGuestSpec) =>
    s.guests.filter(
      (x) =>
        (x.mail ?? '').toLowerCase() === g.email.toLowerCase() ||
        (x.userPrincipalName ?? '').toLowerCase() === g.upn.toLowerCase(),
    );
  const ours = (g: DirectoryGuestSpec, x: DirectoryState['guests'][number]) =>
    x.employeeType === DIRECTORY_MARKER && x.displayName === g.displayName;
  if (remove)
    return cat.guests.flatMap((g) =>
      at(g)
        .filter((x) => ours(g, x))
        .map((x) => guestStep('delete', GUEST_TITLE(g), { op: 'delete', what: 'guest', id: x.id })),
    );
  const ops: FixtureOp[] = [];
  for (const g of cat.guests) {
    const title = GUEST_TITLE(g);
    const found = at(g);
    const sponsorUser = g.sponsor ? s.users[g.sponsor] : undefined;
    const sponsorSpec = g.sponsor ? cat.users.find((u) => u.key === g.sponsor) : undefined;
    // Only the directory fixture's own user (marked) can be a sponsor — already there, or created earlier in this run
    // (the directory fixture is planned and applied before this one); otherwise no sponsor (said, not refused).
    const sponsorOwn = sponsorUser && sponsorSpec && isDirectoryUser(sponsorSpec, sponsorUser);
    const sponsorComing = !!g.sponsor && !sponsorUser && wants(d.settings, 'directory');
    const sponsorId = sponsorOwn ? sponsorUser.id : sponsorComing ? 'planned' : undefined;
    if (found.length > 1) {
      ops.push(guestBlocked(title, `${found.length} accounts have its address or UPN — left alone`));
      continue;
    }
    const x = found[0];
    if (x && !ours(g, x)) {
      ops.push(guestBlocked(title, FOREIGN));
      continue;
    }
    if (x) {
      const changes: string[] = [];
      const patch: Record<string, unknown> = {};
      if ((x.accountEnabled ?? true) !== g.accountEnabled) {
        patch.accountEnabled = g.accountEnabled;
        changes.push(`accountEnabled → ${g.accountEnabled}`);
      }
      const addSponsor = sponsorId && !(x.sponsorIds ?? []).includes(sponsorId);
      if (addSponsor) changes.push(`sponsor → AF-Test-User-${g.sponsor}`);
      if (!changes.length) {
        ops.push({ ...guestBase, kind: 'note', action: 'noop', title });
        continue;
      }
      ops.push(
        guestStep(
          'update',
          title,
          {
            op: 'guest',
            key: g.key,
            create: false,
            ...(Object.keys(patch).length ? { patch } : {}),
            ...(addSponsor ? { sponsor: g.sponsor } : {}),
          },
          changes,
        ),
      );
      continue;
    }
    const invite = g.invite && s.invitesAllowed !== false;
    ops.push(
      guestStep(
        'create',
        title,
        { op: 'guest', key: g.key, create: true, invite, ...(sponsorId ? { sponsor: g.sponsor } : {}) },
        [
          invite
            ? 'invited without an email (sendInvitationMessage: false); if Microsoft refuses the invitation, created directly as a guest-type account'
            : g.invite
              ? "created directly as a guest-type account (the tenant doesn't allow invitations — a tenant-wide setting provisioning never changes)"
              : 'created directly as a guest-type account',
          'marked at once (an invited guest that can’t be marked is deleted again)',
          ...(g.sponsor && !sponsorId
            ? [`no sponsor: AF-Test-User-${g.sponsor} isn't the directory fixture's (opt in \`directory\`)`]
            : []),
        ],
      ),
    );
  }
  return ops;
}
