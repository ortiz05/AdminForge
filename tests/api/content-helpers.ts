import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cookieFrom, entraConfig, FakeAuthClient, json, makeApp, mockConfig, orgResponse } from './helpers';

/**
 * Self-contained content + fixtures for the content/platform API tests (synthetic only), so they don't depend on
 * portal/content, which other work keeps changing.
 */

const NAV = `kind: navigation
id: portal.navigation
version: 1.0.0
title: Navigation
owner: test-team
sections:
  - { key: overview, label: Overview, icon: house, order: 10 }
  - { key: identity, label: Identity, icon: identification-card, order: 20 }
  - { key: security, label: Security, icon: shield-check, order: 30 }
  - { key: empty, label: Empty, icon: folder, order: 40 }
  - key: admin
    label: Admin
    icon: gear-six
    order: 90
    roles: [Portal.Admin]
    items:
      - { key: audit, label: Audit, href: /admin/audit, icon: scroll }
`;

const USERS = `kind: page
id: identity.users
version: 1.0.0
title: Users
summary: Member and guest accounts.
owner: identity-team
tags: [identity, users]
template: list-detail
nav: { section: identity, label: Users, icon: users, order: 10 }
requires:
  portalRoles: [Portal.Reader]
  scopes:
    graph: [User.Read.All]
  entraRoles: [Directory Readers]
params:
  q: { type: string, default: "", label: Search }
  userType: { type: enum, values: [All, Member, Guest], default: All, facet: true }
  department: { type: string, facet: true }
savedViews: { enabled: true, shared: true }
filters:
  advanced:
    dialect: odata
    fields:
      - { field: department, label: Department, type: string, operators: [eq, ne, startsWith, in, isEmpty] }
      - { field: created, label: Created, type: date, property: createdDateTime, operators: [ge, le] }
      - { field: accountEnabled, label: Enabled, type: boolean }
      - { field: manager, label: Manager id, type: guid, property: manager/id }
      - { field: userType, label: Type, type: enum, values: [Member, Guest] }
datasources:
  users:
    source: graph
    request:
      path: /users
      headers: { ConsistencyLevel: eventual }
      query:
        $select: id,displayName,userPrincipalName,accountEnabled,userType,department
        $count: true
        $top: 5
        $filter: >-
          \${ $join([
               params.userType != 'All' ? "userType eq " & $odata(params.userType),
               params.department ? "department eq " & $odata(params.department),
               advanced
             ][$], ' and ') }
        $search: >-
          \${ params.q ? '"displayName:' & $odataSearch(params.q) & '"' }
    paging: cursor
    cache: { ttl: 60 }
  counts:
    source: graphBatch
    requests:
      members: { path: /users/$count, query: { $filter: "userType eq 'Member'" }, headers: { ConsistencyLevel: eventual } }
      guests: { path: /users/$count, query: { $filter: "userType eq 'Guest'" }, headers: { ConsistencyLevel: eventual } }
    cache: { ttl: 300 }
  later:
    source: static
    when: \${ params.userType = 'Guest' }
    data: { shown: true }
layout:
  - { widget: kpi, data: counts.members, label: Members }
  - widget: table
    id: users
    data: users.value
    rowKey: id
    columns:
      - { field: displayName, label: Name, kind: identity, secondary: userPrincipalName }
      - field: accountEnabled
        label: Status
        kind: status
        map: { "true": [ok, Enabled], "false": [crit, Disabled] }
      - { field: department, label: Department }
      - { field: id, label: Object id, kind: guid, hidden: true }
export:
  formats: [csv, xlsx]
  fileName: users
  data: users.value
  columns: visible
`;

const USER = `kind: page
id: identity.user
version: 1.0.0
title: User
owner: identity-team
template: entity
params:
  id: { type: guid, required: true, hidden: true }
datasources:
  user:
    source: graph
    request:
      path: /users/\${ $encode($guid(params.id)) }
layout:
  - { widget: keyValue, data: user }
`;

const EXPIRY = `kind: report
id: identity.expiry
version: 1.0.0
title: Credential expiry
owner: identity-team
nav: { section: identity, label: Credential expiry, icon: key, order: 50 }
params:
  days: { type: number, default: 30 }
datasources:
  creds:
    source: graph
    request:
      path: /applications
      query: { $select: "id,displayName,passwordCredentials" }
    paging: all
    transform: >-
      \${ (
        $rows := [value.value.(
          $app := $;
          passwordCredentials.{ "app": $app.displayName, "keyId": keyId, "expires": endDateTime, "formula": "=1+1" }
        )];
        { "rows": $rows, "total": $count($rows) }
      ) }
layout:
  - widget: table
    data: creds.rows
    columns:
      - { field: app, label: Application }
      - { field: keyId, label: Key id, kind: guid, hidden: true }
      - { field: expires, label: Expires, kind: datetime }
      - { field: formula, label: Note }
export:
  formats: [csv, xlsx]
  fileName: expiry-\${ params.days }d
  data: creds.rows
  columns: all
`;

const RISKY = `kind: page
id: security.risky-users
version: 1.0.0
title: Risky users
owner: security-team
template: list-detail
nav: { section: security, label: Risky users, icon: user-focus, order: 10 }
requires:
  licences: [AAD_PREMIUM_P2]
datasources:
  risky:
    source: graph
    request: { path: /identityProtection/riskyUsers }
layout:
  - { widget: table, data: risky.value, columns: [{ field: userDisplayName, label: User }] }
`;

const ADMIN_ONLY = `kind: page
id: identity.break-glass
version: 1.0.0
title: Break-glass accounts
owner: identity-team
template: list-detail
nav: { section: identity, label: Break-glass, order: 90 }
requires:
  portalRoles: [Portal.Admin]
datasources:
  rows: { source: static, data: [] }
layout:
  - { widget: table, data: rows, columns: [{ field: id, label: Id }] }
`;

const PLAYBOOK = `kind: playbook
id: identity.check-user
version: 1.0.0
title: Check user
summary: Looks a user up.
owner: identity-team
nav: { section: identity, label: Check user, order: 60 }
risk: low
mode: read
steps:
  - id: lookup
    type: graph
    request: { path: /me }
`;

const CHAIN = `kind: page
id: deps.chain
version: 1.0.0
title: Chain
owner: t
template: dashboard
params:
  kind: { type: enum, values: [Member, Guest], default: Member }
datasources:
  first:
    source: graph
    request: { path: /users }
    transform: \${ value.value[0].id }
  second:
    source: graph
    request:
      path: /users/\${ $encode(ds.first) }/memberOf
  third:
    source: static
    when: \${ ds.second != null }
    data:
      firstId: \${ ds.first }
  independent:
    source: static
    data: 42
  mailboxes:
    source: runner
    script: exchange/Get-Test.ps1
    sha256: ${'a'.repeat(64)}
    services: [exchange]
    timeoutSeconds: 3600
    parameters:
      kinds:
        - \${ params.kind }
  settings:
    source: arm
    request:
      method: POST
      path: /subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg-example/providers/Microsoft.Web/sites/func-example/config/appsettings/list
      apiVersion: "2023-12-01"
    transform: \${ $keys(value.properties) }
  inventory:
    source: resourceGraph
    query: |-
      // af:deps.chain#inventory
      Resources | project id, name
layout:
  - { widget: kpi, data: independent }
`;

const INVENTORY = `kind: page
id: deps.inventory
version: 1.0.0
title: Inventory
owner: t
template: list-detail
filters:
  advanced:
    dialect: kql
    fields:
      - { field: name, label: Name, type: string, operators: [eq, ne, contains, startsWith, in, isEmpty] }
      - { field: tagCount, label: Tags, type: number, operators: [eq, gt, le] }
      - { field: state, label: State, type: string, property: properties.provisioningState, operators: [eq] }
      - { field: subscriptionId, label: Subscription, type: guid }
datasources:
  inv:
    source: resourceGraph
    query: |-
      Resources
      \${ advanced ? '| where ' & advanced }
      | project id, name
layout:
  - { widget: kpi, data: inv }
`;

const BACKWARDS = `kind: page
id: deps.backwards
version: 1.0.0
title: Backwards
owner: t
template: dashboard
datasources:
  early:
    source: static
    data: \${ ds.late }
  late:
    source: static
    data: 1
layout:
  - { widget: kpi, data: early }
`;

const G = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const TEST_USERS = [
  { id: G(1), displayName: 'Avery Engineer', userPrincipalName: 'avery@example.com', accountEnabled: true, userType: 'Member', department: 'IT' },
  { id: G(2), displayName: 'Blake Analyst', userPrincipalName: 'blake@example.com', accountEnabled: false, userType: 'Member', department: 'Finance' },
  { id: G(3), displayName: 'Casey Guest', userPrincipalName: 'casey@example.net', accountEnabled: true, userType: 'Guest', department: null },
];

const FIXTURES: Record<string, unknown> = {
  'graph/v1.0/users/GET.json': { '@odata.count': 4, value: TEST_USERS, '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=page2' },
  'graph/v1.0/users/GET__$skiptoken=page2.json': { value: [{ id: G(4), displayName: 'Dana =SUM(A1)', userPrincipalName: 'dana@example.com', accountEnabled: true, userType: 'Member', department: 'Sales, EMEA' }] },
  "graph/v1.0/users/$count/GET__$filter=usertype_eq__member_.json": 3,
  "graph/v1.0/users/$count/GET__$filter=usertype_eq__guest_.json": { $fixture: { status: 403, body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } } } },
  'graph/v1.0/applications/GET.json': {
    value: [
      { id: G(11), displayName: 'Example HR Sync', passwordCredentials: [{ keyId: G(21), endDateTime: '2026-11-01T00:00:00Z' }, { keyId: G(22), endDateTime: '2027-01-01T00:00:00Z' }] },
      { id: G(12), displayName: 'Example Portal', passwordCredentials: [{ keyId: G(23), endDateTime: '2026-10-20T00:00:00Z' }] },
    ],
  },
  'graph/v1.0/groups/GET.json': { value: [{ id: G(31), displayName: 'Avery Fans', mail: 'fans@example.com' }, { id: G(32), displayName: 'Other Group', mail: null }] },
  'graph/v1.0/devices/GET.json': { value: [{ id: G(41), displayName: 'AVERY-LAPTOP', operatingSystem: 'Windows' }] },
  'graph/v1.0/subscribedskus/GET.json': {
    value: [
      {
        skuPartNumber: 'SPE_E3',
        capabilityStatus: 'Enabled',
        consumedUnits: 10,
        prepaidUnits: { enabled: 20 },
        servicePlans: ['AAD_PREMIUM', 'INTUNE_A', 'EXCHANGE_S_ENTERPRISE', 'TEAMS1', 'SHAREPOINTENTERPRISE'].map((p) => ({ servicePlanName: p, provisioningStatus: 'Success' })),
      },
      { skuPartNumber: 'EMS', capabilityStatus: 'Suspended', consumedUnits: 0, prepaidUnits: { enabled: 0 }, servicePlans: [{ servicePlanName: 'AAD_PREMIUM_P2', provisioningStatus: 'Success' }] },
    ],
  },
  'graph/v1.0/rolemanagement/directory/roleassignmentscheduleinstances/GET.json': { $fixture: { status: 403, body: { error: { code: 'AadPremiumLicenseRequired', message: 'The tenant needs an AAD Premium 2 license.' } } } },
  'graph/v1.0/rolemanagement/directory/roleeligibilityscheduleinstances/GET.json': { $fixture: { status: 403, body: { error: { code: 'AadPremiumLicenseRequired', message: 'The tenant needs an AAD Premium 2 license.' } } } },
  'graph/v1.0/rolemanagement/directory/roleassignments/GET.json': {
    value: [{ roleDefinitionId: 'f2ef992c-3afb-46b9-b7cf-a126ee74c451', directoryScopeId: '/', roleDefinition: { displayName: 'Global Reader' } }],
  },
  'runner/exchange/Get-Test.ps1.json': {
    $fixture: {
      variants: [{ match: { bodyIncludes: '"kinds":["Guest"]' }, body: [{ name: 'guest-box' }] }],
      body: [{ name: 'box-1' }, { name: 'box-2' }],
    },
  },
  'arm/subscriptions/00000000-0000-4000-8000-0000000000a1/resourcegroups/rg-example/providers/microsoft.web/sites/func-example/config/appsettings/list/POST.json': {
    id: '/subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg-example/providers/Microsoft.Web/sites/func-example/config/appsettings',
    properties: { FUNCTIONS_WORKER_RUNTIME: 'node', STORAGE_CONNECTION: 'DefaultEndpointsProtocol=https;AccountName=example;AccountKey=c2VjcmV0' },
  },
  'graph/v1.0/users/30000000-0000-4000-8000-000000000001/memberof/GET.json': { value: [{ id: 'g1' }] },
  'resourceGraph/POST.json': {
    $fixture: {
      variants: [{ match: { bodyIncludes: '// af:deps.chain#inventory' }, body: { totalRecords: 1, data: [{ id: '/subscriptions/x/resourceGroups/rg/providers/Microsoft.Web/sites/from-variant', name: 'from-variant' }] } }],
      body: {
    totalRecords: 2,
    data: [
      { id: '/subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg-example/providers/Microsoft.Web/sites/avery-func', name: 'avery-func', type: 'microsoft.web/sites', resourceGroup: 'rg-example' },
      { id: '/subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg-example/providers/Microsoft.Storage/storageAccounts/stother', name: 'stother', type: 'microsoft.storage/storageaccounts', resourceGroup: 'rg-example' },
    ],
      },
    },
  },
};

export interface ContentEnv {
  contentDir: string;
  fixturesDir: string;
  /** Config overrides pointing the app at this content and these fixtures. */
  overrides: Record<string, string>;
  write(rel: string, text: string): void;
  cleanup(): void;
}

export function setupContent(): ContentEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'af-api-content-'));
  const contentDir = path.join(root, 'content');
  const fixturesDir = path.join(root, 'fixtures');
  const write = (base: string) => (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    writeFileSync(path.join(base, rel), text);
  };
  const content = write(contentDir);
  content('navigation.yaml', NAV);
  content('pages/identity/users.page.yaml', USERS);
  content('pages/identity/user.page.yaml', USER);
  content('pages/identity/break-glass.page.yaml', ADMIN_ONLY);
  content('pages/security/risky-users.page.yaml', RISKY);
  content('reports/identity/expiry.report.yaml', EXPIRY);
  content('playbooks/identity/check-user.playbook.yaml', PLAYBOOK);
  content('pages/deps/chain.page.yaml', CHAIN);
  content('pages/deps/backwards.page.yaml', BACKWARDS);
  content('pages/deps/inventory.page.yaml', INVENTORY);
  const fx = write(fixturesDir);
  for (const [rel, body] of Object.entries(FIXTURES)) fx(rel, typeof body === 'number' ? String(body) : JSON.stringify(body));
  return {
    contentDir,
    fixturesDir,
    overrides: { CONTENT_DIR: contentDir, ADMINFORGE_FIXTURES_DIR: fixturesDir, CONTENT_WATCH: 'false' },
    write: content,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Mock sign-in + DATA_MODE=fixtures over the synthetic content. */
export async function fixturesApp(env: ContentEnv, overrides: Record<string, string> = {}) {
  return makeApp(mockConfig({ ...env.overrides, ...overrides }));
}

/** Entra (fake AuthClient) + live data answered by `route`; returns a signed-in cookie. */
export async function liveApp(env: ContentEnv, route: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const auth = new FakeAuthClient();
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/organization') && !url.includes('$batch')) return orgResponse();
    calls.push({ url, method: (init.method ?? 'GET').toUpperCase(), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return route(url, init);
  };
  const t = await makeApp(entraConfig(env.overrides), { auth, fetch });
  const login = await t.app.inject({ method: 'GET', url: '/auth/login' });
  const state = new URL(login.headers.location as string).searchParams.get('state')!;
  const cb = await t.app.inject({ method: 'GET', url: `/auth/callback?code=c&state=${state}` });
  const cookie = cookieFrom(cb)!;
  const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { ...t, auth, calls, cookie, csrf: (me.json() as { csrf: string }).csrf };
}

export { json };
