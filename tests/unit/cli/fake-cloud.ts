import { createHash, randomUUID } from 'node:crypto';
import { DIRECTORY_ROLES, RESOURCES } from '@adminforge/cli/src/provision/catalog';

/**
 * In-memory stand-in for the slice of Entra ID token endpoint, Microsoft Graph, and ARM that
 * `adminforge provision` uses. Synthetic data only (example.com, generated GUIDs). No network.
 */

type Json = Record<string, unknown>;
interface Obj extends Json {
  id: string;
}

export interface FakeCloudOptions {
  tenantId: string;
  provisioner: { clientId: string; secret: string };
  /** Simulate an unlicensed tenant (no Exchange Online service principal). Default false. */
  withExchange?: boolean;
  /** When false, PATCH /collection(key='…') is rejected like an API version without upsert. Default true. */
  upsertSupported?: boolean;
  /** Number of times a just-created application is "not visible" to the next SP upsert (replication). */
  spReplicationMisses?: number;
  /** When false, the authentication methods policy answers 403 to the provisioner. Default true. */
  authMethodsPolicyReadable?: boolean;
  /** When false, a user's transitive directory roles answer 403. Default true. */
  directoryRolesReadable?: boolean;
  /** Service plans of the tenant's one active subscription (`/subscribedSkus`). Default: none (unlicensed). */
  servicePlans?: string[];
}

/** Built-in directory role names by template id (Microsoft's well-known ids, the same in every tenant). */
export const FAKE_ROLE_NAMES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(DIRECTORY_ROLES).map(([name, id]) => [id, name])),
  '62e90394-69f5-4237-9190-012177145e10': 'Global Administrator',
  'e8611ab8-c189-46e8-94e1-60213ab1f814': 'Privileged Role Administrator',
};

const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const graphError = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

const SCOPES = [
  'openid',
  'profile',
  'offline_access',
  'User.Read',
  'User.Read.All',
  'Group.Read.All',
  'GroupMember.Read.All',
  'Directory.Read.All',
  'AuditLog.Read.All',
  'Reports.Read.All',
  'Policy.Read.All',
  'RoleManagement.Read.Directory',
  'RoleEligibilitySchedule.Read.Directory',
  'RoleAssignmentSchedule.Read.Directory',
  'UserAuthenticationMethod.Read.All',
  'Application.Read.All',
  'DeviceManagementManagedDevices.Read.All',
  'DeviceManagementConfiguration.Read.All',
  'DeviceManagementApps.Read.All',
  'ServiceHealth.Read.All',
  'ServiceMessage.Read.All',
  'Organization.Read.All',
  'SecurityIncident.Read.All',
  'SecurityAlert.Read.All',
  'IdentityRiskyUser.Read.All',
  'Sites.Read.All',
  'Team.ReadBasic.All',
  'User.ReadWrite.All',
  'User.EnableDisableAccount.All',
  'User.RevokeSessions.All',
  'Group.ReadWrite.All',
  'GroupMember.ReadWrite.All',
  'UserAuthenticationMethod.ReadWrite.All',
  'RoleManagement.ReadWrite.Directory',
  'RoleAssignmentSchedule.ReadWrite.Directory',
  'Application.ReadWrite.All',
  'Policy.ReadWrite.ConditionalAccess',
  'DeviceManagementManagedDevices.ReadWrite.All',
  'DeviceManagementManagedDevices.PrivilegedOperations.All',
  'Mail.Send',
  'Directory.ReadWrite.All',
];
const APP_ROLES = [
  'Directory.Read.All',
  'User.Read.All',
  'Group.Read.All',
  'GroupMember.Read.All',
  'Application.Read.All',
  'AuditLog.Read.All',
  'Reports.Read.All',
  'ServiceHealth.Read.All',
  'ServiceMessage.Read.All',
  'Policy.Read.All',
  'RoleManagement.Read.Directory',
  'Organization.Read.All',
  'Device.Read.All',
  'DeviceManagementManagedDevices.Read.All',
  'SecurityIncident.Read.All',
  'SecurityAlert.Read.All',
  'IdentityRiskyUser.Read.All',
];

export function createFakeCloud(opts: FakeCloudOptions) {
  const apps: Obj[] = [];
  const sps: Obj[] = [];
  const groups: Obj[] = [];
  const users: Obj[] = [];
  const grants: Obj[] = [];
  const assignments: Obj[] = [];
  const members: Array<{ groupId: string; memberId: string }> = [];
  const roleAssignments: Obj[] = [];
  /** Owners per object id (applications, service principals, groups). */
  const owners = new Map<string, string[]>();
  /** Users whose sign-in sessions were revoked. */
  const revoked: string[] = [];
  const armAssignments: Array<{ id: string; name: string; properties: Json }> = [];
  const secrets = new Map<string, string>(); // clientId → secret (live credentials only)
  const calls: string[] = [];
  let spMisses = opts.spReplicationMisses ?? 0;
  /** Entra's authentication methods policy: the registration campaign as a new tenant has it (Microsoft-managed). */
  const authMethodsPolicy = {
    id: 'authenticationMethodsPolicy',
    displayName: 'Authentication Methods Policy',
    registrationEnforcement: {
      authenticationMethodsRegistrationCampaign: {
        snoozeDurationInDays: 1,
        state: 'default',
        excludeTargets: [] as Json[],
        includeTargets: [
          { id: 'all_users', targetType: 'group', targetedAuthenticationMethod: 'microsoftAuthenticator' },
        ] as Json[],
      } as Json,
    },
  };

  const resourceSp = (key: keyof typeof RESOURCES, scopes: string[], roles: string[]) =>
    sps.push({
      id: randomUUID(),
      appId: RESOURCES[key].appId,
      displayName: RESOURCES[key].name,
      oauth2PermissionScopes: scopes.map((value) => ({ id: randomUUID(), value, isEnabled: true })),
      appRoles: roles.map((value) => ({
        id: randomUUID(),
        value,
        allowedMemberTypes: ['Application'],
        isEnabled: true,
      })),
    });
  resourceSp('graph', SCOPES, APP_ROLES);
  resourceSp('arm', ['user_impersonation'], []);
  resourceSp('logAnalytics', ['Data.Read'], ['Data.Read']);
  if (opts.withExchange) resourceSp('exchange', ['Exchange.Manage'], []);
  secrets.set(opts.provisioner.clientId, opts.provisioner.secret);
  const graphSp = () => sps.find((s) => s.appId === RESOURCES.graph.appId)!;

  const strip = (o: Obj) => {
    const copy = structuredClone(o) as Json;
    if (Array.isArray(copy.passwordCredentials))
      copy.passwordCredentials = (copy.passwordCredentials as Json[]).map(({ secret: _s, ...rest }) => rest);
    return copy;
  };
  const eqFilter = (url: URL) => {
    const m = /^(\w+) eq '([^']*)'$/.exec(url.searchParams.get('$filter') ?? '');
    return m ? { prop: m[1]!, value: m[2]! } : undefined;
  };
  const list = (items: Obj[], url: URL) => {
    const f = eqFilter(url);
    const hits = f
      ? items.filter((i) => String(i[f.prop] ?? '').toLowerCase() === f.value.toLowerCase())
      : items;
    return json(200, { value: hits.map(strip) });
  };

  function token(form: URLSearchParams) {
    const clientId = form.get('client_id')!;
    // Certificate (client assertion): accepted when the app has a key credential (signature checked in unit tests).
    const app = apps.find((a) => a.appId === clientId);
    const assertionOk =
      form.get('client_assertion_type') === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' &&
      !!form.get('client_assertion') &&
      ((app?.keyCredentials as unknown[] | undefined) ?? []).length > 0;
    if (!assertionOk && (!secrets.has(clientId) || secrets.get(clientId) !== form.get('client_secret')))
      return json(401, {
        error: 'invalid_client',
        error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x',
      });
    const sp = sps.find((s) => s.appId === clientId);
    const graphRoles = sp
      ? assignments
          .filter((a) => a.principalId === sp.id && a.resourceId === graphSp().id)
          .map((a) => (graphSp().appRoles as Obj[]).find((r) => r.id === a.appRoleId)!.value)
      : [];
    const scope = form.get('scope') ?? '';
    const payload = {
      appid: clientId,
      aud: scope,
      ...(scope.startsWith('https://graph') && graphRoles.length ? { roles: graphRoles } : {}),
    };
    return json(200, { access_token: `${b64({ alg: 'none' })}.${b64(payload)}.sig`, expires_in: 3600 });
  }

  const callerOf = (init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    return JSON.parse(Buffer.from(auth.replace('Bearer ', '').split('.')[1]!, 'base64url').toString()) as {
      appid: string;
    };
  };

  function upsert(collection: Obj[], match: (o: Obj) => boolean, body: Json, extra: Json) {
    const existing = collection.find(match);
    if (existing) {
      Object.assign(existing, body);
      return json(204);
    }
    const created: Obj = { id: randomUUID(), ...extra, ...body };
    collection.push(created);
    return json(201, strip(created));
  }

  function graph(method: string, url: URL, body: Json | undefined, init?: RequestInit): Response {
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ''));
    const prefer = new Headers(init?.headers).get('prefer');
    let m: RegExpExecArray | null;

    if (method === 'GET' && path === '/servicePrincipals') return list(sps, url);
    if (method === 'GET' && path === '/applications') return list(apps, url);
    if (method === 'GET' && path === '/groups') return list(groups, url);
    if (method === 'GET' && path === '/oauth2PermissionGrants') return list(grants, url);
    if (method === 'GET' && path === '/roleManagement/directory/roleAssignments')
      return list(roleAssignments, url);
    if (path === '/policies/authenticationMethodsPolicy' && (method === 'GET' || method === 'PATCH')) {
      if (opts.authMethodsPolicyReadable === false)
        return graphError(403, 'accessDenied', 'Request Authorization failed');
      if (method === 'GET')
        return json(200, {
          '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#authenticationMethodsPolicy',
          ...structuredClone(authMethodsPolicy),
        });
      // Like Graph: a complex property in a PATCH replaces the stored one as a whole.
      const enforcement = body?.registrationEnforcement as Json | undefined;
      if (enforcement?.authenticationMethodsRegistrationCampaign)
        authMethodsPolicy.registrationEnforcement.authenticationMethodsRegistrationCampaign = structuredClone(
          enforcement.authenticationMethodsRegistrationCampaign as Json,
        );
      return json(204);
    }
    if (method === 'GET' && path === '/subscribedSkus')
      return json(200, {
        value: opts.servicePlans?.length
          ? [
              {
                capabilityStatus: 'Enabled',
                servicePlans: opts.servicePlans.map((servicePlanName) => ({ servicePlanName })),
              },
            ]
          : [],
      });
    if (method === 'GET' && path === '/policies/identitySecurityDefaultsEnforcementPolicy')
      return callerOf(init).appid === opts.provisioner.clientId
        ? graphError(403, 'AccessDenied', 'Insufficient privileges')
        : json(200, { isEnabled: false });

    if ((m = /^\/(applications|groups)\(uniqueName='([^']+)'\)$/.exec(path)) && method === 'PATCH') {
      if (opts.upsertSupported === false)
        return graphError(400, 'BadRequest', `Resource not found for the segment '${m[1]}'.`);
      if (prefer !== 'create-if-missing') return graphError(404, 'Request_ResourceNotFound', 'not found');
      const unique = m[2]!;
      const collection = m[1] === 'applications' ? apps : groups;
      return upsert(
        collection,
        (o) => o.uniqueName === unique,
        body!,
        m[1] === 'applications'
          ? { appId: randomUUID(), uniqueName: unique, passwordCredentials: [] }
          : { uniqueName: unique },
      );
    }
    if ((m = /^\/servicePrincipals\(appId='([^']+)'\)$/.exec(path)) && method === 'PATCH') {
      if (opts.upsertSupported === false)
        return graphError(400, 'BadRequest', "Resource not found for the segment 'servicePrincipals'.");
      const appId = m[1]!;
      if (spMisses > 0) {
        spMisses--;
        return graphError(
          400,
          'Request_BadRequest',
          `The appId '${appId}' of the service principal does not reference a valid application object.`,
        );
      }
      const app = apps.find((a) => a.appId === appId)!;
      return upsert(sps, (o) => o.appId === appId, body!, { appId, displayName: app.displayName });
    }
    if (
      method === 'POST' &&
      (path === '/applications' || path === '/groups' || path === '/servicePrincipals')
    ) {
      const created: Obj = { id: randomUUID(), ...body };
      if (path === '/applications') Object.assign(created, { appId: randomUUID(), passwordCredentials: [] });
      ({ '/applications': apps, '/groups': groups, '/servicePrincipals': sps })[path]!.push(created);
      return json(201, strip(created));
    }
    if (
      (m = /^\/(applications|servicePrincipals|groups|users|oauth2PermissionGrants)\/([^/]+)$/.exec(path))
    ) {
      const collection = {
        applications: apps,
        servicePrincipals: sps,
        groups,
        users,
        oauth2PermissionGrants: grants,
      }[m[1] as 'applications']!;
      const target = collection.find(
        (o) =>
          o.id === m![2] ||
          (m![1] === 'users' && String(o.userPrincipalName).toLowerCase() === m![2]!.toLowerCase()),
      );
      if (!target) return graphError(404, 'Request_ResourceNotFound', `Resource '${m[2]}' does not exist.`);
      if (method === 'GET') return json(200, strip(target));
      if (method === 'PATCH') {
        // Like Graph: a certificate's thumbprint becomes customKeyIdentifier; the key itself is never returned.
        const patch = { ...body };
        if (Array.isArray(patch.keyCredentials))
          patch.keyCredentials = (patch.keyCredentials as Json[]).map(({ key, ...rest }) => ({
            keyId: randomUUID(),
            ...rest,
            customKeyIdentifier: createHash('sha1')
              .update(Buffer.from(String(key), 'base64'))
              .digest('base64'),
          }));
        Object.assign(target, patch);
        return json(204);
      }
    }
    if ((m = /^\/(applications|servicePrincipals|groups)\/([^/]+)\/owners$/.exec(path)) && method === 'GET')
      return json(200, { value: (owners.get(m[2]!) ?? []).map((id) => ({ id })) });
    if ((m = /^\/groups\/([^/]+)\/owners\/\$ref$/.exec(path)) && method === 'POST') {
      const ownerId = String(body!['@odata.id']).split('/').pop()!;
      const list = owners.get(m[1]!) ?? [];
      if (list.includes(ownerId))
        return graphError(
          400,
          'Request_BadRequest',
          "One or more added object references already exist for the following modified properties: 'owners'.",
        );
      owners.set(m[1]!, [...list, ownerId]);
      return json(204);
    }
    if ((m = /^\/groups\/([^/]+)\/members\/([^/]+)\/\$ref$/.exec(path)) && method === 'DELETE') {
      const i = members.findIndex((x) => x.groupId === m![1] && x.memberId === m![2]);
      if (i < 0) return graphError(404, 'Request_ResourceNotFound', 'not a member');
      members.splice(i, 1);
      return json(204);
    }
    if ((m = /^\/roleManagement\/directory\/roleAssignments\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      const i = roleAssignments.findIndex((x) => x.id === m![1]);
      if (i < 0) return graphError(404, 'Request_ResourceNotFound', 'no such assignment');
      roleAssignments.splice(i, 1);
      return json(204);
    }
    if ((m = /^\/users\/([^/]+)\/revokeSignInSessions$/.exec(path)) && method === 'POST') {
      revoked.push(m[1]!);
      return json(200, { value: true });
    }
    if ((m = /^\/applications\/([^/]+)\/removePassword$/.exec(path)) && method === 'POST') {
      const app = apps.find((a) => a.id === m![1])!;
      const creds = app.passwordCredentials as Json[];
      const gone = creds.find((c) => c.keyId === body!.keyId);
      app.passwordCredentials = creds.filter((c) => c !== gone);
      if (gone && [...secrets].some(([id, v]) => id === app.appId && v === gone.secret))
        secrets.delete(app.appId as string);
      return json(204);
    }
    if ((m = /^\/applications\/([^/]+)\/addPassword$/.exec(path)) && method === 'POST') {
      const app = apps.find((a) => a.id === m![1])!;
      const secretText = `fake~${randomUUID()}`;
      const cred = (body!.passwordCredential as Json) ?? {};
      (app.passwordCredentials as Json[]).push({
        keyId: randomUUID(),
        displayName: cred.displayName,
        endDateTime: cred.endDateTime,
        hint: secretText.slice(0, 3),
        secret: secretText,
      });
      secrets.set(app.appId as string, secretText);
      return json(200, { secretText });
    }
    if (method === 'POST' && path === '/oauth2PermissionGrants') {
      grants.push({ id: randomUUID(), ...body });
      return json(201, body);
    }
    if ((m = /^\/servicePrincipals\/([^/]+)\/(appRoleAssignedTo|appRoleAssignments)$/.exec(path))) {
      const spId = m[1]!;
      if (method === 'GET')
        return json(200, {
          value: assignments.filter(
            (a) => (m![2] === 'appRoleAssignedTo' ? a.resourceId : a.principalId) === spId,
          ),
        });
      if (
        assignments.some(
          (a) =>
            a.principalId === body!.principalId && a.resourceId === spId && a.appRoleId === body!.appRoleId,
        )
      )
        return graphError(
          400,
          'Request_BadRequest',
          'Permission being assigned already exists on the object',
        );
      assignments.push({ id: randomUUID(), ...body, resourceId: spId });
      return json(201, body);
    }
    if (method === 'POST' && path === '/users') {
      if (users.some((u) => u.userPrincipalName === body!.userPrincipalName))
        return graphError(
          400,
          'Request_BadRequest',
          'Another object with the same value for property userPrincipalName already exists.',
        );
      const created: Obj = { id: randomUUID(), ...body };
      users.push(created);
      return json(201, created);
    }
    if (
      (m = /^\/users\/([^/]+)\/transitiveMemberOf\/microsoft\.graph\.directoryRole$/.exec(path)) &&
      method === 'GET'
    ) {
      if (opts.directoryRolesReadable === false)
        return graphError(
          403,
          'Authorization_RequestDenied',
          'Insufficient privileges to complete the operation.',
        );
      const principals = new Set([
        m[1]!,
        ...members.filter((x) => x.memberId === m![1]).map((x) => x.groupId),
      ]);
      const ids = [
        ...new Set(
          roleAssignments
            .filter((r) => principals.has(String(r.principalId)) && r.directoryScopeId === '/')
            .map((r) => String(r.roleDefinitionId)),
        ),
      ];
      return json(200, {
        value: ids.map((id) => ({
          '@odata.type': '#microsoft.graph.directoryRole',
          id: `directory-role-${id}`,
          roleTemplateId: id,
          displayName: FAKE_ROLE_NAMES[id] ?? 'Custom role',
        })),
      });
    }
    if ((m = /^\/roleManagement\/directory\/roleDefinitions\/([^/]+)$/.exec(path)) && method === 'GET')
      return FAKE_ROLE_NAMES[m[1]!]
        ? json(200, { id: m[1], displayName: FAKE_ROLE_NAMES[m[1]!] })
        : graphError(404, 'Request_ResourceNotFound', 'no such role definition');
    if ((m = /^\/users\/([^/]+)\/memberOf$/.exec(path)) && method === 'GET')
      return json(200, {
        value: members.filter((x) => x.memberId === m![1]).map((x) => ({ id: x.groupId })),
      });
    if ((m = /^\/groups\/([^/]+)\/members\/\$ref$/.exec(path)) && method === 'POST') {
      const memberId = String(body!['@odata.id']).split('/').pop()!;
      members.push({ groupId: m[1]!, memberId });
      return json(204);
    }
    if (method === 'POST' && path === '/roleManagement/directory/roleAssignments') {
      roleAssignments.push({ id: randomUUID(), ...body });
      return json(201, body);
    }
    return graphError(400, 'Unhandled', `fake Graph does not implement ${method} ${path}`);
  }

  function arm(method: string, url: URL, body: Json | undefined): Response {
    const path = decodeURIComponent(url.pathname);
    let m: RegExpExecArray | null;
    if (method === 'GET' && /\/providers\/Microsoft\.Authorization\/roleAssignments$/.test(path)) {
      const f = eqFilter(url);
      return json(200, { value: armAssignments.filter((a) => !f || a.properties.principalId === f.value) });
    }
    if (
      method === 'PUT' &&
      (m = /^(\/subscriptions\/[^/]+)\/providers\/Microsoft\.Authorization\/roleAssignments\/([^/]+)$/.exec(
        path,
      ))
    ) {
      const props = body!.properties as Json;
      armAssignments.push({ id: path, name: m[2]!, properties: { ...props, scope: m[1]! } });
      return json(201, {});
    }
    return json(400, {
      error: { code: 'Unhandled', message: `fake ARM does not implement ${method} ${path}` },
    });
  }

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.host}${decodeURIComponent(url.pathname)}`);
    const body =
      typeof init?.body === 'string' && init.body.startsWith('{')
        ? (JSON.parse(init.body) as Json)
        : undefined;
    if (url.host === 'login.microsoftonline.com') {
      if (url.pathname.endsWith('/oauth2/v2.0/token')) return token(new URLSearchParams(String(init?.body)));
      if (url.pathname.endsWith('/openid-configuration'))
        return json(200, {
          authorization_endpoint: `https://login.microsoftonline.com/${opts.tenantId}/oauth2/v2.0/authorize`,
        });
    }
    if (url.host === 'graph.microsoft.com') return graph(method, url, body, init);
    if (url.host === 'management.azure.com') return arm(method, url, body);
    throw new Error(`fake cloud: unexpected host ${url.host}`);
  };

  return {
    fetch: fetchImpl as typeof fetch,
    apps,
    sps,
    groups,
    users,
    grants,
    assignments,
    members,
    roleAssignments,
    armAssignments,
    owners,
    revoked,
    calls,
    secrets,
    authMethodsPolicy,
  };
}
