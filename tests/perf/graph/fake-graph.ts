/**
 * A fake Microsoft Graph over the synthetic tenant (tests/perf/tenant/generate.ts), for the perf suite and the load
 * test. In-process (`fetch`, which the outbound executor takes as its fetch) or over HTTP (`listen()`, node:http).
 *
 * It behaves like Graph where that changes cost or correctness: real paging (`@odata.nextLink` with `$skiptoken`, 100
 * by default, `$top` ≤ 999 on directory objects, at most 120 per page when `signInActivity` is selected), `$count`,
 * `/$count` and `$search` only with `ConsistencyLevel: eventual` (400 otherwise, as Graph does), advanced queries (ne,
 * not, endswith, `/$count` in a filter) on directory objects only with that header and `$count=true`, `$expand` of
 * owners/members (at most 20 members, as Graph caps it)/manager, `$batch` (≤ 20 requests), `getByIds`, the usage
 * reports as JSON, and server-side scanning of sign-in and audit logs with a work budget per page (pages can come back
 * short with a nextLink, like Graph's). Latency and throttling (429 + Retry-After) are configurable.
 *
 * Anything it doesn't model fails loudly: unknown query options or filter syntax answer 400, unknown paths 404 with
 * code `SyntheticNotModelled` (also counted in `stats.unmodelled`, so the perf report lists coverage gaps).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Collection, GraphObject } from '../tenant/collection';
import {
  EXCHANGE_APP_ID,
  GRAPH_APP_ID,
  NOW_ISO,
  SHAREPOINT_APP_ID,
  type SyntheticTenant,
} from '../tenant/generate';
import {
  evaluate,
  matchesSearch,
  ODataError,
  parseExpand,
  parseFilter,
  parseOrderBy,
  parseSearch,
  project,
  type EvalContext,
  type ExpandItem,
} from './odata';

export interface FakeGraphOptions {
  /** Added to every response (ms), plus up to `jitterMs`. */
  latencyMs?: number;
  jitterMs?: number;
  /** Every Nth request (counting all) answers 429 with Retry-After `retryAfterSec`. */
  throttleEvery?: number;
  retryAfterSec?: number;
  /** Rows scanned per page of a log (sign-ins, audits) before Graph answers what it found so far. */
  logScanBudget?: number;
}

export interface FakeGraphStats {
  requests: number;
  bytes: number;
  throttled: number;
  inFlight: number;
  maxInFlight: number;
  /** Time spent building answers (excluding the simulated latency), ms. */
  busyMs: number;
  errors: Record<number, number>;
  unmodelled: Map<string, number>;
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type Query = URLSearchParams;
const MAX_TOP_DIRECTORY = 999;
const MAX_TOP_OTHER = 1000;
const ALLOWED_OPTIONS = new Set([
  '$filter',
  '$select',
  '$top',
  '$count',
  '$search',
  '$orderby',
  '$expand',
  '$skiptoken',
  '$format',
  'search',
]);

const graphError = (status: number, code: string, message: string): Answer => ({
  status,
  headers: { 'content-type': 'application/json', 'request-id': 'synthetic' },
  body: JSON.stringify({
    error: { code, message, innerError: { date: NOW_ISO, 'request-id': 'synthetic' } },
  }),
});
const jsonAnswer = (body: unknown, status = 200, headers: Record<string, string> = {}): Answer => ({
  status,
  headers: { 'content-type': 'application/json;odata.metadata=minimal', ...headers },
  body: JSON.stringify(body),
});

interface CollectionDef {
  coll: Collection;
  directory: boolean;
  /** Time field of a scanned log (sign-ins, audits). */
  log?: boolean;
  defaultTop?: number;
  maxTop?: number;
  expand?: (obj: GraphObject, item: ExpandItem) => unknown;
  count?: EvalContext['count'];
  context: string;
}

export function createFakeGraph(tenant: SyntheticTenant, opts: FakeGraphOptions = {}) {
  const stats: FakeGraphStats = {
    requests: 0,
    bytes: 0,
    throttled: 0,
    inFlight: 0,
    maxInFlight: 0,
    busyMs: 0,
    errors: {},
    unmodelled: new Map(),
  };
  const t = tenant;
  const N = t.users.length;

  // --- indexes ---
  const indexOf = (list: GraphObject[]) => {
    const m = new Map<string, number>();
    list.forEach((o, i) => m.set(String(o.id).toLowerCase(), i));
    return m;
  };
  const userIx = indexOf(t.users);
  const groupIx = indexOf(t.groups);
  const appIx = indexOf(t.applications);
  const spIx = indexOf(t.servicePrincipals);
  const mdIx = indexOf(t.managedDevices);
  const devIx = indexOf(t.entraDevices);
  const spByAppId = new Map(t.servicePrincipals.map((s, i) => [String(s.appId).toLowerCase(), i]));
  const firstParty = t.servicePrincipals.findIndex((s) => s.appOwnerOrganizationId === t.organization.id);
  /** Group → groups that contain it (for transitive memberOf). */
  let parents: Map<number, number[]> | undefined;
  const parentGroups = () => {
    if (!parents) {
      parents = new Map();
      for (const [g, kids] of t.nestedGroups)
        for (const k of kids) (parents.get(k) ?? parents.set(k, []).get(k)!).push(g);
    }
    return parents;
  };
  const appOfSp = (sp: number) => sp - firstParty; // service principals after the first-party ones mirror applications

  const userBrief = (u: number) => ({ '@odata.type': '#microsoft.graph.user', ...t.users[u]! });
  const groupBrief = (g: number) => ({ '@odata.type': '#microsoft.graph.group', ...t.groups[g]! });

  const groupMemberCollection = (g: number, type?: string): Collection => {
    const m = t.groupUserMembers(g);
    const nested = t.nestedGroups.get(g) ?? [];
    const users = type === 'microsoft.graph.group' || type === 'microsoft.graph.device' ? 0 : m.count;
    const groups = type === 'microsoft.graph.user' || type === 'microsoft.graph.device' ? 0 : nested.length;
    return {
      size: users + groups,
      at: (i) => (i < users ? userBrief(m.at(i)) : groupBrief(nested[i - users]!)),
    };
  };
  const relationCount: EvalContext['count'] = (obj, relation) => {
    const id = String(obj.id).toLowerCase();
    if (relation === 'owners') {
      if (groupIx.has(id)) return t.groupOwners[groupIx.get(id)!]!.length;
      if (appIx.has(id)) return t.appOwners[appIx.get(id)!]!.length;
      if (spIx.has(id)) {
        const a = appOfSp(spIx.get(id)!);
        return a >= 0 ? t.appOwners[a]!.length : 0;
      }
    }
    if (relation === 'members' && groupIx.has(id)) return groupMemberCollection(groupIx.get(id)!).size;
    return undefined;
  };
  const expandFor =
    (kind: 'user' | 'group' | 'application' | 'servicePrincipal' | 'device' | 'intune') =>
    (obj: GraphObject, item: ExpandItem): unknown => {
      const id = String(obj.id).toLowerCase();
      const limited = (list: GraphObject[]) =>
        list.slice(0, item.top ?? list.length).map((o) => project(o, item.select));
      if (kind === 'user' && item.name === 'manager') {
        const m = t.managerOf[userIx.get(id)!]!;
        return m >= 0 ? project(userBrief(m), item.select) : null;
      }
      if (item.name === 'owners') {
        const owners =
          kind === 'group'
            ? t.groupOwners[groupIx.get(id)!]!
            : kind === 'application'
              ? t.appOwners[appIx.get(id)!]!
              : kind === 'servicePrincipal'
                ? (t.appOwners[appOfSp(spIx.get(id)!)] ?? [])
                : undefined;
        if (!owners) throw new ODataError(`$expand=owners isn't supported on this collection`);
        return limited(owners.map(userBrief));
      }
      if (kind === 'group' && item.name === 'members') {
        const c = groupMemberCollection(groupIx.get(id)!);
        // Graph returns at most 20 expanded members
        return limited(Array.from({ length: Math.min(20, c.size) }, (_, i) => c.at(i)));
      }
      if (kind === 'device' && (item.name === 'registeredOwners' || item.name === 'registeredUsers')) {
        const d = devIx.get(id)!;
        return d < t.managedDevices.length ? limited([userBrief(t.deviceOwner[d]!)]) : [];
      }
      if (
        kind === 'intune' &&
        (item.name === 'assignments' || item.name === 'settings' || item.name === 'scheduledActionsForRule')
      )
        return (obj[item.name] as unknown[]) ?? [];
      if (kind === 'user' && item.name === 'memberOf')
        return limited(t.userGroups(userIx.get(id)!).slice(0, 20).map(groupBrief));
      throw new ODataError(`$expand=${item.name} is not modelled for ${kind}`, 'SyntheticNotModelled');
    };

  const mat = (items: GraphObject[]): Collection => ({ size: items.length, at: (i) => items[i]! });
  const def = (coll: Collection, context: string, extra: Partial<CollectionDef> = {}): CollectionDef => ({
    coll,
    directory: false,
    context,
    ...extra,
  });
  const dir = (coll: Collection, context: string, kind: Parameters<typeof expandFor>[0]) =>
    def(coll, context, {
      directory: true,
      expand: expandFor(kind),
      count: relationCount,
      defaultTop: 100,
      maxTop: MAX_TOP_DIRECTORY,
    });

  const roleAssignmentRow = (a: GraphObject): GraphObject => ({
    ...a,
    roleDefinition: t.roleDefinitions.find((r) => r.id === a.roleDefinitionId),
    principal: principal(String(a.principalId)),
  });
  const principal = (id: string) => {
    const hit = t.ids.get(id);
    return hit ? { '@odata.type': `#microsoft.graph.${hit.kind}`, ...hit.object } : null;
  };

  const collections: Record<string, CollectionDef> = {
    '/users': dir(mat(t.users), 'users', 'user'),
    '/groups': dir(mat(t.groups), 'groups', 'group'),
    '/devices': dir(mat(t.entraDevices), 'devices', 'device'),
    '/applications': dir(mat(t.applications), 'applications', 'application'),
    '/servicePrincipals': dir(mat(t.servicePrincipals), 'servicePrincipals', 'servicePrincipal'),
    '/deviceManagement/managedDevices': def(mat(t.managedDevices), 'deviceManagement/managedDevices', {
      defaultTop: 1000,
      maxTop: MAX_TOP_OTHER,
      expand: expandFor('intune'),
    }),
    '/auditLogs/signIns': def(t.signIns, 'auditLogs/signIns', { log: true, defaultTop: 1000, maxTop: 1000 }),
    '/auditLogs/directoryAudits': def(t.directoryAudits, 'auditLogs/directoryAudits', {
      log: true,
      defaultTop: 1000,
      maxTop: 1000,
    }),
    '/identityProtection/riskyUsers': def(mat(t.riskyUsers), 'identityProtection/riskyUsers', {
      defaultTop: 20,
      maxTop: 500,
    }),
    '/identityProtection/riskDetections': def(t.riskDetections, 'identityProtection/riskDetections', {
      defaultTop: 1000,
      maxTop: 1000,
    }),
    '/reports/authenticationMethods/userRegistrationDetails': def(
      t.userRegistrationDetails,
      'reports/authenticationMethods/userRegistrationDetails',
      { defaultTop: 1000, maxTop: 1000 },
    ),
    '/oauth2PermissionGrants': def(t.oauth2PermissionGrants, 'oauth2PermissionGrants', {
      defaultTop: 100,
      maxTop: 999,
    }),
    '/subscribedSkus': def(mat(t.subscribedSkus), 'subscribedSkus'),
    '/domains': def(mat(t.domains), 'domains'),
    '/organization': def(mat([t.organization]), 'organization'),
    '/roleManagement/directory/roleDefinitions': def(
      mat(t.roleDefinitions),
      'roleManagement/directory/roleDefinitions',
    ),
    '/roleManagement/directory/roleAssignments': def(
      { size: t.roleAssignments.length, at: (i) => roleAssignmentRow(t.roleAssignments[i]!) },
      'roleManagement/directory/roleAssignments',
      {
        expand: (obj, item) =>
          item.name === 'principal' || item.name === 'roleDefinition'
            ? obj[item.name]
            : expandFor('intune')(obj, item),
      },
    ),
    '/roleManagement/directory/roleAssignmentScheduleInstances': def(
      {
        size: t.roleAssignments.length,
        at: (i) => ({
          ...roleAssignmentRow(t.roleAssignments[i]!),
          assignmentType: i % 10 === 0 ? 'Activated' : 'Assigned',
          memberType: 'Direct',
          startDateTime: null,
          endDateTime: i % 10 === 0 ? NOW_ISO : null,
        }),
      },
      'roleManagement/directory/roleAssignmentScheduleInstances',
      { expand: (obj, item) => obj[item.name] ?? null },
    ),
    '/roleManagement/directory/roleEligibilityScheduleInstances': def(
      { size: t.roleEligibilities.length, at: (i) => roleAssignmentRow(t.roleEligibilities[i]!) },
      'roleManagement/directory/roleEligibilityScheduleInstances',
      { expand: (obj, item) => obj[item.name] ?? null },
    ),
    '/roleManagement/directory/roleAssignmentScheduleRequests': def(
      {
        size: Math.min(500, t.roleAssignments.length),
        at: (i) => ({
          ...roleAssignmentRow(t.roleAssignments[i]!),
          action: 'selfActivate',
          status: 'Provisioned',
          createdDateTime: NOW_ISO,
          justification: 'Synthetic activation',
        }),
      },
      'roleManagement/directory/roleAssignmentScheduleRequests',
      { expand: (obj, item) => obj[item.name] ?? null },
    ),
    '/deviceManagement/deviceCompliancePolicies': def(
      mat(t.compliancePolicies),
      'deviceManagement/deviceCompliancePolicies',
      { expand: expandFor('intune') },
    ),
    '/deviceManagement/deviceConfigurations': def(
      mat(t.deviceConfigurations),
      'deviceManagement/deviceConfigurations',
      { expand: expandFor('intune') },
    ),
    '/deviceManagement/configurationPolicies': def(
      mat(t.configurationPolicies),
      'deviceManagement/configurationPolicies',
      { defaultTop: 25, maxTop: 1000 },
    ),
    '/deviceManagement/windowsAutopilotDeviceIdentities': def(
      t.autopilotDevices,
      'deviceManagement/windowsAutopilotDeviceIdentities',
      { defaultTop: 1000, maxTop: 1000 },
    ),
    '/deviceManagement/deviceCompliancePolicySettingStateSummaries': def(
      mat(t.settingStateSummaries),
      'deviceManagement/deviceCompliancePolicySettingStateSummaries',
    ),
    '/deviceAppManagement/mobileApps': def(mat(t.mobileApps), 'deviceAppManagement/mobileApps', {
      expand: expandFor('intune'),
    }),
    '/teams': def({ size: t.teams.length, at: (i) => teamOf(t.teams[i]!) }, 'teams', {
      defaultTop: 100,
      maxTop: 999,
    }),
    '/admin/serviceAnnouncement/issues': def(mat(t.serviceIssues), 'admin/serviceAnnouncement/issues', {
      defaultTop: 100,
      maxTop: 1000,
    }),
    '/admin/serviceAnnouncement/messages': def(mat(t.serviceMessages), 'admin/serviceAnnouncement/messages', {
      defaultTop: 100,
      maxTop: 1000,
    }),
    '/admin/serviceAnnouncement/healthOverviews': def(
      mat(t.healthOverviews),
      'admin/serviceAnnouncement/healthOverviews',
    ),
    '/identity/conditionalAccess/policies': def(mat(t.caPolicies), 'identity/conditionalAccess/policies'),
    '/identity/conditionalAccess/namedLocations': def(
      mat(t.namedLocations),
      'identity/conditionalAccess/namedLocations',
    ),
    '/directory/subscriptions': def(
      mat(
        t.subscribedSkus.map((s, k) => ({
          id: `sub-${k}`,
          commerceSubscriptionId: `cs-${k}`,
          skuId: s.skuId,
          skuPartNumber: s.skuPartNumber,
          status: s.capabilityStatus,
          totalLicenses: (s.prepaidUnits as { enabled: number }).enabled,
          isTrial: k === 6,
          createdDateTime: '2024-01-01T00:00:00Z',
          nextLifecycleDateTime: new Date(Date.parse(NOW_ISO) + (k + 1) * 20 * 86_400_000).toISOString(),
          ownerType: null,
          ownerId: null,
        })),
      ),
      'directory/subscriptions',
    ),
    '/deviceAppManagement/vppTokens': def(
      mat([
        {
          id: 'vpp-1',
          organizationName: 'Example Org',
          appleId: 'vpp@example.com',
          state: 'valid',
          expirationDateTime: '2026-11-01T00:00:00Z',
          lastSyncDateTime: NOW_ISO,
          lastSyncStatus: 'completed',
          displayName: 'Example VPP',
        },
      ]),
      'deviceAppManagement/vppTokens',
    ),
    '/deviceManagement/depOnboardingSettings': def(
      mat([
        {
          id: 'dep-1',
          appleIdentifier: 'dep@example.com',
          tokenExpirationDateTime: '2026-10-30T00:00:00Z',
          lastSuccessfulSyncDateTime: NOW_ISO,
          lastSyncErrorCode: 0,
          tokenName: 'Example ADE',
          syncedDeviceCount: 4200,
        },
      ]),
      'deviceManagement/depOnboardingSettings',
    ),
    '/informationProtection/bitlocker/recoveryKeys': def(
      t.bitlockerKeys,
      'informationProtection/bitlocker/recoveryKeys',
      { defaultTop: 1000, maxTop: 1000 },
    ),
  };

  function teamOf(g: number): GraphObject {
    const grp = t.groups[g]!;
    return {
      id: grp.id,
      displayName: grp.displayName,
      description: grp.description,
      visibility: grp.visibility === 'Public' ? 'public' : 'private',
      isArchived: g % 41 === 0,
      createdDateTime: grp.createdDateTime,
      webUrl: `https://teams.example.com/team/${grp.id}`,
    };
  }

  // --- the query engine ---
  const matchCache = new Map<string, Int32Array>();
  const cacheKey = (path: string, q: Query) =>
    `${path}?${['$filter', '$search', '$orderby'].map((k) => `${k}=${q.get(k) ?? ''}`).join('&')}`;

  function matchingIndexes(path: string, d: CollectionDef, q: Query): Int32Array {
    const key = cacheKey(path, q);
    const hit = matchCache.get(key);
    if (hit) return hit;
    const filter = q.has('$filter') ? parseFilter(q.get('$filter')!) : undefined;
    const search = q.has('$search') ? parseSearch(q.get('$search')!) : undefined;
    const out: number[] = [];
    for (let i = 0; i < d.coll.size; i++) {
      const o = d.coll.at(i);
      if (filter && evaluate(filter.expr, o, { count: d.count }) !== true) continue;
      if (search && !matchesSearch(o, search)) continue;
      out.push(i);
    }
    if (q.has('$orderby')) {
      const cmp = parseOrderBy(q.get('$orderby')!);
      out.sort((a, b) => cmp(d.coll.at(a), d.coll.at(b)));
    }
    const arr = Int32Array.from(out);
    if (matchCache.size > 200) matchCache.delete(matchCache.keys().next().value!);
    matchCache.set(key, arr);
    return arr;
  }

  function validate(q: Query, d: CollectionDef, headers: Headers, segmentCount: boolean): Answer | undefined {
    for (const k of q.keys())
      if (!ALLOWED_OPTIONS.has(k))
        return graphError(400, 'BadRequest', `Query option '${k}' is not allowed.`);
    const eventual = (headers.get('consistencylevel') ?? '').toLowerCase() === 'eventual';
    if (q.has('$top')) {
      const top = Number(q.get('$top'));
      if (!Number.isInteger(top) || top < 1)
        return graphError(400, 'BadRequest', `Invalid $top value '${q.get('$top')}'.`);
      if (top > (d.maxTop ?? MAX_TOP_OTHER))
        return graphError(
          400,
          'Request_UnsupportedQuery',
          `Invalid page size specified: '${top}'. Must be between 1 and ${d.maxTop ?? MAX_TOP_OTHER} inclusive.`,
        );
    }
    if (q.has('$search') && !eventual)
      return graphError(
        400,
        'Request_UnsupportedQuery',
        "Request with $search query parameter only works through MSGraph with a special request header: 'ConsistencyLevel: eventual'",
      );
    if (d.log && q.has('$count'))
      return graphError(400, 'BadRequest', '$count is not supported on this resource.');
    if (
      d.log &&
      q.has('$orderby') &&
      !/^\s*(createdDateTime|activityDateTime)(\s+desc)?\s*$/i.test(q.get('$orderby')!)
    )
      return graphError(
        400,
        'BadRequest',
        `$orderby is only supported on the time field: ${q.get('$orderby')}`,
      );
    if (d.directory) {
      const filter = q.has('$filter') ? parseFilter(q.get('$filter')!) : undefined;
      const countTrue = q.get('$count') === 'true';
      if ((segmentCount || countTrue) && !eventual)
        return graphError(
          400,
          'Request_BadRequest',
          'Count is not currently supported without the ConsistencyLevel header.',
        );
      if (filter?.needsAdvanced && !(eventual && (countTrue || segmentCount)))
        return graphError(
          400,
          'Request_UnsupportedQuery',
          `Unsupported query: '${q.get('$filter')}' needs ConsistencyLevel: eventual and $count=true (an advanced query).`,
        );
      if (q.has('$orderby') && q.has('$filter') && !(eventual && countTrue))
        return graphError(
          400,
          'Request_UnsupportedQuery',
          'Sorting with a filter needs ConsistencyLevel: eventual and $count=true.',
        );
    }
    return undefined;
  }

  /** Like Graph's: the request's own query (as sent) plus `$skiptoken=…`. */
  function nextLinkFor(url: URL, token: string): string {
    const kept = url.search
      .replace(/^\?/, '')
      .split('&')
      .filter((p) => p && !/^(%24|\$)skiptoken=/i.test(p));
    return `${url.origin}${url.pathname}?${[...kept, `$skiptoken=${token}`].join('&')}`;
  }

  function respondCollection(path: string, d: CollectionDef, url: URL, headers: Headers): Answer {
    const q = url.searchParams;
    const bad = validate(q, d, headers, false);
    if (bad) return bad;
    const select = q.get('$select')?.split(',').filter(Boolean);
    const expand = q.has('$expand') ? parseExpand(q.get('$expand')!) : [];
    let pageSize = Math.min(Number(q.get('$top') ?? d.defaultTop ?? 100), d.maxTop ?? MAX_TOP_OTHER);
    if (select?.includes('signInActivity')) pageSize = Math.min(pageSize, 120);
    const shape = (o: GraphObject) => {
      const out = project(o, select ? [...select, ...expand.map((e) => e.name)] : undefined);
      for (const e of expand)
        out[e.name] = d.expand
          ? d.expand(o, e)
          : (() => {
              throw new ODataError(`$expand=${e.name} is not modelled here`, 'SyntheticNotModelled');
            })();
      return out;
    };
    const body: GraphObject = { '@odata.context': `https://graph.microsoft.com/v1.0/$metadata#${d.context}` };
    const start = Number(q.get('$skiptoken') ?? 0);
    if (d.log) {
      // Graph scans the log server-side: bounded work per page, short pages, a nextLink while there is more to scan.
      const filter = q.has('$filter') ? parseFilter(q.get('$filter')!) : undefined;
      const timeField = path.endsWith('signIns') ? 'createdDateTime' : 'activityDateTime';
      const b = filter?.bounds.get(timeField);
      const [lo, hi] = d.coll.range?.(timeField, b?.from, b?.to) ?? [0, d.coll.size];
      const budget = opts.logScanBudget ?? d.coll.scanBudget ?? 250_000;
      const value: GraphObject[] = [];
      let i = Math.max(lo, start || lo);
      let scanned = 0;
      for (; i < hi && value.length < pageSize && scanned < budget; i++, scanned++) {
        const o = d.coll.at(i);
        if (!filter || evaluate(filter.expr, o) === true) value.push(shape(o));
      }
      body.value = value;
      if (i < hi) body['@odata.nextLink'] = nextLinkFor(url, String(i));
      return jsonAnswer(body);
    }
    const ix =
      q.has('$filter') || q.has('$search') || q.has('$orderby') ? matchingIndexes(path, d, q) : undefined;
    const total = ix ? ix.length : d.coll.size;
    if (q.get('$count') === 'true') body['@odata.count'] = total;
    const end = Math.min(total, start + pageSize);
    const value: GraphObject[] = [];
    for (let k = start; k < end; k++) value.push(shape(d.coll.at(ix ? ix[k]! : k)));
    body.value = value;
    if (end < total) body['@odata.nextLink'] = nextLinkFor(url, String(end));
    return jsonAnswer(body);
  }

  function respondCount(d: CollectionDef, url: URL, headers: Headers, path: string): Answer {
    const bad = validate(url.searchParams, d, headers, true);
    if (bad) return bad;
    const n =
      url.searchParams.has('$filter') || url.searchParams.has('$search')
        ? matchingIndexes(path, d, url.searchParams).length
        : d.coll.size;
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: String(n) };
  }

  function respondEntity(o: GraphObject | undefined | null, url: URL, d?: CollectionDef): Answer {
    if (!o)
      return graphError(
        404,
        'Request_ResourceNotFound',
        `Resource '${url.pathname}' does not exist or one of its queried reference-property objects are not present.`,
      );
    for (const k of url.searchParams.keys())
      if (!['$select', '$expand'].includes(k))
        return graphError(400, 'BadRequest', `Query option '${k}' is not allowed here.`);
    const select = url.searchParams.get('$select')?.split(',').filter(Boolean);
    const expand = url.searchParams.has('$expand') ? parseExpand(url.searchParams.get('$expand')!) : [];
    const out = project(o, select ? [...select, ...expand.map((e) => e.name)] : undefined);
    for (const e of expand) {
      if (!d?.expand) throw new ODataError(`$expand=${e.name} is not modelled here`, 'SyntheticNotModelled');
      out[e.name] = d.expand(o, e);
    }
    return jsonAnswer({ '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#entity', ...out });
  }

  const sub = (coll: Collection, context: string, extra: Partial<CollectionDef> = {}) =>
    def(coll, context, { defaultTop: 100, maxTop: 999, ...extra });
  const dirSub = (coll: Collection, context: string) =>
    sub(coll, context, { directory: true, count: relationCount, expand: expandFor('user') });

  /** Relations and entities under a collection: returns a collection def, an entity, or undefined (not modelled). */
  function resolveSub(
    segs: string[],
  ):
    | { kind: 'coll'; d: CollectionDef }
    | { kind: 'entity'; o: GraphObject | null; d?: CollectionDef }
    | { kind: 'count'; d: CollectionDef }
    | undefined {
    const [root, id, rel, cast, more] = segs;
    const castType = cast?.startsWith('microsoft.graph.') ? cast : undefined;
    const tail = castType ? more : cast;
    const lower = id?.toLowerCase() ?? '';
    const wantCount = rel === '$count' || tail === '$count';
    const as = (d: CollectionDef) =>
      wantCount ? ({ kind: 'count', d } as const) : ({ kind: 'coll', d } as const);
    if (root === 'users' && id) {
      const u = userIx.get(lower);
      if (u === undefined) return { kind: 'entity', o: null };
      if (!rel) return { kind: 'entity', o: t.users[u]!, d: collections['/users'] };
      if (rel === 'memberOf' || rel === 'transitiveMemberOf') {
        const direct = t.userGroups(u);
        const all =
          rel === 'transitiveMemberOf'
            ? [...new Set([...direct, ...direct.flatMap((g) => parentGroups().get(g) ?? [])])]
            : direct;
        return as(dirSub(mat(all.map(groupBrief)), 'directoryObjects'));
      }
      if (rel === 'manager') {
        const m = t.managerOf[u]!;
        return { kind: 'entity', o: m >= 0 ? userBrief(m) : null };
      }
      if (rel === 'directReports') {
        const reports: GraphObject[] = [];
        for (let i = 0; i < N && reports.length < 500; i++)
          if (t.managerOf[i] === u) reports.push(userBrief(i));
        return as(dirSub(mat(reports), 'directoryObjects'));
      }
      if (rel === 'licenseDetails')
        return as(
          sub(
            mat(
              (t.users[u]!.assignedLicenses as GraphObject[]).map((l) => {
                const sku = t.subscribedSkus.find((s) => s.skuId === l.skuId)!;
                return {
                  id: `${l.skuId}`,
                  skuId: l.skuId,
                  skuPartNumber: sku.skuPartNumber,
                  servicePlans: sku.servicePlans,
                };
              }),
            ),
            'licenseDetails',
          ),
        );
      if (rel === 'authentication' && cast === 'methods') {
        const reg = t.userRegistrationDetails.at(Math.min(u, t.userRegistrationDetails.size - 1));
        return as(
          sub(
            mat([
              {
                '@odata.type': '#microsoft.graph.passwordAuthenticationMethod',
                id: '28c10230-6103-485e-b985-444c60001490',
              },
              ...((reg.methodsRegistered as string[]) ?? []).map((m, k) => ({
                '@odata.type': `#microsoft.graph.${m === 'mobilePhone' ? 'phoneAuthenticationMethod' : m === 'email' ? 'emailAuthenticationMethod' : 'microsoftAuthenticatorAuthenticationMethod'}`,
                id: `${u}-${k}`,
              })),
            ]),
            'methods',
          ),
        );
      }
      if (rel === 'managedDevices')
        return as(sub(mat(t.managedDevices.filter((_, d) => t.deviceOwner[d] === u)), 'managedDevices'));
      if (rel === 'ownedDevices' || rel === 'registeredDevices')
        return as(
          dirSub(
            mat(
              t.entraDevices
                .filter((_, d) => d < t.managedDevices.length && t.deviceOwner[d] === u)
                .map((o) => ({ '@odata.type': '#microsoft.graph.device', ...o })),
            ),
            'directoryObjects',
          ),
        );
      if (rel === 'appRoleAssignments') return as(sub(mat([]), 'appRoleAssignments'));
      return undefined;
    }
    if (root === 'groups' && id) {
      const g = groupIx.get(lower);
      if (g === undefined) return { kind: 'entity', o: null };
      if (!rel) return { kind: 'entity', o: t.groups[g]!, d: collections['/groups'] };
      if (rel === 'members' || rel === 'transitiveMembers')
        return as(dirSub(groupMemberCollection(g, castType), 'directoryObjects'));
      if (rel === 'owners')
        return as(
          dirSub(
            mat(
              t.groupOwners[g]!.filter(() => !castType || castType === 'microsoft.graph.user').map(userBrief),
            ),
            'directoryObjects',
          ),
        );
      if (rel === 'memberOf')
        return as(dirSub(mat((parentGroups().get(g) ?? []).map(groupBrief)), 'directoryObjects'));
      if (rel === 'membersWithLicenseErrors') {
        const sku = t.groups[g]!.assignedLicenses as GraphObject[];
        const errs: GraphObject[] = [];
        if (sku.length)
          for (let i = 0; i < N && errs.length < 2000; i++)
            if (
              (t.users[i]!.licenseAssignmentStates as GraphObject[]).some(
                (s) => s.assignedByGroup === t.groups[g]!.id && s.state === 'Error',
              )
            )
              errs.push(userBrief(i));
        return as(dirSub(mat(errs), 'directoryObjects'));
      }
      if (rel === 'appRoleAssignments') return as(sub(mat([]), 'appRoleAssignments'));
      return undefined;
    }
    if (root === 'devices' && id) {
      const d = devIx.get(lower);
      if (d === undefined) return { kind: 'entity', o: null };
      if (!rel) return { kind: 'entity', o: t.entraDevices[d]!, d: collections['/devices'] };
      if (rel === 'registeredOwners' || rel === 'registeredUsers')
        return as(
          dirSub(mat(d < t.managedDevices.length ? [userBrief(t.deviceOwner[d]!)] : []), 'directoryObjects'),
        );
      if (rel === 'memberOf') return as(dirSub(mat([]), 'directoryObjects'));
      return undefined;
    }
    if (root === 'applications' && id) {
      const a = appIx.get(lower);
      if (a === undefined) return { kind: 'entity', o: null };
      if (!rel) return { kind: 'entity', o: t.applications[a]!, d: collections['/applications'] };
      if (rel === 'owners') return as(dirSub(mat(t.appOwners[a]!.map(userBrief)), 'directoryObjects'));
      if (rel === 'federatedIdentityCredentials') return as(sub(mat([]), 'federatedIdentityCredentials'));
      return undefined;
    }
    if (root?.startsWith('servicePrincipals')) {
      const byAppId = /^servicePrincipals\(appId='([^']+)'\)$/.exec(root);
      const s = byAppId ? spByAppId.get(byAppId[1]!.toLowerCase()) : spIx.get(lower);
      const r = byAppId ? id : rel;
      if (s === undefined) return { kind: 'entity', o: null };
      if (!r) return { kind: 'entity', o: t.servicePrincipals[s]!, d: collections['/servicePrincipals'] };
      if (r === 'appRoleAssignedTo') {
        const appId = String(t.servicePrincipals[s]!.appId);
        return as(sub(appId === GRAPH_APP_ID ? t.graphAppRoleAssignedTo : mat([]), 'appRoleAssignedTo'));
      }
      if (r === 'appRoleAssignments') {
        const spId = t.servicePrincipals[s]!.id;
        const rows: GraphObject[] = [];
        for (let k = 0; k < t.graphAppRoleAssignedTo.size; k++) {
          const row = t.graphAppRoleAssignedTo.at(k);
          if (row.principalId === spId) rows.push(row);
        }
        return as(sub(mat(rows), 'appRoleAssignments'));
      }
      if (r === 'owners')
        return as(dirSub(mat((t.appOwners[appOfSp(s)] ?? []).map(userBrief)), 'directoryObjects'));
      if (r === 'oauth2PermissionGrants') return as(sub(mat([]), 'oauth2PermissionGrants'));
      return undefined;
    }
    return undefined;
  }

  function route(method: string, url: URL, headers: Headers, body: unknown): Answer {
    const m = /^\/(v1\.0|beta)(\/.*)?$/.exec(url.pathname);
    if (!m) return unmodelled(method, url.pathname);
    const version = m[1]!;
    const path = decodeURIComponent(m[2] ?? '/');
    if (method === 'POST' && path === '/$batch') return batch(version, body);
    if (method === 'POST' && path === '/directoryObjects/getByIds') {
      const b = body as { ids?: string[]; types?: string[] };
      const select = url.searchParams.get('$select')?.split(',').filter(Boolean);
      if (!Array.isArray(b?.ids) || b.ids.length === 0 || b.ids.length > 1000)
        return graphError(400, 'Request_BadRequest', 'ids must hold 1 to 1000 ids.');
      const value = b.ids.flatMap((id) => {
        const hit = t.ids.get(id);
        if (!hit) return [];
        if (b.types?.length && !b.types.map((x) => x.toLowerCase()).includes(hit.kind.toLowerCase()))
          return [];
        return [project({ '@odata.type': `#microsoft.graph.${hit.kind}`, ...hit.object }, select)];
      });
      return jsonAnswer({
        '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#directoryObjects',
        value,
      });
    }
    if (method !== 'GET') return unmodelled(method, path);
    if (t.singletons[path]) return respondEntity(t.singletons[path]!, url);
    const exact = collections[path];
    if (exact) return respondCollection(path, exact, url, headers);
    if (path.endsWith('/$count') && collections[path.slice(0, -'/$count'.length)])
      return respondCount(
        collections[path.slice(0, -'/$count'.length)]!,
        url,
        headers,
        path.slice(0, -'/$count'.length),
      );
    const rep = /^\/reports\/(\w+\(period='D\d+'\))$/.exec(path);
    if (rep) {
      const coll = t.usageReport(rep[1]!);
      if (!coll) return unmodelled(method, path);
      if (url.searchParams.get('$format') !== 'application/json') return unmodelled(method, `${path} (CSV)`);
      return respondCollection(path, def(coll, 'reports', { defaultTop: 2000, maxTop: 2000 }), url, headers);
    }
    const role = /^\/directoryRoles\(roleTemplateId='([0-9a-f-]+)'\)\/members$/i.exec(path);
    if (role) {
      const members = t.roleAssignments
        .filter((a) => a.roleDefinitionId === role[1]!.toLowerCase() && a.directoryScopeId === '/')
        .flatMap((a) => (principal(String(a.principalId)) ? [principal(String(a.principalId))!] : []));
      return respondCollection(path, dirSub(mat(members), 'directoryObjects'), url, headers);
    }
    const segs = path.split('/').filter(Boolean);
    // An item of a modelled collection: /identity/conditionalAccess/policies/{id}, …/userRegistrationDetails/{id}
    const parentPath = `/${segs.slice(0, -1).join('/')}`;
    const parent = collections[parentPath];
    if (
      parent &&
      ![
        '/users',
        '/groups',
        '/devices',
        '/applications',
        '/servicePrincipals',
        '/deviceManagement/managedDevices',
        '/deviceManagement/deviceCompliancePolicies',
        '/deviceManagement/deviceConfigurations',
        '/deviceManagement/configurationPolicies',
        '/teams',
        '/identityProtection/riskyUsers',
      ].includes(parentPath)
    ) {
      const id = segs[segs.length - 1]!.toLowerCase();
      for (let i = 0; i < parent.coll.size; i++) {
        const o = parent.coll.at(i);
        if (String(o.id).toLowerCase() === id) return respondEntity(o, url, parent);
      }
      return respondEntity(null, url);
    }
    // /deviceManagement/managedDevices/{id}[/rel], policies, autopilot …
    if (segs[0] === 'deviceManagement' && segs.length >= 3) {
      const base = `/${segs[0]}/${segs[1]}`;
      const d = collections[base];
      if (d) {
        const id = segs[2]!.toLowerCase();
        const list =
          base === '/deviceManagement/managedDevices'
            ? t.managedDevices
            : base === '/deviceManagement/deviceCompliancePolicies'
              ? t.compliancePolicies
              : base === '/deviceManagement/deviceConfigurations'
                ? t.deviceConfigurations
                : base === '/deviceManagement/configurationPolicies'
                  ? t.configurationPolicies
                  : undefined;
        if (!list) return unmodelled(method, path);
        const idx =
          base === '/deviceManagement/managedDevices'
            ? mdIx.get(id)
            : list.findIndex((o) => String(o.id).toLowerCase() === id);
        const o = idx === undefined || idx < 0 ? null : list[idx]!;
        const rel = segs[3];
        if (!rel) return respondEntity(o, url, d);
        if (!o) return respondEntity(null, url);
        if (base === '/deviceManagement/managedDevices') {
          if (rel === 'detectedApps')
            return respondCollection(
              path,
              sub(t.detectedApps(idx!), 'detectedApps', { maxTop: 1000 }),
              url,
              headers,
            );
          if (rel === 'deviceCompliancePolicyStates' || rel === 'deviceConfigurationStates')
            return respondCollection(
              path,
              sub(
                mat(
                  t.compliancePolicies.slice(0, 4).map((p) => ({
                    id: p.id,
                    displayName: p.displayName,
                    state: o.complianceState === 'compliant' ? 'compliant' : 'nonCompliant',
                    platformType: 'windows10AndLater',
                    settingCount: 3,
                    version: 1,
                  })),
                ),
                rel,
              ),
              url,
              headers,
            );
          if (rel === 'users')
            return respondCollection(
              path,
              sub(mat([userBrief(t.deviceOwner[idx!]!)]), 'users'),
              url,
              headers,
            );
        } else {
          if (rel === 'deviceStatusOverview')
            return respondEntity(
              {
                id: `${o.id}_overview`,
                pendingCount: 5,
                notApplicableCount: 20,
                successCount: 4000,
                errorCount: 12,
                failedCount: 30,
                conflictCount: 2,
                lastUpdateDateTime: NOW_ISO,
                configurationVersion: 3,
              },
              url,
            );
          if (rel === 'deviceStatuses')
            return respondCollection(
              path,
              sub(
                {
                  size: Math.min(t.managedDevices.length, 5000),
                  at: (k) => {
                    const md = t.managedDevices[k]!;
                    return {
                      id: `${o.id}_${md.id}`,
                      deviceDisplayName: md.deviceName,
                      userName: md.userPrincipalName,
                      userPrincipalName: md.userPrincipalName,
                      deviceModel: md.model,
                      platform: 0,
                      complianceGracePeriodExpirationDateTime: '9999-12-31T23:59:59Z',
                      status: k % 20 === 0 ? 'nonCompliant' : 'compliant',
                      lastReportedDateTime: md.lastSyncDateTime,
                    };
                  },
                },
                'deviceStatuses',
                { maxTop: 1000 },
              ),
              url,
              headers,
            );
        }
        return unmodelled(method, path);
      }
    }
    if (segs[0] === 'identityProtection' && segs[1] === 'riskyUsers' && segs[2]) {
      const o = t.riskyUsers.find((r) => String(r.id).toLowerCase() === segs[2]!.toLowerCase()) ?? null;
      if (!segs[3]) return respondEntity(o, url);
      if (segs[3] === 'history')
        return respondCollection(
          path,
          sub(
            mat(o ? [o, { ...o, riskState: 'atRisk', riskLastUpdatedDateTime: '2026-09-01T00:00:00Z' }] : []),
            'history',
          ),
          url,
          headers,
        );
    }
    if (segs[0] === 'roleManagement' && segs[2] === 'roleDefinitions' && segs[3])
      return respondEntity(t.roleDefinitions.find((r) => r.id === segs[3]!.toLowerCase()) ?? null, url);
    if (segs[0] === 'admin' && segs[1] === 'serviceAnnouncement' && segs[3]) {
      const list =
        segs[2] === 'issues' ? t.serviceIssues : segs[2] === 'messages' ? t.serviceMessages : undefined;
      if (list) return respondEntity(list.find((o) => o.id === segs[3]) ?? null, url);
    }
    if (segs[0] === 'teams' && segs[1]) {
      const g = groupIx.get(segs[1].toLowerCase());
      if (g === undefined || !t.teams.includes(g)) return respondEntity(null, url);
      if (!segs[2]) return respondEntity(teamOf(g), url);
      if (segs[2] === 'channels')
        return respondCollection(
          path,
          sub(
            mat(
              Array.from({ length: 3 + (g % 15) }, (_, k) => ({
                id: `19:${g}-${k}@thread.tacv2`,
                displayName: k === 0 ? 'General' : `Channel ${k}`,
                membershipType: k % 5 === 4 ? 'private' : 'standard',
                createdDateTime: NOW_ISO,
              })),
            ),
            'channels',
          ),
          url,
          headers,
        );
      if (segs[2] === 'members')
        return respondCollection(
          path,
          sub(
            {
              size: Math.min(t.groupUserMembers(g).count, 25_000),
              at: (k) => {
                const u = t.users[t.groupUserMembers(g).at(k)]!;
                return {
                  id: `m-${g}-${k}`,
                  displayName: u.displayName,
                  userId: u.id,
                  email: u.mail,
                  roles: k === 0 ? ['owner'] : [],
                };
              },
            },
            'members',
          ),
          url,
          headers,
        );
    }
    if (segs[0] === 'sites') {
      if (!segs[1]) {
        const term = (url.searchParams.get('search') ?? '').toLowerCase().replace(/^"|"$/g, '');
        const filtered: Collection =
          term && term !== '*'
            ? (() => {
                const hits: number[] = [];
                for (let k = 0; k < t.sites.size && hits.length < 5000; k++)
                  if (String(t.sites.at(k).displayName).toLowerCase().includes(term)) hits.push(k);
                return { size: hits.length, at: (k: number) => t.sites.at(hits[k]!) };
              })()
            : t.sites;
        const u = new URL(url.toString());
        u.searchParams.delete('search');
        const ans = respondCollection('/sites', sub(filtered, 'sites', { maxTop: 999 }), u, headers);
        return ans;
      }
      const site = {
        id: segs[1],
        displayName: 'Site',
        webUrl: 'https://example.sharepoint.com/sites/x',
        createdDateTime: NOW_ISO,
      };
      if (!segs[2]) return respondEntity(site, url);
      if (segs[2] === 'drive')
        return respondEntity(
          {
            id: `drive-${segs[1]}`,
            driveType: 'documentLibrary',
            quota: {
              total: 25 * 1024 ** 4,
              used: 1024 ** 3,
              remaining: 25 * 1024 ** 4 - 1024 ** 3,
              state: 'normal',
            },
          },
          url,
        );
      if (segs[2] === 'lists')
        return respondCollection(
          path,
          sub(
            mat(
              Array.from({ length: 12 }, (_, k) => ({
                id: `list-${k}`,
                displayName: k === 0 ? 'Documents' : `List ${k}`,
                list: { template: k === 0 ? 'documentLibrary' : 'genericList', hidden: false },
                lastModifiedDateTime: NOW_ISO,
              })),
            ),
            'lists',
          ),
          url,
          headers,
        );
    }
    const r = resolveSub(segs);
    if (!r) return unmodelled(method, path);
    if (r.kind === 'entity') return respondEntity(r.o, url, r.d);
    if (r.kind === 'count') return respondCount(r.d, url, headers, path);
    return respondCollection(path, r.d, url, headers);
  }

  function unmodelled(method: string, path: string): Answer {
    const key = `${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}')}`;
    stats.unmodelled.set(key, (stats.unmodelled.get(key) ?? 0) + 1);
    return graphError(404, 'SyntheticNotModelled', `The synthetic tenant doesn't model ${key}.`);
  }

  function batch(version: string, body: unknown): Answer {
    const reqs = (
      body as {
        requests?: Array<{
          id: string;
          method: string;
          url: string;
          headers?: Record<string, string>;
          body?: unknown;
        }>;
      }
    )?.requests;
    if (!Array.isArray(reqs) || reqs.length === 0 || reqs.length > 20)
      return graphError(400, 'BadRequest', 'A batch holds 1 to 20 requests.');
    const responses = reqs.map((r) => {
      const url = new URL(
        `https://graph.microsoft.com/${version}${r.url.startsWith('/') ? '' : '/'}${r.url}`,
      );
      const a = safeRoute(r.method.toUpperCase(), url, new Headers(r.headers ?? {}), r.body);
      const parsed = a.headers['content-type']?.includes('json') ? JSON.parse(a.body) : a.body;
      return { id: r.id, status: a.status, headers: a.headers, body: parsed };
    });
    return jsonAnswer({ responses });
  }

  function safeRoute(method: string, url: URL, headers: Headers, body: unknown): Answer {
    try {
      return route(method, url, headers, body);
    } catch (err) {
      if (err instanceof ODataError) {
        if (err.code === 'SyntheticNotModelled') {
          const key = `${method} ${url.pathname} (${err.message})`;
          stats.unmodelled.set(key, (stats.unmodelled.get(key) ?? 0) + 1);
          return graphError(404, 'SyntheticNotModelled', err.message);
        }
        return graphError(400, err.code, err.message);
      }
      throw err;
    }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function handle(
    method: string,
    rawUrl: string,
    headers: Headers,
    rawBody: string | undefined,
  ): Promise<Answer> {
    stats.requests++;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      const delay = (opts.latencyMs ?? 0) + (opts.jitterMs ? Math.random() * opts.jitterMs : 0);
      if (delay > 0) await sleep(delay);
      if (opts.throttleEvery && stats.requests % opts.throttleEvery === 0) {
        stats.throttled++;
        return {
          ...graphError(429, 'TooManyRequests', 'Too many requests (synthetic throttling).'),
          headers: { 'content-type': 'application/json', 'retry-after': String(opts.retryAfterSec ?? 0) },
        };
      }
      const url = new URL(rawUrl);
      if (url.hostname !== 'graph.microsoft.com') return unmodelled(method, `${url.hostname}${url.pathname}`);
      let body: unknown;
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          return graphError(400, 'BadRequest', 'Request body is not JSON.');
        }
      }
      const work = performance.now();
      const a = safeRoute(method, url, headers, body);
      stats.busyMs += performance.now() - work;
      stats.bytes += a.body.length;
      if (a.status >= 400) stats.errors[a.status] = (stats.errors[a.status] ?? 0) + 1;
      return a;
    } finally {
      stats.inFlight--;
    }
  }

  /** A fetch for the outbound executor (`createOutboundExecutor({ fetch })`, `buildApp({ fetch })`). */
  const fetchImpl: typeof globalThis.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input);
    const method = (init.method ?? req?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? req?.headers ?? {});
    const body =
      typeof init.body === 'string'
        ? init.body
        : init.body
          ? String(init.body)
          : req
            ? await req.text()
            : undefined;
    const a = await handle(method, url, headers, body);
    return new Response(a.body, { status: a.status, headers: a.headers });
  };

  /** Serves the same over HTTP (any path; the Host is treated as graph.microsoft.com). */
  async function listen(port = 0) {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const a = await handle(
        req.method ?? 'GET',
        `https://graph.microsoft.com${req.url ?? '/'}`,
        new Headers(req.headers as Record<string, string>),
        chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
      );
      res.writeHead(a.status, a.headers);
      res.end(a.body);
    });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    const { port: bound } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${bound}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  return { fetch: fetchImpl, handle, listen, stats, tenant };
}

export type FakeGraph = ReturnType<typeof createFakeGraph>;
export { EXCHANGE_APP_ID, GRAPH_APP_ID, SHAREPOINT_APP_ID };
