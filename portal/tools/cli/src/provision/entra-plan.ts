import { AZURE_READER_ROLE_ID, RESOURCES, SECRET_LIFETIME_DAYS } from './catalog';
import { appNames, groupNames } from './entra-desired';
import type {
  ApplicationBody,
  AppRole,
  DesiredApp,
  DesiredEntra,
  EntraOp,
  EntraState,
  GraphApplication,
  GraphGroup,
  GraphServicePrincipal,
  GroupBody,
  ServicePrincipalBody,
} from './model';

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

const lowerSet = (xs: readonly string[]) => xs.map((x) => x.toLowerCase());

/** Splits an oauth2PermissionGrant scope string ("a b  c ") into names. */
export const splitScope = (scope: string | null | undefined) => (scope ?? '').split(/\s+/).filter(Boolean);

function roleDiffers(want: AppRole, have: AppRole | undefined): boolean {
  return (
    !have ||
    have.value !== want.value ||
    have.displayName !== want.displayName ||
    have.description !== want.description ||
    have.isEnabled !== want.isEnabled ||
    !sameSet(have.allowedMemberTypes ?? [], want.allowedMemberTypes)
  );
}

const rraKeys = (rra: ApplicationBody['requiredResourceAccess'] | undefined) =>
  (rra ?? []).flatMap((r) =>
    r.resourceAccess.map((a) => `${r.resourceAppId.toLowerCase()}|${a.id.toLowerCase()}|${a.type}`),
  );

/** Pure: names of the properties of `current` that differ from `desired`. */
export function diffApplication(desired: ApplicationBody, current: GraphApplication): string[] {
  const changes: string[] = [];
  if (current.displayName !== desired.displayName) changes.push('displayName');
  if (current.signInAudience !== desired.signInAudience) changes.push('signInAudience');
  if ((current.groupMembershipClaims ?? 'None') !== (desired.groupMembershipClaims ?? 'None'))
    changes.push('groupMembershipClaims');
  if (!sameSet(current.web?.redirectUris ?? [], desired.web.redirectUris)) changes.push('redirectUris');
  const implicit = current.web?.implicitGrantSettings;
  if (
    (implicit?.enableAccessTokenIssuance ?? false) !==
      desired.web.implicitGrantSettings.enableAccessTokenIssuance ||
    (implicit?.enableIdTokenIssuance ?? false) !== desired.web.implicitGrantSettings.enableIdTokenIssuance
  )
    changes.push('implicitGrantSettings');
  const haveRoles = new Map((current.appRoles ?? []).map((r) => [r.id.toLowerCase(), r]));
  if (desired.appRoles.some((r) => roleDiffers(r, haveRoles.get(r.id.toLowerCase()))))
    changes.push('appRoles');
  const claimNames = (c: GraphApplication['optionalClaims']) => (c?.idToken ?? []).map((x) => x.name);
  if (!sameSet(claimNames(current.optionalClaims), claimNames(desired.optionalClaims)))
    changes.push('optionalClaims');
  if (!sameSet(rraKeys(current.requiredResourceAccess), rraKeys(desired.requiredResourceAccess)))
    changes.push('requiredResourceAccess');
  return changes;
}

/** The PATCH body for an update: desired state, keeping any app roles AdminForge does not manage. */
export function mergeApplicationBody(
  desired: ApplicationBody,
  current: GraphApplication | undefined,
): ApplicationBody {
  const ours = new Set(desired.appRoles.map((r) => r.id.toLowerCase()));
  const theirs = (current?.appRoles ?? []).filter((r) => !ours.has(r.id.toLowerCase()));
  return { ...desired, appRoles: [...desired.appRoles, ...theirs] };
}

export function diffServicePrincipal(
  desired: ServicePrincipalBody,
  current: GraphServicePrincipal,
): string[] {
  const changes: string[] = [];
  if ((current.appRoleAssignmentRequired ?? false) !== desired.appRoleAssignmentRequired)
    changes.push('appRoleAssignmentRequired');
  if (desired.tags.some((t) => !(current.tags ?? []).includes(t))) changes.push('tags');
  return changes;
}

export function diffGroup(desired: GroupBody, current: GraphGroup): string[] {
  const changes: string[] = [];
  if (current.displayName !== desired.displayName) changes.push('displayName');
  if ((current.description ?? '') !== desired.description) changes.push('description');
  if (current.securityEnabled === false) changes.push('securityEnabled');
  return changes;
}

/** Whether the secret in the env file still matches a live credential on the app (Graph exposes a 3-char hint). */
export function storedSecretIsLive(app: GraphApplication, secret: string | undefined, now: Date): boolean {
  if (!secret) return false;
  return (app.passwordCredentials ?? []).some(
    (c) =>
      !!c.hint &&
      secret.startsWith(c.hint) &&
      (!c.endDateTime || new Date(c.endDateTime).getTime() > now.getTime()),
  );
}

const scopeDelta = (want: string[], have: string[]) => {
  const lw = new Set(lowerSet(want));
  const lh = new Set(lowerSet(have));
  return [
    ...want.filter((w) => !lh.has(w.toLowerCase())).map((w) => `+${w}`),
    ...have.filter((h) => !lw.has(h.toLowerCase())).map((h) => `-${h}`),
  ];
};

export const secretDisplayName = (label: string) => `adminforge-${label}-local`;

function planApp(desired: DesiredApp, state: EntraState, label: string, now: Date): EntraOp[] {
  const ops: EntraOp[] = [];
  const app = state.apps[desired.key];
  const sp = state.sps[desired.key];
  const title = desired.body.displayName;
  const base = { app: desired.key };

  if (!app)
    ops.push({
      ...base,
      kind: 'application',
      action: 'create',
      section: 'Applications',
      title,
      uniqueName: desired.uniqueName,
      body: desired.body,
    });
  else {
    const changes = diffApplication(desired.body, app);
    ops.push({
      ...base,
      kind: 'application',
      action: changes.length ? 'update' : 'noop',
      section: 'Applications',
      title,
      changes,
      uniqueName: desired.uniqueName,
      body: mergeApplicationBody(desired.body, app),
    });
  }

  const spDetail = `assignment required: ${desired.sp.appRoleAssignmentRequired ? 'yes' : 'no'}`;
  if (!sp)
    ops.push({
      ...base,
      kind: 'servicePrincipal',
      action: 'create',
      section: 'Service principals',
      title,
      body: desired.sp,
      detail: spDetail,
    });
  else {
    const changes = diffServicePrincipal(desired.sp, sp);
    ops.push({
      ...base,
      kind: 'servicePrincipal',
      action: changes.length ? 'update' : 'noop',
      section: 'Service principals',
      title,
      changes,
      body: desired.sp,
      detail: spDetail,
    });
  }

  const envId = state.env[desired.env.clientId];
  const idMismatch = !!app && !!envId && envId !== app.appId;
  ops.push({
    ...base,
    kind: 'envClientId',
    action: app && envId === app.appId ? 'noop' : idMismatch ? 'update' : 'create',
    section: 'Local credentials',
    title: desired.env.clientId,
    changes: idMismatch ? ['env file holds a different client id'] : undefined,
    envKey: desired.env.clientId,
  });

  const secret = state.env[desired.env.secret];
  let why: string | undefined;
  if (!app) why = 'new app';
  else if (!secret) why = 'not in env file';
  else if (envId !== app.appId) why = 'env file secret belongs to a different client id';
  else if (!storedSecretIsLive(app, secret, now))
    why = 'stored secret is not a live credential on the app (deleted or expired)';
  ops.push({
    ...base,
    kind: 'secret',
    action: why ? 'create' : 'noop',
    section: 'Local credentials',
    title: desired.env.secret,
    changes: why ? [why] : undefined,
    envKey: desired.env.secret,
    displayName: secretDisplayName(label),
    days: SECRET_LIFETIME_DAYS,
  });
  return ops;
}

/** Pure: desired state + fetched state → ordered operations (create/update/noop/skip per object). */
export function planEntra(desired: DesiredEntra, state: EntraState, now: Date = new Date()): EntraOp[] {
  const { label } = desired.settings;
  const ops: EntraOp[] = [];
  const appOps = desired.apps.map((a) => planApp(a, state, label, now));
  // Objects first (apps, then SPs), then local credentials, so ids exist before anything references them.
  for (const section of ['Applications', 'Service principals', 'Local credentials'] as const)
    for (const list of appOps) ops.push(...list.filter((o) => o.section === section));

  for (const g of desired.groups) {
    const current = state.groups[g.role];
    const changes = current ? diffGroup(g.body, current) : [];
    ops.push({
      kind: 'group',
      action: !current ? 'create' : changes.length ? 'update' : 'noop',
      section: 'Groups',
      title: g.body.displayName,
      changes,
      role: g.role,
      uniqueName: g.uniqueName,
      body: g.body,
    });
  }

  for (const app of desired.apps) {
    const sp = state.sps[app.key];
    for (const grant of app.grants) {
      const resourceSp = state.resources[grant.resource]!;
      const scope = grant.scopes.join(' ');
      const title = `${app.body.displayName} → ${RESOURCES[grant.resource].name}`;
      const existing = sp
        ? (state.grants[app.key] ?? []).find(
            (g) => g.resourceId === resourceSp.id && g.consentType === 'AllPrincipals',
          )
        : undefined;
      if (!existing) {
        ops.push({
          kind: 'grant',
          action: 'create',
          section: 'Consent grants',
          title,
          detail: scope,
          app: app.key,
          resource: grant.resource,
          scope,
        });
        continue;
      }
      const delta = scopeDelta(grant.scopes, splitScope(existing.scope));
      ops.push({
        kind: 'grant',
        action: delta.length ? 'update' : 'noop',
        section: 'Consent grants',
        title,
        changes: delta,
        detail: scope,
        app: app.key,
        resource: grant.resource,
        scope,
        grantId: existing.id,
      });
    }
  }

  for (const a of desired.groupAssignments) {
    const group = state.groups[a.group];
    const sp = state.sps[a.app];
    const exists =
      !!group &&
      !!sp &&
      (state.assignedTo[a.app] ?? []).some(
        (x) => x.principalId === group.id && x.appRoleId.toLowerCase() === a.appRoleId.toLowerCase(),
      );
    ops.push({
      kind: 'appRoleAssignment',
      action: exists ? 'noop' : 'create',
      section: 'App role assignments',
      title: `${groupNames(label, a.group).displayName} → ${appNames(label, a.app).displayName}: ${a.roleName}`,
      principal: { group: a.group },
      target: { app: a.app },
      appRoleId: a.appRoleId,
    });
  }

  for (const app of desired.apps) {
    const sp = state.sps[app.key];
    for (const perm of app.appPermissions) {
      const resourceSp = state.resources[perm.resource]!;
      for (const role of perm.roles) {
        const exists =
          !!sp &&
          (state.appPermissions[app.key] ?? []).some(
            (x) => x.resourceId === resourceSp.id && x.appRoleId.toLowerCase() === role.id.toLowerCase(),
          );
        ops.push({
          kind: 'appRoleAssignment',
          action: exists ? 'noop' : 'create',
          section: 'App role assignments',
          title: `${app.body.displayName} → ${RESOURCES[perm.resource].name}: ${role.value}`,
          principal: { app: app.key },
          target: { resource: perm.resource },
          appRoleId: role.id,
        });
      }
    }
  }

  if (desired.arm) {
    const sp = state.sps.automation;
    const title = `${appNames(label, 'automation').displayName} → ${desired.arm.roleName} on subscription (AF_SUBSCRIPTION_ID)`;
    const suffix = `/roledefinitions/${AZURE_READER_ROLE_ID}`;
    const exists =
      !!sp &&
      state.arm.assignments.some(
        (r) =>
          r.properties.principalId === sp.id &&
          r.properties.roleDefinitionId.toLowerCase().endsWith(suffix) &&
          r.properties.scope.toLowerCase() === desired.arm!.scope.toLowerCase(),
      );
    if (sp && state.arm.error)
      ops.push({ kind: 'skipped', action: 'skip', section: 'Azure RBAC', title, changes: [state.arm.error] });
    else
      ops.push({
        kind: 'armRoleAssignment',
        action: exists ? 'noop' : 'create',
        section: 'Azure RBAC',
        title,
        scope: desired.arm.scope,
        roleDefinitionId: desired.arm.roleDefinitionId,
      });
  }

  for (const s of desired.skipped)
    ops.push({ kind: 'skipped', action: 'skip', section: s.section, title: s.title, changes: [s.reason] });
  return ops;
}
