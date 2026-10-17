import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { createFixturesCloud, type FixturesCloudOptions } from './fixtures-fake';

/**
 * The fixtures cloud (fixtures-fake.ts) plus the Microsoft Graph endpoints of the enterprise test fixtures
 * (`directory`, `apps`, `auth-methods`, `intune-more`, `sign-ins`): user lists by mail, managers, invitations, group
 * licences and deletes, administrative units, app owners, deletes and certificate expiry, the non-gallery SAML
 * template and its signing certificates, phone and Temporary Access Pass methods, app protection policies. Stored and
 * answered the way Graph does where it matters (a certificate's end date comes from the certificate; a TAP's code is
 * returned once and never stored). Synthetic data only.
 */

type Json = Record<string, unknown>;
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const graphError = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });

export interface EnterpriseCloudOptions extends FixturesCloudOptions {
  /** Service plans of every SKU (name → id). */
  plans?: Record<string, string>;
  /**
   * Refuse invitations: true = 403 "Guest invitations not allowed" (a new tenant's limits), 401 = "Insufficient
   * privileges" (a provisioner without User.Invite.All).
   */
  forbidInvitations?: boolean | 401;
  /** `authorizationPolicy.allowInvitesFrom` (default everyone). */
  invitesFrom?: string;
  /** Refuse marking a just-invited guest (PATCH employeeType on a guest answers 400). */
  failGuestMark?: boolean;
  /** Refuse marking the just-instantiated SAML app (PATCH notes on a template app answers 400). */
  failSamlMark?: boolean;
}

export function createEnterpriseCloud(opts: EnterpriseCloudOptions) {
  const cloud = createFixturesCloud(opts);
  // The provisioner's own service principal (Graph makes it an owner of the Microsoft 365 groups it creates).
  cloud.sps.push({ id: randomUUID(), appId: opts.provisioner.clientId, displayName: 'Provisioner' });
  const aus: Array<Json & { id: string; memberIds: string[] }> = [];
  const phones = new Map<string, Json[]>();
  const taps = new Map<string, Json[]>();
  /** Every TAP code Graph returned (to check none reaches the output). */
  const tapCodes: string[] = [];
  const managers = new Map<string, string>();
  /** Guest id → sponsor ids. */
  const sponsors = new Map<string, string[]>();
  const appProtections: Record<string, Json[]> = {
    iosManagedAppProtections: [],
    androidManagedAppProtections: [],
  };
  const appProtectionAssignments = new Map<string, Json[]>();
  const plans = opts.plans ?? { SWAY: randomUUID() };

  function handle(method: string, path: string, url: URL, body: Json | undefined): Response | undefined {
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/subscribedSkus')
      return json(200, {
        value: cloud.skus.map((s) => ({
          skuId: s.skuId,
          skuPartNumber: s.skuPartNumber,
          capabilityStatus: s.capabilityStatus,
          consumedUnits: s.consumedUnits,
          prepaidUnits: { enabled: s.enabled },
          servicePlans: Object.entries(plans).map(([servicePlanName, servicePlanId]) => ({
            servicePlanName,
            servicePlanId,
          })),
        })),
      });
    if (method === 'GET' && path === '/users') {
      // `mail eq '…'`, `userPrincipalName eq '…'`, or several joined with `or` (the guests' address or UPN).
      const filter = url.searchParams.get('$filter') ?? '';
      const clauses = [...filter.matchAll(/(\w+) eq '((?:[^']|'')*)'/g)].map((c): [string, string] => [
        c[1]!,
        c[2]!.replace(/''/g, "'").toLowerCase(),
      ]);
      return json(200, {
        value: cloud.users.filter(
          (u) =>
            !clauses.length ||
            clauses.some(([field, value]) => String(u[field] ?? '').toLowerCase() === value),
        ),
      });
    }
    if ((m = /^\/users\/([^/]+)\/sponsors$/.exec(path)) && method === 'GET')
      return json(200, { value: (sponsors.get(m[1]!) ?? []).map((id) => ({ id })) });
    if ((m = /^\/users\/([^/]+)\/sponsors\/\$ref$/.exec(path)) && method === 'POST') {
      const list = sponsors.get(m[1]!) ?? [];
      const id = String(body!['@odata.id']).split('/').pop()!;
      if (list.includes(id))
        return graphError(400, 'Request_BadRequest', 'One or more added object references already exist.');
      sponsors.set(m[1]!, [...list, id]);
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && path === '/policies/authorizationPolicy')
      return json(200, { allowInvitesFrom: opts.invitesFrom ?? 'everyone' });
    if (method === 'POST' && path === '/invitations') {
      if (opts.forbidInvitations === 401)
        return graphError(
          401,
          'Unauthorized',
          'Insufficient privileges to perform requested operation by the application.',
        );
      if (opts.forbidInvitations)
        return graphError(
          403,
          'Authorization_RequestDenied',
          'Guest invitations not allowed for your company.',
        );
      const id = randomUUID();
      const email = String(body!.invitedUserEmailAddress);
      cloud.users.push({
        id,
        userPrincipalName: `${email.replace('@', '_')}#EXT#@example.com`,
        displayName: body!.invitedUserDisplayName,
        mail: email,
        userType: 'Guest',
        externalUserState: 'PendingAcceptance',
      });
      return json(201, { invitedUser: { id }, status: 'PendingAcceptance' });
    }
    if (opts.failGuestMark && (m = /^\/users\/([^/]+)$/.exec(path)) && method === 'PATCH') {
      const u = cloud.users.find((x) => x.id === m![1]);
      if (u?.userType === 'Guest' && body?.employeeType)
        return graphError(400, 'Request_BadRequest', 'Property employeeType could not be set.');
    }
    if (opts.failSamlMark && (m = /^\/applications\/([^/]+)$/.exec(path)) && method === 'PATCH') {
      const a = cloud.apps.find((x) => x.id === m![1]);
      if (a?.fromTemplate && body?.notes)
        return graphError(400, 'Request_BadRequest', 'Property notes could not be set.');
    }
    if ((m = /^\/users\/([^/]+)\/manager$/.exec(path)) && method === 'GET') {
      const id = managers.get(m[1]!);
      return id ? json(200, { id }) : graphError(404, 'Request_ResourceNotFound', 'no manager');
    }
    if ((m = /^\/users\/([^/]+)\/manager\/\$ref$/.exec(path)) && method === 'PUT') {
      managers.set(m[1]!, String(body!['@odata.id']).split('/').pop()!);
      return json(204);
    }
    if ((m = /^\/groups\/([^/]+)\/assignLicense$/.exec(path)) && method === 'POST') {
      const g = cloud.groups.find((x) => x.id === m![1]);
      if (!g) return graphError(404, 'Request_ResourceNotFound', 'no such group');
      g.assignedLicenses = (body!.addLicenses as Json[]).map((l) => ({
        skuId: l.skuId,
        disabledPlans: l.disabledPlans,
      }));
      return json(200, { id: g.id });
    }
    if ((m = /^\/groups\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      const i = cloud.groups.findIndex((x) => x.id === m![1]);
      if (i < 0) return graphError(404, 'Request_ResourceNotFound', 'no such group');
      cloud.groups.splice(i, 1);
      return json(204);
    }
    if (path === '/directory/administrativeUnits') {
      if (method === 'GET') {
        const f = /^displayName eq '([^']*)'$/.exec(url.searchParams.get('$filter') ?? '');
        return json(200, {
          value: aus.filter((a) => !f || a.displayName === f[1]).map(({ memberIds: _m, ...a }) => a),
        });
      }
      if (method === 'POST') {
        const created = { id: randomUUID(), ...body, memberIds: [] as string[] };
        aus.push(created);
        return json(201, created);
      }
    }
    if ((m = /^\/directory\/administrativeUnits\/([^/]+)(\/members(\/\$ref)?)?$/.exec(path))) {
      const au = aus.find((a) => a.id === m![1]);
      if (!au) return graphError(404, 'Request_ResourceNotFound', 'no such unit');
      if (!m[2] && method === 'DELETE') {
        aus.splice(aus.indexOf(au), 1);
        return json(204);
      }
      if (m[2] && !m[3] && method === 'GET') return json(200, { value: au.memberIds.map((id) => ({ id })) });
      if (m[3] && method === 'POST') {
        const id = String(body!['@odata.id']).split('/').pop()!;
        if (au.memberIds.includes(id))
          return graphError(400, 'Request_BadRequest', 'One or more added object references already exist.');
        au.memberIds.push(id);
        return json(204);
      }
    }
    if ((m = /^\/applications\/([^/]+)\/owners\/\$ref$/.exec(path)) && method === 'POST') {
      const id = String(body!['@odata.id']).split('/').pop()!;
      cloud.owners.set(m[1]!, [...(cloud.owners.get(m[1]!) ?? []), id]);
      return json(204);
    }
    // Like Graph (seen live): the plain owners list leaves out service principal owners; the cast returns them.
    if (
      (m = /^\/groups\/([^/]+)\/owners(\/microsoft\.graph\.servicePrincipal)?$/.exec(path)) &&
      method === 'GET'
    ) {
      const isSp = (id: string) => cloud.sps.some((s) => s.id === id);
      const owners = cloud.owners.get(m[1]!) ?? [];
      return json(200, {
        value: owners.filter((id) => (m![2] ? isSp(id) : !isSp(id))).map((id) => ({ id })),
      });
    }
    if ((m = /^\/groups\/([^/]+)\/owners\/([^/]+)\/\$ref$/.exec(path)) && method === 'DELETE') {
      const list = cloud.owners.get(m[1]!) ?? [];
      if (!list.includes(m[2]!)) return graphError(404, 'Request_ResourceNotFound', 'not an owner');
      cloud.owners.set(
        m[1]!,
        list.filter((id) => id !== m![2]),
      );
      return json(204);
    }
    if ((m = /^\/applications\/([^/]+)\/owners\/([^/]+)\/\$ref$/.exec(path)) && method === 'DELETE') {
      const list = cloud.owners.get(m[1]!) ?? [];
      if (!list.includes(m[2]!)) return graphError(404, 'Request_ResourceNotFound', 'not an owner');
      cloud.owners.set(
        m[1]!,
        list.filter((id) => id !== m![2]),
      );
      return json(204);
    }
    if ((m = /^\/applications\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      const i = cloud.apps.findIndex((a) => a.id === m![1]);
      if (i < 0) return graphError(404, 'Request_ResourceNotFound', 'no such app');
      const [app] = cloud.apps.splice(i, 1);
      const sp = cloud.sps.findIndex((s) => s.appId === app!.appId);
      if (sp >= 0) cloud.sps.splice(sp, 1);
      return json(204);
    }
    if (
      (m = /^\/applications\/([^/]+)$/.exec(path)) &&
      method === 'PATCH' &&
      Array.isArray(body?.keyCredentials)
    ) {
      // Like Graph: a certificate credential's dates come from the certificate itself.
      const app = cloud.apps.find((a) => a.id === m![1]);
      if (!app) return graphError(404, 'Request_ResourceNotFound', 'no such app');
      app.keyCredentials = (body!.keyCredentials as Json[]).map(({ key, ...rest }) => {
        const cert = new X509Certificate(Buffer.from(String(key), 'base64'));
        return {
          keyId: randomUUID(),
          ...rest,
          startDateTime: new Date(cert.validFrom).toISOString(),
          endDateTime: new Date(cert.validTo).toISOString(),
          customKeyIdentifier: createHash('sha1').update(cert.raw).digest('base64'),
        };
      });
      return json(204);
    }
    if (
      method === 'POST' &&
      path === '/applicationTemplates/8adf8e6e-67b2-4cf2-a259-e3dc5476c621/instantiate'
    ) {
      const app = {
        id: randomUUID(),
        appId: randomUUID(),
        displayName: body!.displayName,
        passwordCredentials: [],
        keyCredentials: [],
        fromTemplate: true,
      };
      const sp = { id: randomUUID(), appId: app.appId, displayName: body!.displayName, keyCredentials: [] };
      cloud.apps.push(app);
      cloud.sps.push(sp);
      return json(201, { application: app, servicePrincipal: sp });
    }
    if ((m = /^\/servicePrincipals\/([^/]+)\/addTokenSigningCertificate$/.exec(path)) && method === 'POST') {
      const sp = cloud.sps.find((s) => s.id === m![1]);
      if (!sp) return graphError(404, 'Request_ResourceNotFound', 'no such service principal');
      const thumbprint = createHash('sha1').update(randomUUID()).digest('hex').toUpperCase();
      const cred = {
        endDateTime: body!.endDateTime,
        displayName: body!.displayName,
        customKeyIdentifier: thumbprint,
      };
      sp.keyCredentials = [
        ...((sp.keyCredentials as Json[] | undefined) ?? []),
        { keyId: randomUUID(), usage: 'Sign', ...cred },
        { keyId: randomUUID(), usage: 'Verify', ...cred },
      ];
      return json(200, { thumbprint, endDateTime: body!.endDateTime });
    }
    if (
      (m = /^\/users\/([^/]+)\/authentication\/(phoneMethods|temporaryAccessPassMethods)(?:\/([^/]+))?$/.exec(
        path,
      ))
    ) {
      const store = m[2] === 'phoneMethods' ? phones : taps;
      const list = store.get(m[1]!) ?? [];
      if (method === 'GET' && !m[3]) return json(200, { value: list });
      if (method === 'POST' && !m[3]) {
        const created: Json = {
          id: m[2] === 'phoneMethods' ? '3179e48a-750b-4051-897c-87b9720928f7' : randomUUID(),
          ...body,
        };
        store.set(m[1]!, [...list, created]);
        if (m[2] === 'temporaryAccessPassMethods') {
          const code = `tap-${randomUUID()}`;
          tapCodes.push(code);
          return json(201, { ...created, temporaryAccessPass: code });
        }
        return json(201, created);
      }
      if (method === 'DELETE' && m[3]) {
        const i = list.findIndex((x) => x.id === m![3]);
        if (i < 0) return graphError(404, 'Request_ResourceNotFound', 'no such method');
        list.splice(i, 1);
        return json(204);
      }
    }
    if (
      (m =
        /^\/deviceAppManagement\/(iosManagedAppProtections|androidManagedAppProtections)(?:\/([^/]+))?(?:\/(assign|assignments))?$/.exec(
          path,
        ))
    ) {
      const list = appProtections[m[1]!]!;
      const id = m[2];
      if (!id && method === 'GET') return json(200, { value: list });
      if (!id && method === 'POST') {
        const created = { id: randomUUID(), ...body };
        list.push(created);
        return json(201, created);
      }
      if (id && m[3] === 'assignments' && method === 'GET')
        return json(200, {
          value: (appProtectionAssignments.get(id) ?? []).map((target) => ({ id: randomUUID(), target })),
        });
      if (id && m[3] === 'assign' && method === 'POST') {
        appProtectionAssignments.set(
          id,
          (body!.assignments as Array<{ target: Json }>).map((a) => a.target),
        );
        return json(204);
      }
      if (id && !m[3] && method === 'DELETE') {
        const i = list.findIndex((p) => p.id === id);
        if (i < 0) return graphError(404, 'ResourceNotFound', 'no such policy');
        list.splice(i, 1);
        return json(204);
      }
    }
    return undefined;
  }

  /** The service principal of the app that made a request (from its token's appid). */
  const callerSp = (init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const appid = (
      JSON.parse(
        Buffer.from(auth.replace('Bearer ', '').split('.')[1] ?? '', 'base64url').toString() || '{}',
      ) as { appid?: string }
    ).appid;
    return cloud.sps.find((s) => s.appId === appid);
  };

  const inner = cloud.fetch;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.host !== 'graph.microsoft.com') return inner(input, init);
    const method = init?.method ?? 'GET';
    const path = decodeURIComponent(url.pathname.replace(/^\/(v1\.0|beta)/, ''));
    // Like Graph: a Microsoft 365 group created with application permissions gets the calling app as an owner.
    if (
      method === 'POST' &&
      path === '/groups' &&
      typeof init?.body === 'string' &&
      /"Unified"/.test(init.body)
    ) {
      const res = await inner(input, init);
      const created = (await res.clone().json()) as { id: string };
      const sp = callerSp(init);
      if (sp) cloud.owners.set(created.id, [...(cloud.owners.get(created.id) ?? []), sp.id as string]);
      return res;
    }
    const body =
      typeof init?.body === 'string' && init.body.startsWith('{')
        ? (JSON.parse(init.body) as Json)
        : undefined;
    const res = handle(method, path, url, body);
    if (!res) return inner(input, init);
    cloud.calls.push(`${method} ${url.host}${decodeURIComponent(url.pathname)}`);
    return res;
  };

  return {
    ...cloud,
    fetch: fetchImpl as typeof fetch,
    aus,
    phones,
    taps,
    tapCodes,
    managers,
    sponsors,
    appProtections,
    appProtectionAssignments,
    plans,
  };
}
