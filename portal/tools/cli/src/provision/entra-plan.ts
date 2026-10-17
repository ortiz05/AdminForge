/**
 * The Entra plan: compares the desired state (provision/entra-desired.ts) with the fetched state
 * (provision/entra-io.ts) and returns ordered operations — create, update (with the properties that differ), delete
 * (a local credential AdminForge no longer wants), noop, or skip (with the reason). Also decides when a local
 * credential needs a new secret or the automation certificate needs registering (`storedSecretIsLive`,
 * `keyThumbprint`).
 *
 * Pure (the clock is a parameter). `provision entra` renders and applies the plan; `provision status` renders the
 * same plan as a checklist, so "status is green" means "apply would do nothing".
 */
import { AZURE_READER_ROLE_ID, RESOURCES, SECRET_LIFETIME_DAYS, type ResourceKey } from './catalog';
import { appNames, groupNames } from './entra-desired';
import type {
  AppKey,
  ApplicationBody,
  AppRole,
  CertificateInfo,
  KeyCredential,
  DesiredApp,
  DesiredEntra,
  EntraOp,
  EntraState,
  GraphApplication,
  GraphGroup,
  GraphServicePrincipal,
  GroupBody,
  ResourceServicePrincipal,
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
  if ((current.isFallbackPublicClient ?? false) !== desired.isFallbackPublicClient)
    changes.push('isFallbackPublicClient');
  if (!sameSet(current.publicClient?.redirectUris ?? [], desired.publicClient.redirectUris))
    changes.push('publicClient');
  if (!sameSet(current.spa?.redirectUris ?? [], desired.spa.redirectUris)) changes.push('spa');
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
export const certificateDisplayName = (label: string) => `adminforge-${label}-certificate`;

/** Upper-case hex SHA-1 thumbprint of a Graph keyCredential (customKeyIdentifier is base64 of the thumbprint bytes). */
export function keyThumbprint(k: KeyCredential): string | undefined {
  if (!k.customKeyIdentifier) return undefined;
  const hex = Buffer.from(k.customKeyIdentifier, 'base64').toString('hex').toUpperCase();
  // Some tenants hold certificates uploaded with the hex thumbprint as text; accept that form too.
  const text = Buffer.from(k.customKeyIdentifier, 'base64').toString('latin1');
  return /^[0-9A-F]{40}$/i.test(text) ? text.toUpperCase() : hex;
}

/** Certificate mode (AF_AUTOMATION_CERT_PATH): register the certificate, then remove every client secret. */
function certificateOps(
  desired: DesiredApp & { certificate: CertificateInfo },
  app: GraphApplication | undefined,
  label: string,
): EntraOp[] {
  const ops: EntraOp[] = [];
  const keys = app?.keyCredentials ?? [];
  const registered = keys.some((k) => keyThumbprint(k) === desired.certificate.thumbprint);
  const others = keys.filter((k) => keyThumbprint(k) !== desired.certificate.thumbprint).length;
  ops.push({
    app: desired.key,
    kind: 'keyCredential',
    action: registered && !others ? 'noop' : app && registered ? 'update' : 'create',
    section: 'Local credentials',
    title: `${desired.body.displayName}: certificate from AF_AUTOMATION_CERT_PATH`,
    changes: [
      ...(registered ? [] : ['not registered on the app']),
      ...(others ? [`replaces ${others} other certificate(s)`] : []),
    ],
    detail: `valid until ${desired.certificate.endDateTime.slice(0, 10)}`,
    certificate: desired.certificate,
    displayName: certificateDisplayName(label),
  });
  for (const c of app?.passwordCredentials ?? [])
    ops.push({
      app: desired.key,
      kind: 'removePassword',
      action: 'delete',
      section: 'Local credentials',
      title: `${desired.body.displayName}: client secret${c.displayName ? ` "${c.displayName}"` : ''}`,
      changes: ['certificate configured (AF_AUTOMATION_CERT_PATH): client secrets are removed'],
      keyId: c.keyId,
    });
  return ops;
}

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

  if (desired.certificate) {
    ops.push(...certificateOps({ ...desired, certificate: desired.certificate }, app, label));
    return ops;
  }

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

/**
 * Application permissions (app-role assignments) AdminForge's apps hold on a resource provisioning knows (Graph,
 * Exchange, SharePoint, …) that provisioning doesn't grant: content that needed them was retired, a baseline
 * permission was dropped, a ceiling withholds them, or someone added them by hand. Assignments to resources
 * provisioning doesn't know are left alone (`provision status` still lists them). Pure.
 */
export function unwantedAppPermissions(
  desired: DesiredEntra,
  state: EntraState,
): Array<{ app: AppKey; assignmentId: string; title: string }> {
  const known = new Map<string, { key: ResourceKey; sp: ResourceServicePrincipal }>();
  for (const key of Object.keys(state.resources) as ResourceKey[]) {
    const sp = state.resources[key];
    if (sp) known.set(sp.id, { key, sp });
  }
  const out: Array<{ app: AppKey; assignmentId: string; title: string }> = [];
  for (const app of desired.apps) {
    const wanted = new Set(
      app.appPermissions.flatMap((p) => {
        const id = state.resources[p.resource]?.id;
        return id ? p.roles.map((r) => `${id}|${r.id.toLowerCase()}`) : [];
      }),
    );
    for (const a of state.appPermissions[app.key] ?? []) {
      const resource = known.get(a.resourceId);
      if (!resource || wanted.has(`${a.resourceId}|${a.appRoleId.toLowerCase()}`)) continue;
      const role = resource.sp.appRoles.find((r) => r.id.toLowerCase() === a.appRoleId.toLowerCase())?.value;
      out.push({
        app: app.key,
        assignmentId: a.id,
        title: `${app.body.displayName} → ${RESOURCES[resource.key].name}: ${role ?? 'a permission'}`,
      });
    }
  }
  return out;
}

export interface PlanEntraOptions {
  /** `provision entra --prune`: also remove the application permissions provisioning doesn't grant. */
  prune?: boolean;
}

/** Pure: desired state + fetched state → ordered operations (create/update/noop/skip per object). */
export function planEntra(
  desired: DesiredEntra,
  state: EntraState,
  now: Date = new Date(),
  opts: PlanEntraOptions = {},
): EntraOp[] {
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
  if (opts.prune)
    for (const u of unwantedAppPermissions(desired, state))
      ops.push({
        kind: 'appRoleRemove',
        action: 'delete',
        section: 'App role assignments',
        title: u.title,
        app: u.app,
        assignmentId: u.assignmentId,
      });

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
