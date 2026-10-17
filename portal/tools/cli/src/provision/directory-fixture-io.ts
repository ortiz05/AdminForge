/**
 * Microsoft Graph I/O for the `directory` test fixture (provision/directory-fixture-plan.ts decides), as the
 * provisioner identity: reads the catalogue's users (attributes, licences, manager), the guest, the groups (members,
 * owners, licences), the administrative unit and the licence SKU; applies one operation (`applyDirectoryStep`).
 * Passwords are random and never stored or printed; the guest's invitation is never sent. Only objects carrying
 * provisioning's marker are changed or deleted (the plan refuses the rest).
 */
import { ApiError, type GraphClient } from '@adminforge/connectors';
import { DIRECTORY_MARKER, type DirectoryUserKey, type MemberRef } from './directory-fixture-catalog';
import {
  hasMarker,
  isDirectoryUser,
  type DirectoryGroupState,
  type DirectoryState,
  type DirectoryStep,
} from './directory-fixture-plan';
import { findGroup, odata } from './entra-io';
import { isProvisionedAccount, isProvisionedTestGroup, type DesiredFixtures } from './fixtures-model';
import { generatePassword } from './password';

const USER_SELECT =
  'id,userPrincipalName,displayName,employeeType,accountEnabled,passwordPolicies,givenName,surname,department,jobTitle,employeeId,usageLocation,assignedLicenses';
const GRAPH = 'https://graph.microsoft.com/v1.0';

const isMissing = (err: unknown) => err instanceof ApiError && err.status === 404;
const isAlreadyExists = (err: unknown) =>
  err instanceof ApiError &&
  (err.status === 409 ||
    /already exist|conflicting object|same value for property/i.test(`${err.code} ${err.message}`));
const notVisible = (what: string) =>
  new ApiError(404, 'Request_ResourceNotFound', `${what} is not visible yet (directory replication)`);

async function readUser(graph: GraphClient, upn: string) {
  try {
    const { data } = await graph.request<
      Omit<DirectoryState['users'][DirectoryUserKey], 'skuIds'> & {
        assignedLicenses?: Array<{ skuId: string }>;
      }
    >({ path: `/users/${encodeURIComponent(upn)}`, query: { $select: USER_SELECT } });
    const { assignedLicenses, ...rest } = data as typeof data & {
      assignedLicenses?: Array<{ skuId: string }>;
    };
    return { ...rest, skuIds: (assignedLicenses ?? []).map((l) => l.skuId.toLowerCase()) } as NonNullable<
      DirectoryState['users'][DirectoryUserKey]
    >;
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

async function managerOf(graph: GraphClient, id: string): Promise<string | null> {
  try {
    return (await graph.request<{ id: string }>({ path: `/users/${id}/manager`, query: { $select: 'id' } }))
      .data.id;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

const ids = async (graph: GraphClient, path: string) =>
  (await graph.all<{ id: string }>({ path, query: { $select: 'id' } })).map((m) => m.id);

/**
 * A group's owners, service principals included: Graph's plain `/owners` list can leave out a service principal owner
 * (seen live: the provisioner on the Microsoft 365 groups it created) that `$expand=owners` and the
 * `/owners/microsoft.graph.servicePrincipal` cast do return — so both lists, merged.
 */
async function groupOwnerIds(graph: GraphClient, groupId: string): Promise<string[]> {
  const all = await ids(graph, `/groups/${groupId}/owners`);
  const apps = await ids(graph, `/groups/${groupId}/owners/microsoft.graph.servicePrincipal`);
  return [...new Set([...all, ...apps])];
}

/** Reads what the directory fixture compares against. Read-only. */
export async function readDirectoryState(
  graph: GraphClient,
  desired: DesiredFixtures,
  /** AF_PROVISIONER_CLIENT_ID: Graph makes the provisioner an owner of the Microsoft 365 groups it creates. */
  provisionerAppId?: string,
): Promise<DirectoryState> {
  const cat = desired.directory;
  const state: DirectoryState = { users: {}, targets: {}, guests: [], groups: {}, aus: [] };
  for (const spec of cat.users) {
    const u = await readUser(graph, spec.upn);
    // Someone else's account at the UPN is reported by the plan, never read further.
    if (u && isDirectoryUser(spec, u)) u.managerId = await managerOf(graph, u.id);
    state.users[spec.key] = u;
  }
  // The base targets and AF-Test-Group-01 are used only when they are the test identities' own.
  state.foreignTargets = [];
  for (const t of desired.licensed.filter((u) => /^af-test-user-/i.test(u.upn))) {
    const u = await readUser(graph, t.upn);
    if (u && !isProvisionedAccount(t, u)) state.foreignTargets.push(t.upn.toLowerCase());
    else state.targets[t.upn.toLowerCase()] = u?.id;
  }
  const group = await findGroup(graph, desired.testGroup.uniqueName);
  if (group && !isProvisionedTestGroup(desired, group)) state.testGroupForeign = true;
  else state.testGroupId = group?.id;
  if (provisionerAppId) state.provisionerSpId = await servicePrincipalId(graph, provisionerAppId);
  state.guests = await graph.all({
    path: '/users',
    query: {
      $filter: `mail eq ${odata(cat.guest.email)}`,
      $select: 'id,displayName,mail,employeeType,userType',
    },
  });
  state.invitesAllowed = await graph
    .request<{ allowInvitesFrom?: string }>({
      path: '/policies/authorizationPolicy',
      query: { $select: 'allowInvitesFrom' },
    })
    .then(
      (r) => (r.data.allowInvitesFrom ? r.data.allowInvitesFrom !== 'none' : undefined),
      () => undefined,
    );
  for (const g of cat.groups) {
    const found = await graph.all<
      Omit<DirectoryGroupState, 'memberIds' | 'ownerIds' | 'licences'> & {
        assignedLicenses?: Array<{ skuId: string; disabledPlans?: string[] }>;
      }
    >({
      path: '/groups',
      query: {
        $filter: `displayName eq ${odata(g.displayName)}`,
        $select: 'id,displayName,description,groupTypes,membershipRule,assignedLicenses',
      },
    });
    state.groups[g.key] = [];
    for (const x of found)
      state.groups[g.key]!.push({
        id: x.id,
        displayName: x.displayName,
        description: x.description ?? null,
        groupTypes: x.groupTypes ?? [],
        membershipRule: x.membershipRule ?? null,
        memberIds: await ids(graph, `/groups/${x.id}/members`),
        ownerIds: await groupOwnerIds(graph, x.id),
        licences: (x.assignedLicenses ?? []).map((l) => ({
          skuId: l.skuId.toLowerCase(),
          disabledPlans: (l.disabledPlans ?? []).map((p) => p.toLowerCase()),
        })),
      });
  }
  const aus = await graph.all<{ id: string; displayName: string; description?: string | null }>({
    path: '/directory/administrativeUnits',
    query: { $filter: `displayName eq ${odata(cat.au.displayName)}`, $select: 'id,displayName,description' },
  });
  for (const a of aus)
    state.aus.push({ ...a, memberIds: await ids(graph, `/directory/administrativeUnits/${a.id}/members`) });
  if (desired.settings.licenceSku) state.licence = await readLicence(graph, desired.settings.licenceSku);
  return state;
}

async function readLicence(graph: GraphClient, partNumber: string): Promise<DirectoryState['licence']> {
  const { data } = await graph.request<{
    value?: Array<{
      skuId: string;
      skuPartNumber: string;
      consumedUnits?: number;
      prepaidUnits?: { enabled?: number };
      servicePlans?: Array<{ servicePlanId: string; servicePlanName: string }>;
    }>;
  }>({
    path: '/subscribedSkus',
    query: { $select: 'skuId,skuPartNumber,consumedUnits,prepaidUnits,servicePlans' },
  });
  const sku = (data.value ?? []).find((s) => s.skuPartNumber === partNumber);
  if (!sku) return null;
  const consumed = sku.consumedUnits ?? 0;
  const enabled = sku.prepaidUnits?.enabled ?? 0;
  return {
    skuId: sku.skuId.toLowerCase(),
    partNumber: sku.skuPartNumber,
    free: Math.max(0, enabled - consumed),
    seats: `${consumed} of ${enabled} seats used`,
    planIds: Object.fromEntries(
      (sku.servicePlans ?? []).map((p) => [p.servicePlanName, p.servicePlanId.toLowerCase()]),
    ),
  };
}

/** The service principal id of an app (the provisioner), or undefined. Read-only. */
export async function servicePrincipalId(graph: GraphClient, appId: string): Promise<string | undefined> {
  const { data } = await graph.request<{ value?: Array<{ id: string }> }>({
    path: '/servicePrincipals',
    query: { $filter: `appId eq ${odata(appId)}`, $select: 'id' },
  });
  return data.value?.[0]?.id;
}

export interface DirectoryApplyContext {
  graph: GraphClient;
  log: (line: string) => void;
  /** AF_PROVISIONER_CLIENT_ID (the Microsoft 365 groups' app owner). */
  provisionerAppId?: string;
  /** AF-Test-Group-01's id, refused unless it is the group the test identities created. */
  testGroupId: () => Promise<string>;
  /** Replication retry around calls on a just-created object. */
  retry: <T>(fn: () => Promise<T>) => Promise<T>;
  password?: () => string;
}

/** Applies one directory operation. Throws ApiError on a Graph refusal (the caller prints ✗ and goes on). */
export async function applyDirectoryStep(
  step: DirectoryStep,
  title: string,
  desired: DesiredFixtures,
  ctx: DirectoryApplyContext,
): Promise<void> {
  const { graph, log, retry } = ctx;
  const cat = desired.directory;
  const spec = (key: DirectoryUserKey) => cat.users.find((u) => u.key === key)!;
  /** A catalogue user that carries the marker (it may have been created a moment ago in this run). */
  const ownUser = async (key: DirectoryUserKey) => {
    const s = spec(key);
    const u = await retry(
      async () => (await readUser(graph, s.upn)) ?? Promise.reject(notVisible(s.displayName)),
    );
    if (!isDirectoryUser(s, u))
      throw new ApiError(
        409,
        'NotProvisioned',
        `${s.displayName} was not created by provisioning; left alone`,
      );
    return u;
  };
  const refId = async (ref: MemberRef) => {
    if ('user' in ref) return (await ownUser(ref.user)).id;
    if ('target' in ref) {
      const spec = desired.licensed.find((u) => u.upn.toLowerCase() === ref.target.toLowerCase())!;
      const u = await retry(
        async () => (await readUser(graph, ref.target)) ?? Promise.reject(notVisible(ref.target)),
      );
      if (!isProvisionedAccount(spec, u))
        throw new ApiError(
          409,
          'NotProvisioned',
          `${spec.displayName} is not provisioning's account; left alone`,
        );
      return u.id;
    }
    return ctx.testGroupId();
  };
  const addRef = (path: string, id: string) =>
    retry(async () => {
      try {
        await graph.request({
          method: 'POST',
          path,
          body: { '@odata.id': `${GRAPH}/directoryObjects/${id}` },
        });
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
      }
    });
  const ownGroup = (displayName: string) =>
    retry(async () => {
      const found = await graph.all<{ id: string; description?: string | null }>({
        path: '/groups',
        query: { $filter: `displayName eq ${odata(displayName)}`, $select: 'id,description' },
      });
      const ours = found.filter(hasMarker);
      if (ours.length === 1) return ours[0]!.id;
      if (ours.length > 1)
        throw new ApiError(409, 'Ambiguous', `${ours.length} groups named ${displayName} carry the marker`);
      return Promise.reject(notVisible(displayName));
    });

  switch (step.op) {
    case 'user': {
      const s = spec(step.key);
      let id: string;
      if (step.create) {
        const body: Record<string, unknown> = {
          accountEnabled: s.accountEnabled,
          displayName: s.displayName,
          mailNickname: s.mailNickname,
          userPrincipalName: s.upn,
          // Random and deliberately not stored: nobody signs in as these accounts.
          passwordProfile: {
            password: (ctx.password ?? (() => generatePassword()))(),
            forceChangePasswordNextSignIn: false,
          },
          employeeType: DIRECTORY_MARKER,
          ...(s.passwordNeverExpires ? { passwordPolicies: 'DisablePasswordExpiration' } : {}),
          ...s.attributes,
        };
        try {
          id = (await graph.request<{ id: string }>({ method: 'POST', path: '/users', body })).data.id;
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
          id = (await ownUser(step.key)).id;
        }
      } else {
        id = (await ownUser(step.key)).id;
        if (Object.keys(step.patch).length)
          await retry(() => graph.request({ method: 'PATCH', path: `/users/${id}`, body: step.patch }));
      }
      if (step.manager) {
        const managerId = (await ownUser(step.manager)).id;
        await retry(() =>
          graph.request({
            method: 'PUT',
            path: `/users/${id}/manager/$ref`,
            body: { '@odata.id': `${GRAPH}/users/${managerId}` },
          }),
        );
      }
      if (step.licenceSkuId) {
        const skuId = step.licenceSkuId;
        await retry(() =>
          graph.request({
            method: 'POST',
            path: `/users/${id}/assignLicense`,
            body: { addLicenses: [{ skuId, disabledPlans: [] }], removeLicenses: [] },
          }),
        );
      }
      log(`  ✓ ${step.create ? 'created' : 'updated'}: ${title}`);
      return;
    }
    case 'guest': {
      // No email is sent, and example.com can't receive one: the invitation stays unredeemed.
      const { data } = await graph.request<{ invitedUser?: { id: string } }>({
        method: 'POST',
        path: '/invitations',
        body: {
          invitedUserEmailAddress: cat.guest.email,
          invitedUserDisplayName: cat.guest.displayName,
          inviteRedirectUrl: 'https://myapplications.microsoft.com',
          sendInvitationMessage: false,
        },
      });
      const guestId = data.invitedUser?.id;
      if (!guestId)
        throw new ApiError(502, 'NoInvitedUser', 'the invitation answered without the invited user');
      // Marked at once; a guest that can't be marked is deleted again, so no unmarked fixture guest is left behind.
      try {
        await retry(() =>
          graph.request({
            method: 'PATCH',
            path: `/users/${guestId}`,
            body: { employeeType: DIRECTORY_MARKER },
          }),
        );
      } catch (err) {
        await graph.request({ method: 'DELETE', path: `/users/${guestId}` }).catch(() => undefined);
        throw err;
      }
      log(`  ✓ invited (no email): ${title}`);
      return;
    }
    case 'group': {
      const g = cat.groups.find((x) => x.key === step.key)!;
      let id: string;
      if (step.create)
        id = (await graph.request<{ id: string }>({ method: 'POST', path: '/groups', body: g.body })).data.id;
      else id = await ownGroup(g.displayName);
      const groupId = id;
      if (step.patch) {
        const patch = step.patch;
        await retry(() => graph.request({ method: 'PATCH', path: `/groups/${groupId}`, body: patch }));
      }
      for (const ref of step.addMembers) await addRef(`/groups/${groupId}/members/$ref`, await refId(ref));
      for (const memberId of step.removeMemberIds)
        try {
          await graph.request({ method: 'DELETE', path: `/groups/${groupId}/members/${memberId}/$ref` });
        } catch (err) {
          if (!isMissing(err)) throw err;
        }
      for (const k of step.addOwners) {
        const ownerId = (await ownUser(k)).id;
        await retry(async () => {
          try {
            await graph.request({
              method: 'POST',
              path: `/groups/${groupId}/owners/$ref`,
              body: { '@odata.id': `${GRAPH}/users/${ownerId}` },
            });
          } catch (err) {
            if (!isAlreadyExists(err)) throw err;
          }
        });
      }
      if (step.provisionerOwner) {
        const spId = ctx.provisionerAppId && (await servicePrincipalId(graph, ctx.provisionerAppId));
        // Without a service principal the provisioner can't be an owner: nothing to remove, but nothing to add either.
        if (!spId && step.provisionerOwner === 'add')
          throw new ApiError(
            409,
            'NoProvisioner',
            "the provisioner's service principal couldn't be found (AF_PROVISIONER_CLIENT_ID)",
          );
        if (spId && step.provisionerOwner === 'add')
          await retry(async () => {
            try {
              await graph.request({
                method: 'POST',
                path: `/groups/${groupId}/owners/$ref`,
                body: { '@odata.id': `${GRAPH}/servicePrincipals/${spId}` },
              });
            } catch (err) {
              if (!isAlreadyExists(err)) throw err;
            }
          });
        else if (spId)
          try {
            // Only the provisioner's own owner reference, only on this marked group. Retried while a just-created
            // group's owner isn't visible yet; still absent afterwards means it isn't an owner (nothing to remove).
            await retry(() =>
              graph.request({ method: 'DELETE', path: `/groups/${groupId}/owners/${spId}/$ref` }),
            );
          } catch (err) {
            if (!isMissing(err)) {
              if (
                err instanceof ApiError &&
                err.status === 400 &&
                /last owner|at least one owner/i.test(err.message)
              )
                throw new ApiError(
                  409,
                  'LastOwner',
                  'Graph refuses to remove the last owner of a Microsoft 365 group — it stays owned by the provisioner only',
                );
              throw err;
            }
          }
      }
      if (step.licence) {
        const { skuId, disabledPlanIds } = step.licence;
        const assign = () =>
          retry(() =>
            graph.request({
              method: 'POST',
              path: `/groups/${groupId}/assignLicense`,
              body: { addLicenses: [{ skuId, disabledPlans: disabledPlanIds }], removeLicenses: [] },
            }),
          );
        const shows = async () =>
          (
            await graph.request<{ assignedLicenses?: Array<{ skuId: string }> }>({
              path: `/groups/${groupId}`,
              query: { $select: 'assignedLicenses' },
            })
          ).data.assignedLicenses?.some((l) => l.skuId.toLowerCase() === skuId);
        // Graph can answer 200 for a group created a moment ago and drop the licence: read it back, assign once more.
        await assign();
        let shown = false;
        for (let round = 0; round < 2 && !shown; round++) {
          if (round) await assign();
          shown = await retry(
            async () => (await shows()) || Promise.reject(notVisible(`the licence of ${g.displayName}`)),
          ).then(
            () => true,
            () => false,
          );
        }
        if (!shown)
          throw new ApiError(
            409,
            'NotApplied',
            'Graph accepted the group licence but does not show it — run provisioning again in a few minutes',
          );
      }
      log(`  ✓ ${step.create ? 'created' : 'updated'}: ${title}`);
      return;
    }
    case 'au': {
      let id: string;
      if (step.create)
        id = (
          await graph.request<{ id: string }>({
            method: 'POST',
            path: '/directory/administrativeUnits',
            body: { displayName: cat.au.displayName, description: cat.au.description },
          })
        ).data.id;
      else {
        const found = await graph.all<{ id: string; description?: string | null }>({
          path: '/directory/administrativeUnits',
          query: { $filter: `displayName eq ${odata(cat.au.displayName)}`, $select: 'id,description' },
        });
        const ours = found.filter(hasMarker);
        if (ours.length !== 1)
          throw new ApiError(409, 'NotProvisioned', 'the administrative unit is not provisioning’s');
        id = ours[0]!.id;
      }
      const auId = id;
      for (const ref of step.addMembers)
        await addRef(`/directory/administrativeUnits/${auId}/members/$ref`, await refId(ref));
      log(`  ✓ ${step.create ? 'created' : 'updated'}: ${title}`);
      return;
    }
    case 'delete': {
      const path =
        step.what === 'au'
          ? `/directory/administrativeUnits/${step.id}`
          : step.what === 'group'
            ? `/groups/${step.id}`
            : `/users/${step.id}`;
      try {
        await graph.request({ method: 'DELETE', path });
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
      log(`  ✓ removed: ${title}`);
      return;
    }
  }
}
