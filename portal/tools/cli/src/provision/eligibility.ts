/**
 * PIM-eligible directory roles of the validation accounts, for `provision status`: an eligible role can be activated
 * with the account's stored password, so any eligibility provisioning didn't grant counts as unexpected privilege —
 * the same as an active role (provision/identities-plan.ts `unexpectedTesterRoles`). Provisioning grants eligibility
 * only through the `pim` fixture (provision/fixtures-model.ts FIXTURE_ROLES).
 *
 * `readEligibleRoles` is the Graph read (roleEligibilitySchedules; Entra ID P2): a part that can't be read is a
 * reason, not an error. `unexpectedEligibleRoles` is pure. Names only, never ids.
 */
import { ApiError, type GraphClient } from '@adminforge/connectors';
import { DIRECTORY_ROLES } from './catalog';
import { odata } from './entra-io';
import { FIXTURE_ROLES } from './fixtures-model';

export interface EligibleRole {
  roleDefinitionId: string;
  directoryScopeId: string;
  /** The role's display name, when it could be read. */
  name?: string;
}

const KNOWN = new Map<string, string>(
  [...Object.entries(DIRECTORY_ROLES), ...Object.entries(FIXTURE_ROLES)].map(([name, id]) => [id, name]),
);

/** Every role `principalId` is eligible for (any scope), with names; or why that can't be read. Read-only. */
export async function readEligibleRoles(
  graph: GraphClient,
  principalId: string,
): Promise<EligibleRole[] | { unreadable: string }> {
  let schedules: Array<{ roleDefinitionId: string; directoryScopeId?: string }>;
  try {
    schedules = await graph.all({
      path: '/roleManagement/directory/roleEligibilitySchedules',
      query: {
        $filter: `principalId eq ${odata(principalId)}`,
        $select: 'roleDefinitionId,directoryScopeId',
      },
    });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return {
      unreadable:
        err.status === 401 || err.status === 403
          ? 'the provisioner may not read PIM eligibility — grant it RoleEligibilitySchedule.Read.Directory (Microsoft Graph application permission), or the pim fixture’s RoleEligibilitySchedule.ReadWrite.Directory'
          : /premium|license|licence/i.test(`${err.code} ${err.message}`)
            ? 'PIM is not available here (needs Entra ID P2)'
            : `PIM eligibility could not be read (${err.status} ${err.code})`,
    };
  }
  const roles: EligibleRole[] = [];
  for (const s of schedules) {
    const id = s.roleDefinitionId.toLowerCase();
    const name =
      KNOWN.get(id) ??
      (await graph
        .request<{ displayName?: string }>({
          path: `/roleManagement/directory/roleDefinitions/${encodeURIComponent(id)}`,
          query: { $select: 'displayName' },
        })
        .then((r) => r.data.displayName)
        .catch(() => undefined));
    roles.push({
      roleDefinitionId: id,
      directoryScopeId: s.directoryScopeId || '/',
      ...(name ? { name } : {}),
    });
  }
  return roles;
}

/**
 * Pure: lines for eligible roles `who` holds beyond `allowed` (role definition ids provisioning grants at directory
 * scope /). Any other role, or an allowed one at a narrower scope, is unexpected.
 */
export function unexpectedEligibleRoles(
  who: string,
  eligible: EligibleRole[],
  allowed: readonly string[],
): string[] {
  const lines = new Set<string>();
  for (const r of eligible) {
    if (r.directoryScopeId === '/' && allowed.includes(r.roleDefinitionId.toLowerCase())) continue;
    lines.add(
      `${who} is PIM-eligible for ${r.name ?? 'a directory role whose name could not be read'} (${r.directoryScopeId === '/' ? 'directory scope /' : 'a scoped assignment'}) — not granted by provisioning; remove the eligibility in Entra ID → Privileged Identity Management`,
    );
  }
  return [...lines];
}
