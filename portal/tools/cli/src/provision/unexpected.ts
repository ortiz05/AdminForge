import { AZURE_BUILTIN_ROLE_NAMES, AZURE_READER_ROLE_ID, RESOURCES } from './catalog';
import { LOG_ANALYTICS_READER_ROLE_ID } from './azure-test-plan';
import { appNames } from './entra-desired';
import { keyThumbprint, splitScope } from './entra-plan';
import type { DesiredEntra, EntraState } from './model';

/**
 * `provision status` checks for privilege AdminForge did not grant: anything here is a way into the tenant that
 * provisioning would neither create nor notice. Output is names and counts only — never object ids or UPNs.
 */
export interface UnexpectedCheck {
  title: string;
  /** Empty = as expected. */
  problems: string[];
  /** Could not be checked (e.g. ARM unreadable): shown as a warning, not a failure. */
  unknown?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const byType = (types: Array<string | undefined>) => {
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t ?? 'other', (counts.get(t ?? 'other') ?? 0) + 1);
  return [...counts].map(([t, n]) => `${n} ${t.toLowerCase()}`).join(', ');
};

const isLive = (end: string | null | undefined, now: Date) => !end || new Date(end).getTime() > now.getTime();

/** Pure: compares the fetched state with the desired state and lists privilege nobody asked for. */
export function findUnexpected(
  desired: DesiredEntra,
  state: EntraState,
  now = new Date(),
): UnexpectedCheck[] {
  const { label } = desired.settings;
  const checks: UnexpectedCheck[] = [];
  const resourceName = (id: string) => {
    const key = (Object.keys(state.resources) as Array<keyof typeof RESOURCES>).find(
      (k) => state.resources[k]?.id === id,
    );
    return key ? RESOURCES[key].name : 'another resource';
  };

  for (const want of desired.apps) {
    const name = appNames(label, want.key).displayName;
    const app = state.apps[want.key];
    const sp = state.sps[want.key];
    if (!app) continue;

    // Who may use the app: only the portal groups (Read/Write); nobody for the automation identity.
    if (sp) {
      const allowed = desired.groupAssignments
        .filter((a) => a.app === want.key)
        .map((a) => `${state.groups[a.group]?.id}|${a.appRoleId.toLowerCase()}`);
      const extra = (state.assignedTo[want.key] ?? []).filter(
        (x) => !allowed.includes(`${x.principalId}|${x.appRoleId.toLowerCase()}`),
      );
      checks.push({
        title: `${name}: assigned users, groups and apps`,
        problems: extra.length
          ? [
              `${plural(extra.length, 'assignment')} besides the AdminForge portal groups (${byType(extra.map((x) => x.principalType))})`,
            ]
          : [],
      });

      // Application permissions the app itself holds: none for Read/Write; exactly the desired ones for automation.
      const desiredRoles = new Set(
        want.appPermissions.flatMap((p) =>
          p.roles.map((r) => `${state.resources[p.resource]?.id}|${r.id.toLowerCase()}`),
        ),
      );
      const extraRoles = (state.appPermissions[want.key] ?? []).filter(
        (x) => !desiredRoles.has(`${x.resourceId}|${x.appRoleId.toLowerCase()}`),
      );
      const roleNames = extraRoles.map((x) => {
        const res = Object.values(state.resources).find((r) => r?.id === x.resourceId);
        const value = res?.appRoles.find((r) => r.id.toLowerCase() === x.appRoleId.toLowerCase())?.value;
        return value
          ? `${resourceName(x.resourceId)}: ${value}`
          : `a permission on ${resourceName(x.resourceId)}`;
      });
      checks.push({
        title: `${name}: application permissions`,
        problems: roleNames.length
          ? [
              `${plural(roleNames.length, 'application permission')} provisioning did not grant — ${roleNames.join(', ')}`,
            ]
          : [],
      });

      // Delegated consent: tenant-wide grants on the desired resources only, never per-user grants.
      const grants = state.grants[want.key] ?? [];
      const desiredResources = new Set(want.grants.map((g) => state.resources[g.resource]?.id));
      const perUser = grants.filter((g) => g.consentType !== 'AllPrincipals');
      const elsewhere = grants.filter(
        (g) => g.consentType === 'AllPrincipals' && !desiredResources.has(g.resourceId),
      );
      checks.push({
        title: `${name}: delegated consent grants`,
        problems: [
          ...(perUser.length
            ? [
                `${plural(perUser.length, 'per-user consent grant')} (${perUser.map((g) => splitScope(g.scope).length).reduce((a, b) => a + b, 0)} scopes)`,
              ]
            : []),
          ...(elsewhere.length
            ? [
                `${plural(elsewhere.length, 'tenant-wide grant')} on resources provisioning does not grant — ${[...new Set(elsewhere.map((g) => resourceName(g.resourceId)))].join(', ')}`,
              ]
            : []),
        ],
      });
    }

    // Owners can add credentials to the app and act as it.
    const owners = state.owners?.[want.key];
    if (owners) {
      const count = (ids: string[]) => {
        const prov = ids.filter((id) => id === state.provisionerSpId).length;
        return [
          ...(prov ? ['the provisioner identity'] : []),
          ...(ids.length - prov ? [plural(ids.length - prov, 'other owner')] : []),
        ].join(' and ');
      };
      checks.push({
        title: `${name}: owners`,
        problems: [
          ...(owners.app.length ? [`app registration owned by ${count(owners.app)}`] : []),
          ...(owners.sp.length ? [`service principal owned by ${count(owners.sp)}`] : []),
        ],
      });
    }

    // Credentials: one client secret (or, in certificate mode, one certificate) on the app; none on the SP.
    const passwords = app.passwordCredentials ?? [];
    const keys = app.keyCredentials ?? [];
    const expired = [...passwords, ...keys].filter((c) => !isLive(c.endDateTime, now)).length;
    const wantCert = want.certificate;
    const problems: string[] = [];
    if (wantCert) {
      if (passwords.length)
        problems.push(`${plural(passwords.length, 'client secret')} (certificate mode expects none)`);
      const foreign = keys.filter((k) => keyThumbprint(k) !== wantCert.thumbprint).length;
      if (foreign) problems.push(`${plural(foreign, 'certificate')} other than AF_AUTOMATION_CERT_PATH`);
    } else {
      if (passwords.length > 1) problems.push(`${passwords.length} client secrets (expected 1)`);
      if (keys.length) problems.push(`${plural(keys.length, 'certificate')} (expected none)`);
    }
    if (sp && ((sp.passwordCredentials ?? []).length || (sp.keyCredentials ?? []).length))
      problems.push(
        `service principal holds ${plural((sp.passwordCredentials ?? []).length + (sp.keyCredentials ?? []).length, 'credential')} (expected none)`,
      );
    if (problems.length && expired) problems.push(`${expired} of them expired`);
    checks.push({ title: `${name}: credentials`, problems });

    // Sign-in surface: no public-client flows, no SPA redirect URIs, no exposed API.
    const surface: string[] = [];
    if (app.isFallbackPublicClient) surface.push('public client flows allowed (isFallbackPublicClient)');
    if (app.publicClient?.redirectUris?.length)
      surface.push(plural(app.publicClient.redirectUris.length, 'public-client redirect URI'));
    if (app.spa?.redirectUris?.length) surface.push(plural(app.spa.redirectUris.length, 'SPA redirect URI'));
    if (app.identifierUris?.length) surface.push(plural(app.identifierUris.length, 'identifier URI'));
    if (app.api?.oauth2PermissionScopes?.length)
      surface.push(plural(app.api.oauth2PermissionScopes.length, 'exposed API scope'));
    checks.push({ title: `${name}: sign-in surface`, problems: surface });
  }

  // Azure RBAC of the automation identity: Reader on the subscription (+ Log Analytics Reader in AF-Test-<label>).
  const automation = state.sps.automation;
  if (desired.arm && automation) {
    const title = `${appNames(label, 'automation').displayName}: Azure role assignments`;
    if (state.arm.error)
      checks.push({ title, problems: [], unknown: 'could not read Azure role assignments' });
    else {
      const sub = desired.arm.scope.toLowerCase();
      const testRg = `${sub}/resourcegroups/af-test-${label}`.toLowerCase();
      const roleGuid = (id: string) => id.toLowerCase().split('/').pop() ?? '';
      const extra = state.arm.assignments.filter((a) => {
        const scope = a.properties.scope.toLowerCase();
        const role = roleGuid(a.properties.roleDefinitionId);
        if (role === AZURE_READER_ROLE_ID && scope === sub) return false;
        if (role === LOG_ANALYTICS_READER_ROLE_ID && (scope === testRg || scope.startsWith(`${testRg}/`)))
          return false;
        return true;
      });
      const where = (scope: string) => {
        const s = scope.toLowerCase();
        if (s === sub) return 'subscription';
        if (!s.startsWith(`${sub}/`)) return 'above the subscription';
        return /\/resourcegroups\/[^/]+$/.test(s) ? 'resource group' : 'resource';
      };
      checks.push({
        title,
        problems: extra.length
          ? [
              `${plural(extra.length, 'role assignment')} provisioning did not make — ${extra
                .map(
                  (a) =>
                    `${AZURE_BUILTIN_ROLE_NAMES[roleGuid(a.properties.roleDefinitionId)] ?? 'another role'} at ${where(a.properties.scope)}`,
                )
                .join(', ')}`,
            ]
          : [],
      });
    }
  }
  return checks;
}

export const unexpectedFailures = (checks: UnexpectedCheck[]) =>
  checks.filter((c) => c.problems.length).map((c) => `${c.title} — ${c.problems.join('; ')}`);
