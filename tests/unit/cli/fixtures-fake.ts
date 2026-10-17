import { randomUUID } from 'node:crypto';
import type { FixtureKey } from '@adminforge/cli/src/provision/fixtures-model';
import { createFakeCloud, type FakeCloudOptions } from './fake-cloud';

/**
 * The fake cloud (fake-cloud.ts) plus the Microsoft Graph endpoints the licensed test fixtures use: subscriptions and
 * `assignLicense`, the organisation's country, PIM eligibility requests and schedules, named locations, Intune
 * compliance policies and configuration profiles (with assignments), Conditional Access policies (stored and answered
 * the way Graph does: every list present, unset parts null, the authentication strength expanded), and deleting users.
 * `forbid` makes a fixture's endpoints answer 403, like a provisioner without the Graph application permission.
 * Synthetic data only.
 */

type Json = Record<string, unknown>;

export interface FakeSku {
  skuId: string;
  skuPartNumber: string;
  capabilityStatus?: string;
  consumedUnits?: number;
  enabled?: number;
}

export interface FixturesCloudOptions extends FakeCloudOptions {
  skus?: FakeSku[];
  /** Fixtures whose Graph endpoints answer 403 (reads and writes). */
  forbid?: FixtureKey[];
  /** The organisation's countryLetterCode (default US). */
  country?: string;
  /** When false, eligibility without expiration is refused with an ExpirationRule error. Default true. */
  permanentEligibility?: boolean;
  /** Conditional Access policy names whose create Graph rejects (400), to show one failure doesn't stop the rest. */
  caReject?: string[];
  /**
   * Like a provisioner without Application.Read.All: a policy with an application condition (an app id, not "All")
   * is refused 403, with Graph's message naming the scope.
   */
  caNoApplicationRead?: boolean;
  /**
   * Answer the next `times` Conditional Access writes with 429 (Retry-After), calling `then` on each — e.g. to switch a
   * policy on meanwhile, like an administrator.
   */
  caThrottle?: { times: number; then?: () => void };
  /** A PATCH that answers 204 but changes nothing (to show the read-back after an update catches it). */
  caPatchNoop?: boolean;
}

/** Like Graph's PATCH: nested objects are merged, anything else (lists, null, text) replaced. */
export function mergePatch(target: Json, patch: Json): Json {
  const out: Json = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const t = out[k];
    const plain = (x: unknown): x is Json => !!x && typeof x === 'object' && !Array.isArray(x);
    out[k] = plain(v) && plain(t) ? mergePatch(t, v) : v;
  }
  return out;
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const graphError = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });

/** A Conditional Access policy the way Graph answers it: every list present, unset parts null. */
export function asGraphStores(p: Json): Json {
  const c = (p.conditions ?? {}) as Json;
  const users = (c.users ?? {}) as Json;
  const apps = (c.applications ?? {}) as Json;
  const grant = p.grantControls as Json | null | undefined;
  const session = p.sessionControls as Json | null | undefined;
  const strength = grant?.authenticationStrength as Json | undefined;
  return {
    displayName: p.displayName,
    state: p.state,
    conditions: {
      userRiskLevels: [],
      signInRiskLevels: [],
      servicePrincipalRiskLevels: [],
      platforms: null,
      locations: null,
      devices: null,
      clientApplications: null,
      ...c,
      users: {
        includeUsers: [],
        excludeUsers: [],
        includeGroups: [],
        excludeGroups: [],
        includeRoles: [],
        excludeRoles: [],
        includeGuestsOrExternalUsers: null,
        excludeGuestsOrExternalUsers: null,
        ...users,
      },
      applications: {
        includeApplications: [],
        excludeApplications: [],
        includeUserActions: [],
        includeAuthenticationContextClassReferences: [],
        applicationFilter: null,
        ...apps,
      },
    },
    grantControls: grant
      ? {
          builtInControls: [],
          customAuthenticationFactors: [],
          termsOfUse: [],
          ...grant,
          authenticationStrength: strength
            ? { ...strength, displayName: 'Phishing-resistant MFA', policyType: 'builtIn' }
            : null,
        }
      : null,
    sessionControls: session
      ? {
          disableResilienceDefaults: null,
          applicationEnforcedRestrictions: null,
          cloudAppSecurity: null,
          persistentBrowser: null,
          ...session,
          signInFrequency: session.signInFrequency
            ? { value: null, type: null, ...(session.signInFrequency as Json) }
            : null,
        }
      : null,
  };
}

export function createFixturesCloud(opts: FixturesCloudOptions) {
  const cloud = createFakeCloud(opts);
  const skus = (opts.skus ?? []).map((s) => ({
    capabilityStatus: 'Enabled',
    consumedUnits: 0,
    enabled: 25,
    ...s,
  }));
  const eligibility: Array<{
    principalId: string;
    roleDefinitionId: string;
    directoryScopeId: string;
    expiration: Json;
  }> = [];
  const namedLocations: Json[] = [];
  /** Conditional Access policies, as Graph stores them. */
  const caPolicies: Json[] = [];
  const intune: Record<'deviceCompliancePolicies' | 'deviceConfigurations', Json[]> = {
    deviceCompliancePolicies: [],
    deviceConfigurations: [],
  };
  /** Assignment targets per policy id, as Graph stores them (`@odata.type`, groupId). */
  const policyAssignments = new Map<string, Json[]>();
  const forbid = new Set(opts.forbid ?? []);
  /** Group members that aren't users (devices, groups): add them with `addMember`. */
  const extraMembers: Json[] = [];
  const denied = () =>
    graphError(403, 'Authorization_RequestDenied', 'Insufficient privileges to complete the operation.');

  /** Graph's own checks on a Conditional Access policy create or update (seen live). */
  function caRefusal(p: Json): Response | undefined {
    const c = (p.conditions ?? {}) as Json;
    const users = (c.users ?? {}) as Record<string, unknown[] | undefined>;
    const apps = ((c.applications ?? {}) as Json).includeApplications as string[] | undefined;
    if (opts.caNoApplicationRead && (apps ?? []).some((a) => a !== 'All'))
      return graphError(
        403,
        'AccessDenied',
        'Insufficient privileges to create or update policy. Application.Read.All scope is required to add/edit application condition.',
      );
    const grant = (p.grantControls ?? {}) as { builtInControls?: string[] };
    const excludes = ['excludeUsers', 'excludeGroups', 'excludeRoles'].some((k) => (users[k] ?? []).length);
    if ((users.includeUsers ?? []).includes('All') && grant.builtInControls?.includes('block') && !excludes)
      return graphError(
        400,
        'BadRequest',
        '1032: ConditionalActionPolicy validation failed due to BlockEveryonePolicy.',
      );
    return undefined;
  }

  function handle(method: string, path: string, body: Json | undefined): Response | undefined {
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/subscribedSkus')
      return json(200, {
        value: skus.map((s) => ({
          skuId: s.skuId,
          skuPartNumber: s.skuPartNumber,
          capabilityStatus: s.capabilityStatus,
          consumedUnits: s.consumedUnits,
          prepaidUnits: { enabled: s.enabled },
          servicePlans: [],
        })),
      });
    if (method === 'GET' && path === '/organization')
      return json(200, { value: [{ countryLetterCode: opts.country ?? 'US' }] });
    if ((m = /^\/users\/([^/]+)\/assignLicense$/.exec(path)) && method === 'POST') {
      if (forbid.has('licences')) return denied();
      const user = cloud.users.find((u) => u.id === m![1]);
      if (!user) return graphError(404, 'Request_ResourceNotFound', 'no such user');
      if (!user.usageLocation)
        return graphError(
          400,
          'Request_BadRequest',
          'License assignment failed because service plans require usage location.',
        );
      const add = (body!.addLicenses as Json[]).map((l) => String(l.skuId));
      const remove = (body!.removeLicenses as string[]).map(String);
      const current = ((user.assignedLicenses as Json[] | undefined) ?? []).map((l) => String(l.skuId));
      user.assignedLicenses = [...new Set([...current, ...add])]
        .filter((s) => !remove.includes(s))
        .map((skuId) => ({ skuId }));
      for (const id of add) {
        const sku = skus.find((s) => s.skuId === id);
        if (sku && !current.includes(id)) sku.consumedUnits++;
      }
      for (const id of remove) {
        const sku = skus.find((s) => s.skuId === id);
        if (sku && current.includes(id)) sku.consumedUnits--;
      }
      return json(200, { id: user.id });
    }
    if ((m = /^\/users\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      const i = cloud.users.findIndex((u) => u.id === m![1]);
      if (i < 0) return graphError(404, 'Request_ResourceNotFound', 'no such user');
      cloud.users.splice(i, 1);
      return json(204);
    }
    if (path.startsWith('/roleManagement/directory/roleEligibility')) {
      if (forbid.has('pim')) return denied();
      if (method === 'GET' && path === '/roleManagement/directory/roleEligibilitySchedules') return undefined;
      if (method === 'POST' && path === '/roleManagement/directory/roleEligibilityScheduleRequests') {
        const req = body as {
          action: string;
          principalId: string;
          roleDefinitionId: string;
          directoryScopeId: string;
          scheduleInfo?: { expiration?: Json };
        };
        const i = eligibility.findIndex(
          (e) =>
            e.principalId === req.principalId &&
            e.roleDefinitionId === req.roleDefinitionId &&
            e.directoryScopeId === req.directoryScopeId,
        );
        if (req.action === 'adminRemove') {
          if (i < 0)
            return graphError(400, 'RoleAssignmentDoesNotExist', 'The Role assignment does not exist.');
          eligibility.splice(i, 1);
          return json(201, { id: randomUUID(), status: 'Revoked' });
        }
        if (i >= 0) return graphError(400, 'RoleAssignmentExists', 'The Role assignment already exists.');
        const expiration = req.scheduleInfo?.expiration ?? {};
        if (opts.permanentEligibility === false && expiration.type === 'noExpiration')
          return graphError(
            400,
            'RoleAssignmentRequestPolicyValidationFailed',
            'The following policy rules failed: ["ExpirationRule"]',
          );
        eligibility.push({
          principalId: req.principalId,
          roleDefinitionId: req.roleDefinitionId,
          directoryScopeId: req.directoryScopeId,
          expiration,
        });
        return json(201, { id: randomUUID(), status: 'Provisioned' });
      }
    }
    if (path.startsWith('/identity/conditionalAccess/namedLocations')) {
      if (forbid.has('named-location')) return denied();
      if (method === 'GET' && path === '/identity/conditionalAccess/namedLocations')
        return json(200, { value: namedLocations });
      if (method === 'POST' && path === '/identity/conditionalAccess/namedLocations') {
        const created = { id: randomUUID(), ...body };
        namedLocations.push(created);
        return json(201, created);
      }
      if (
        (m = /^\/identity\/conditionalAccess\/namedLocations\/([^/]+)$/.exec(path)) &&
        method === 'DELETE'
      ) {
        const i = namedLocations.findIndex((l) => l.id === m![1]);
        if (i < 0) return graphError(404, 'Request_ResourceNotFound', 'no such location');
        // Like Graph: a location a Conditional Access policy still refers to can't be deleted.
        if (
          JSON.stringify(caPolicies.map((p) => (p.conditions as Json | undefined)?.locations)).includes(
            m![1]!,
          )
        )
          return graphError(
            400,
            'BadRequest',
            'The named location is referenced by a Conditional Access policy.',
          );
        namedLocations.splice(i, 1);
        return json(204);
      }
    }
    if (
      (m =
        /^\/deviceManagement\/(deviceCompliancePolicies|deviceConfigurations)(?:\/([^/]+))?(?:\/(assign|assignments))?$/.exec(
          path,
        ))
    ) {
      if (forbid.has('intune')) return denied();
      const list = intune[m[1] as keyof typeof intune];
      const id = m[2];
      if (!id && method === 'GET') return json(200, { value: list });
      if (!id && method === 'POST') {
        const created = { id: randomUUID(), ...body };
        list.push(created);
        return json(201, created);
      }
      if (id && m[3] === 'assignments' && method === 'GET')
        return json(200, {
          value: (policyAssignments.get(id) ?? []).map((target) => ({ id: randomUUID(), target })),
        });
      if (id && m[3] === 'assign' && method === 'POST') {
        // Like Graph: `assign` replaces every assignment of the policy.
        policyAssignments.set(
          id,
          (body!.assignments as Array<{ target: Json }>).map((a) => a.target),
        );
        return json(200, { value: [] });
      }
      if (id && !m[3] && method === 'DELETE') {
        const i = list.findIndex((p) => p.id === id);
        if (i < 0) return graphError(404, 'ResourceNotFound', 'no such policy');
        list.splice(i, 1);
        policyAssignments.delete(id);
        return json(204);
      }
    }
    if (path.startsWith('/identity/conditionalAccess/policies')) {
      if (forbid.has('ca-audit')) return denied();
      const id = /^\/identity\/conditionalAccess\/policies\/([^/]+)$/.exec(path)?.[1];
      if (!id && method === 'GET') return json(200, { value: caPolicies });
      if (method !== 'GET' && opts.caThrottle && opts.caThrottle.times > 0) {
        opts.caThrottle.times--;
        opts.caThrottle.then?.();
        return new Response(
          JSON.stringify({ error: { code: 'TooManyRequests', message: 'Too many requests.' } }),
          {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '1' },
          },
        );
      }
      const refused = body && caRefusal(body);
      if (refused) return refused;
      if (!id && method === 'POST') {
        if (opts.caReject?.includes(String(body!.displayName)))
          return graphError(400, 'BadRequest', '1054: Invalid policy for this tenant.');
        const created = { id: randomUUID(), ...asGraphStores(body!) };
        caPolicies.push(created);
        return json(201, created);
      }
      const i = caPolicies.findIndex((p) => p.id === id);
      if (i < 0) return graphError(404, 'ResourceNotFound', 'no such policy');
      if (method === 'GET') return json(200, caPolicies[i]);
      if (method === 'PATCH') {
        if (opts.caPatchNoop) return json(204);
        // Graph merges nested objects: a list the PATCH leaves out keeps its old value.
        caPolicies[i] = { id: caPolicies[i]!.id, ...asGraphStores(mergePatch(caPolicies[i]!, body!)) };
        return json(204);
      }
      if (method === 'DELETE') {
        caPolicies.splice(i, 1);
        return json(204);
      }
    }
    if ((m = /^\/groups\/([^/]+)\/members$/.exec(path)) && method === 'GET') {
      const ids = cloud.members.filter((x) => x.groupId === m![1]).map((x) => x.memberId);
      return json(200, {
        value: ids.map((id) => {
          const user = cloud.users.find((u) => u.id === id);
          const extra = extraMembers.find((x) => x.id === id);
          return user
            ? {
                '@odata.type': '#microsoft.graph.user',
                id,
                displayName: user.displayName,
                userPrincipalName: user.userPrincipalName,
                employeeType: user.employeeType ?? null,
              }
            : (extra ?? { '@odata.type': '#microsoft.graph.group', id });
        }),
      });
    }
    return undefined;
  }

  /** PIM schedules: answered here (filtered by principal), read after the request handler above. */
  function schedules(url: URL): Response {
    const m = /^principalId eq '([^']+)'$/.exec(url.searchParams.get('$filter') ?? '');
    return json(200, {
      value: eligibility
        .filter((e) => !m || e.principalId === m[1])
        .map((e) => ({
          id: randomUUID(),
          roleDefinitionId: e.roleDefinitionId,
          directoryScopeId: e.directoryScopeId,
        })),
    });
  }

  const inner = cloud.fetch;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.host !== 'graph.microsoft.com') return inner(input, init);
    const method = init?.method ?? 'GET';
    const path = decodeURIComponent(url.pathname.replace(/^\/(v1\.0|beta)/, ''));
    const body =
      typeof init?.body === 'string' && init.body.startsWith('{')
        ? (JSON.parse(init.body) as Json)
        : undefined;
    let res = handle(method, path, body);
    if (!res && method === 'GET' && path === '/roleManagement/directory/roleEligibilitySchedules')
      res = forbid.has('pim') ? denied() : schedules(url);
    if (!res) return inner(input, init);
    cloud.calls.push(`${method} ${url.host}${decodeURIComponent(url.pathname)}`);
    return res;
  };

  return {
    ...cloud,
    fetch: fetchImpl as typeof fetch,
    skus,
    eligibility,
    namedLocations,
    intune,
    policyAssignments,
    caPolicies,
    /** Adds a non-user member (a device or group) to a group. */
    addMember(groupId: string, member: Json & { id: string }) {
      extraMembers.push(member);
      cloud.members.push({ groupId, memberId: member.id });
    },
  };
}
