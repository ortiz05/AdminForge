// Live accuracy: does AdminForge show what is really in the tenant? For the list pages, entity pages, dashboard KPIs
// and reports whose answers the test fixtures make known (docs/enterprise-scenarios.md › Live accuracy), runs each
// datasource exactly as the portal does — POST /api/datasources/execute-many as the validation user, read mode — and
// compares it with (a) the fixture catalogue (portal/tools/cli/src/provision/*-fixture-* modules, imported, not
// copied) and (b) an independent Microsoft Graph read through a different code path (the connectors' HTTP client
// with the automation identity — read-only application permissions — falling back to the provisioner only where the
// automation identity can't read; never an AdminForge transform).
//
// Usage (repository root; the validation user enabled — see tests/live/README.md):
//   PUBLIC_BASE_URL=https://<lan-address>:8443 AF_LIVE_INSECURE_TLS=1 \
//     pnpm exec tsx tests/live/scripts/check-accuracy.ts [<definition id substring>…]
//   With arguments, only checks whose page contains one of them run.
// Inputs: the env file and <env>.admin.env (sign-in, AF_PRIMARY_DOMAIN, the automation and provisioner credentials).
// Output: one line per check — ✓ match, ✗ mismatch (field, expected vs shown), ≈ documented difference (with why),
//   · not knowable — then a summary. Masked (lib/mask.ts): synthetic AF-Test names only, never ids, UPNs or domains.
//   Exit code 1 on any unexplained mismatch.
// Safety: read-only on both sides (read-mode datasources; Graph GETs and $count only).
import { loadEnv } from '@adminforge/config';
import type { GraphClient } from '@adminforge/connectors';
import { CA_AUDIT_POLICIES } from '../../../portal/tools/cli/src/provision/ca-audit-catalog';
import { appClients, provisionerClients } from '../../../portal/tools/cli/src/provision/clients';
import { FIXTURE_APPS, SAML_APP } from '../../../portal/tools/cli/src/provision/apps-fixture-plan';
import { directoryCatalog } from '../../../portal/tools/cli/src/provision/directory-fixture-catalog';
import { INTUNE_POLICIES, NAMED_LOCATION } from '../../../portal/tools/cli/src/provision/fixtures-model';
import { INTUNE_MORE } from '../../../portal/tools/cli/src/provision/intune-more-fixture';
import { provisionSettings } from '../../../portal/tools/cli/src/provision/settings';
import { signInAccounts } from '../../../portal/tools/cli/src/provision/sign-ins-fixture';
import {
  compareRange,
  compareSets,
  compareValue,
  daysUntil,
  exitCodeFor,
  fixtureNames,
  formatOutcomes,
  nameOf,
  outcome,
  rowsOf,
  type Difference,
  type Outcome,
} from '../lib/accuracy';
import { openPublicSession } from '../lib/accuracy-session';
import { mask, maskError } from '../lib/mask';
import { resolvePlaceholders } from '../lib/placeholders';
import type { PortalSession } from '../lib/portal-session';

type Row = Record<string, unknown>;
type DsResult = { data?: unknown; error?: { code?: string; message?: string }; truncated?: boolean };

const env = loadEnv(process.env, { admin: true });
const domain = env.AF_PRIMARY_DOMAIN?.trim();
if (!domain) throw new Error('AF_PRIMARY_DOMAIN is not set (the fixtures are named after it).');
const now = new Date();
const only = process.argv.slice(2);
const catalog = directoryCatalog(domain);

// ── independent Graph reads ──────────────────────────────────────────────────────────────────────────────────────
const cliCtx = { env, writeEnv: () => undefined, out: () => undefined };
const settings = provisionSettings(env);
const automation = appClients(cliCtx, settings, 'automation')?.graph;
const provisioner = env.AF_PROVISIONER_CLIENT_SECRET ? provisionerClients(cliCtx, settings).graph : undefined;
if (!automation && !provisioner)
  throw new Error('Neither the automation identity nor the provisioner can sign in.');
const EVENTUAL = { ConsistencyLevel: 'eventual' };

/** The automation identity first (read-only), the provisioner when it is refused. */
async function graph<T>(run: (g: GraphClient) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const g of [automation, provisioner])
    if (g)
      try {
        return await run(g);
      } catch (err) {
        last = err;
        const status = (err as { status?: number }).status;
        if (status !== 401 && status !== 403) throw err;
      }
  throw last;
}
const all = <T = Row>(path: string, query: Record<string, string> = {}, headers?: Record<string, string>) =>
  graph((g) => g.all<T>({ path, query, ...(headers ? { headers } : {}) }));
/** `@odata.count` of a filtered collection (advanced query: ConsistencyLevel eventual). */
const count = (path: string, filter?: string) =>
  graph(async (g) => {
    const { data } = await g.request<{ '@odata.count'?: number }>({
      path,
      query: { $count: 'true', $top: '1', $select: 'id', ...(filter ? { $filter: filter } : {}) },
      headers: EVENTUAL,
    });
    return data['@odata.count'];
  });

/**
 * A group's owners by kind. Graph v1.0's `/owners` list can leave out service-principal owners (seen on Microsoft 365
 * groups created with application permissions, which keep the creating app as owner) while `owners/$count` counts
 * them; the type casts return both.
 */
async function ownersOf(groupId: string) {
  const users = await all<{ displayName?: string }>(`/groups/${groupId}/owners/microsoft.graph.user`, {
    $select: 'displayName',
  });
  const apps = await all<{ displayName?: string }>(
    `/groups/${groupId}/owners/microsoft.graph.servicePrincipal`,
    { $select: 'displayName' },
  );
  return { users: users.map((u) => u.displayName ?? ''), apps: apps.length };
}
const groupId = async (displayName: string) =>
  (await all<{ id: string }>('/groups', { $filter: `displayName eq '${displayName}'`, $select: 'id' }))[0]
    ?.id;
const APP_OWNER_WHY =
  'Microsoft 365 groups created with application permissions keep the creating app (the provisioner) as owner; the fixture catalogue lists people only';

// ── AdminForge, as the portal runs it ────────────────────────────────────────────────────────────────────────────
const session: PortalSession = await openPublicSession();
/** Published version and kind of each definition (null: not published here). */
const published = new Map<string, { kind: string; version: string } | null>();
const datasourcesOf = new Map<string, string[]>();
const results = new Map<string, Record<string, DsResult> | { problem: string }>();

/** Every datasource of a definition with `params` (placeholders such as `@group:AF-Test-Nested-01` resolved). */
async function run(key: string, params: Record<string, unknown> = {}) {
  const cacheKey = `${key}?${JSON.stringify(params)}`;
  const hit = results.get(cacheKey);
  if (hit) return hit;
  if (!published.has(key)) {
    let found: { kind: string; version: string; datasources: string[] } | null = null;
    for (const kind of ['page', 'dashboard', 'report']) {
      const r = await session.api<{ version?: string; datasources?: Record<string, unknown> }>(
        'GET',
        `/api/definitions/${kind}/${encodeURIComponent(key)}`,
      );
      if (r.status === 200 && r.json?.version) {
        found = { kind, version: r.json.version, datasources: Object.keys(r.json.datasources ?? {}) };
        break;
      }
    }
    published.set(key, found);
    if (found) datasourcesOf.set(key, found.datasources);
  }
  const def = published.get(key);
  let out: Record<string, DsResult> | { problem: string };
  if (!def) out = { problem: 'not published on this AdminForge' };
  else {
    const { inputs } = await resolvePlaceholders(session, params);
    const r = await session.api<{ results?: Record<string, DsResult>; error?: unknown }>(
      'POST',
      '/api/datasources/execute-many',
      { page: key, version: def.version, datasources: datasourcesOf.get(key), params: inputs },
    );
    out =
      r.status === 200 && r.json?.results
        ? r.json.results
        : { problem: `http ${r.status} — ${maskError(r.json?.error)}` };
  }
  results.set(cacheKey, out);
  return out;
}

/** One datasource's data, or why it isn't there (→ `unknowable`). */
async function data(
  key: string,
  ds: string,
  params: Record<string, unknown> = {},
): Promise<{ problem: string } | { value: unknown; truncated: boolean }> {
  const res = await run(key, params);
  if (typeof res.problem === 'string') return { problem: res.problem };
  const r = (res as Record<string, DsResult>)[ds];
  if (!r) return { problem: `no datasource “${ds}”` };
  if (r.error) return { problem: maskError(r.error, { max: 120 }) };
  return { value: r.data, truncated: Boolean(r.truncated) };
}

// ── checks ───────────────────────────────────────────────────────────────────────────────────────────────────────
type Check = { page: string; check: string; run: () => Promise<Outcome> };
const checks: Check[] = [];
const add = (page: string, check: string, fn: (page: string, check: string) => Promise<Outcome>) =>
  checks.push({ page, check, run: () => fn(page, check) });

/** Wraps a datasource read: unknowable when it can't be read, otherwise the comparison's outcome. */
const using =
  (
    key: string,
    ds: string,
    params: Record<string, unknown>,
    compare: (v: unknown) => Promise<Difference[]> | Difference[],
    documented?: string,
  ) =>
  async (page: string, check: string): Promise<Outcome> => {
    const d = await data(key, ds, params);
    if ('problem' in d) return { page, check, status: 'unknowable', details: [d.problem] };
    const diffs = await compare(d.value);
    return outcome(page, check, diffs, documented);
  };

const fixtureUsers = catalog.users;
const baseTargets = ['AF-Test-User-01', 'AF-Test-User-02', 'AF-Test-User-03'];
const userName = (k: string) => `AF-Test-User-${k}`;
const byName = (rows: Row[]) => new Map(rows.map((r) => [nameOf(r) ?? '', r]));
const ALL_FIXTURE_USERS = [...baseTargets, ...fixtureUsers.map((u) => u.displayName)];

// Users list: every fixture user appears with its sign-in state and attributes (search "AF-Test-User").
add(
  'identity.users#users',
  'fixture users listed with enabled state, department, title, usage location',
  using('identity.users', 'users', { q: 'AF-Test-User' }, (v) => {
    const rows = rowsOf(v);
    const shown = byName(rows);
    const diffs = compareSets(
      'AF-Test users',
      ALL_FIXTURE_USERS,
      fixtureNames(rows.map(nameOf)).filter((n) => /^AF-Test-User-/.test(n)),
    );
    for (const u of fixtureUsers) {
      const r = shown.get(u.displayName);
      if (!r) continue;
      diffs.push(...compareValue(`${u.displayName} enabled`, u.accountEnabled, r.accountEnabled));
      for (const f of ['department', 'jobTitle', 'usageLocation', 'employeeId'] as const)
        diffs.push(...compareValue(`${u.displayName} ${f}`, u.attributes[f] ?? null, r[f] ?? null));
    }
    return diffs;
  }),
);

// Users list KPIs vs Graph counts.
add(
  'identity.users#counts',
  'members, guests, disabled and unlicensed members vs Graph counts',
  using(
    'identity.users',
    'counts',
    {},
    async (v) => {
      const c = v as Row;
      return [
        ...compareValue('members', await count('/users', "userType eq 'Member'"), c.members),
        ...compareValue('guests', await count('/users', "userType eq 'Guest'"), c.guests),
        ...compareValue('disabled', await count('/users', 'accountEnabled eq false'), c.disabled),
        ...compareValue(
          'unlicensed members',
          await count('/users', "userType eq 'Member' and assignedLicenses/$count eq 0"),
          c.unlicensed,
        ),
      ];
    },
    'Graph counts are eventually consistent for a few minutes after accounts change',
  ),
);

add(
  'identity.health#counts',
  'identity overview: members, guests, disabled vs Graph counts',
  using(
    'identity.health',
    'counts',
    {},
    async (v) => {
      const c = v as Row;
      return [
        ...compareValue('members', await count('/users', "userType eq 'Member'"), c.members),
        ...compareValue('guests', await count('/users', "userType eq 'Guest'"), c.guests),
        ...compareValue('disabled', await count('/users', 'accountEnabled eq false'), c.disabled),
      ];
    },
    'Graph counts are eventually consistent for a few minutes after accounts change',
  ),
);

// Department facet and the dynamic group agree with the catalogue.
const sales = fixtureUsers
  .filter((u) => u.attributes.department === 'AF-Test Sales')
  .map((u) => u.displayName);
add(
  'identity.users#users',
  'department facet “AF-Test Sales”',
  using('identity.users', 'users', { department: 'AF-Test Sales' }, (v) =>
    compareSets('AF-Test Sales', sales, fixtureNames(rowsOf(v).map(nameOf))),
  ),
);

// Groups list: the fixture groups, their kind and membership type.
const fixtureGroups = catalog.groups;
add(
  'identity.groups#groups',
  'fixture groups listed; dynamic and Microsoft 365 ones marked as such',
  using('identity.groups', 'groups', { q: 'AF-Test' }, (v) => {
    const rows = rowsOf(v);
    const shown = byName(rows);
    const diffs = compareSets(
      'fixture groups',
      fixtureGroups.map((g) => g.displayName),
      fixtureNames(rows.map(nameOf)).filter((n) => fixtureGroups.some((g) => g.displayName === n)),
    );
    for (const g of fixtureGroups) {
      const r = shown.get(g.displayName);
      if (!r) continue;
      const dynamic = (g.body.groupTypes as string[]).includes('DynamicMembership');
      const unified = (g.body.groupTypes as string[]).includes('Unified');
      diffs.push(
        ...compareValue(`${g.displayName} dynamic`, dynamic, /dynamic/i.test(String(r.membership ?? ''))),
      );
      diffs.push(
        ...compareValue(
          `${g.displayName} Microsoft 365`,
          unified,
          Array.isArray(r.groupTypes) && (r.groupTypes as string[]).includes('Unified'),
        ),
      );
    }
    return diffs;
  }),
);

add(
  'identity.groups#counts',
  'group KPIs (total, Microsoft 365, dynamic, role-assignable) vs Graph counts',
  using(
    'identity.groups',
    'counts',
    {},
    async (v) => {
      const c = v as Row;
      return [
        ...compareValue('total', await count('/groups'), c.total),
        ...compareValue(
          'Microsoft 365',
          await count('/groups', "groupTypes/any(t:t eq 'Unified')"),
          c.unified,
        ),
        ...compareValue(
          'dynamic',
          await count('/groups', "groupTypes/any(t:t eq 'DynamicMembership')"),
          c.dynamic,
        ),
        ...compareValue(
          'role-assignable',
          await count('/groups', 'isAssignableToRole eq true'),
          c.roleAssignable,
        ),
      ];
    },
    'Graph counts are eventually consistent for a few minutes after groups change',
  ),
);

// Each fixture group's page: member and owner counts and lists vs the catalogue and Graph.
const memberName = (m: (typeof fixtureGroups)[number]['members'][number]) =>
  'user' in m
    ? userName(m.user)
    : 'target' in m
      ? m.target.split('@')[0]!.replace(/^af-test-user-/, 'AF-Test-User-')
      : 'AF-Test-Group-01';
for (const g of fixtureGroups) {
  const dynamic = (g.body.groupTypes as string[]).includes('DynamicMembership');
  const expectedMembers = dynamic ? sales : g.members.filter((m) => !('testGroup' in m)).map(memberName);
  const expectedChildren = g.members.filter((m) => 'testGroup' in m).map(memberName);
  const expectedOwners = g.owners.map(userName);
  const params = { id: `@group:${g.displayName}` };
  add(
    'identity.group#members',
    `${g.displayName}: member people`,
    using('identity.group', 'members', params, (v) =>
      compareSets(
        `${g.displayName} members`,
        expectedMembers,
        rowsOf(v)
          .map(nameOf)
          .filter((n): n is string => !!n),
      ),
    ),
  );
  if (expectedChildren.length)
    add(
      'identity.group#children',
      `${g.displayName}: nested groups`,
      using('identity.group', 'children', params, (v) =>
        compareSets(
          `${g.displayName} nested groups`,
          expectedChildren,
          rowsOf(v)
            .map(nameOf)
            .filter((n): n is string => !!n),
        ),
      ),
    );
  add(
    'identity.group#memberCount',
    `${g.displayName}: member and owner counts vs Graph and the catalogue`,
    async (page, check) => {
      const d = await data('identity.group', 'memberCount', params);
      if ('problem' in d) return { page, check, status: 'unknowable', details: [d.problem] };
      const c = d.value as Row;
      const id = await groupId(g.displayName);
      if (!id) return outcome(page, check, [`${g.displayName}: not found in Graph`]);
      const members = (await all(`/groups/${id}/members`, { $select: 'id' })).length;
      const owners = await ownersOf(id);
      const diffs = [
        ...compareValue(`${g.displayName} direct members (Graph)`, members, c.direct),
        ...compareValue(
          `${g.displayName} direct members (catalogue)`,
          expectedMembers.length + expectedChildren.length,
          c.direct,
        ),
        ...compareValue(
          `${g.displayName} owners (Graph, people and apps)`,
          owners.users.length + owners.apps,
          c.owners,
        ),
      ];
      const people = compareSets(
        `${g.displayName} owners who are people (catalogue)`,
        expectedOwners,
        owners.users,
      );
      if (diffs.length || people.length) return outcome(page, check, [...diffs, ...people]);
      return owners.apps
        ? outcome(
            page,
            check,
            [`${g.displayName}: ${owners.apps} app owner(s) beyond the catalogue's people`],
            APP_OWNER_WHY,
          )
        : outcome(page, check, []);
    },
  );
  add(
    'identity.group#owners',
    `${g.displayName}: the owners list shows every owner Graph counts`,
    using('identity.group', 'owners', params, async (v) => {
      const id = await groupId(g.displayName);
      if (!id) return [`${g.displayName}: not found in Graph`];
      const owners = await ownersOf(id);
      // 1.2: { people, apps, total } — people and apps read apart (the type casts), so apps are listed too.
      const o = (v ?? {}) as Row;
      const people = rowsOf(o.people);
      return [
        ...compareValue(
          `${g.displayName} owners listed (Graph: ${owners.users.length} people, ${owners.apps} apps)`,
          owners.users.length + owners.apps,
          people.length + rowsOf(o.apps).length,
        ),
        ...compareValue(`${g.displayName} owner total`, owners.users.length + owners.apps, o.total),
        ...compareSets(
          `${g.displayName} people listed as owners`,
          owners.users,
          people.map(nameOf).filter((n): n is string => !!n),
        ),
      ];
    }),
  );
}
add(
  'identity.group#licensing',
  'AF-Test-Licence-01: one licence with one service plan turned off',
  using('identity.group', 'licensing', { id: '@group:AF-Test-Licence-01' }, (v) => {
    const l = rowsOf((v as Row)?.licences);
    return [
      ...compareValue('licences', 1, l.length),
      ...compareValue('disabled plans', 1, l[0]?.disabledPlans),
    ];
  }),
);

// User pages: manager chain (one disabled manager), department, licences.
for (const u of fixtureUsers.filter((x) => ['04', '05', '06', '08', '09', '10', '11'].includes(x.key))) {
  const params = { id: `@user:${u.displayName}` };
  add(
    'identity.user#profile',
    `${u.displayName}: profile and manager`,
    using('identity.user', 'profile', params, (v) => {
      const p = v as Row;
      const manager = (p.manager as Row | undefined)?.displayName ?? null;
      return [
        ...compareValue(`${u.displayName} manager`, u.managerKey ? userName(u.managerKey) : null, manager),
        ...compareValue(`${u.displayName} enabled`, u.accountEnabled, p.accountEnabled),
        ...compareValue(`${u.displayName} department`, u.attributes.department ?? null, p.department ?? null),
        ...compareValue(
          `${u.displayName} password never expires`,
          Boolean(u.passwordNeverExpires),
          /DisablePasswordExpiration/.test(String(p.passwordPolicies ?? '')),
        ),
      ];
    }),
  );
  const licensed =
    u.directLicence ||
    catalog.groups.some((g) => g.licence && g.members.some((m) => 'user' in m && m.user === u.key));
  add(
    'identity.user#licences',
    `${u.displayName}: licences (${licensed ? 'one' : 'none'})`,
    using('identity.user', 'licences', params, (v) =>
      compareValue(`${u.displayName} licences`, licensed ? 1 : 0, rowsOf(v).length),
    ),
  );
  const memberOf = catalog.groups
    .filter((g) =>
      (g.body.groupTypes as string[]).includes('DynamicMembership')
        ? u.attributes.department === 'AF-Test Sales'
        : g.members.some((m) => 'user' in m && m.user === u.key),
    )
    .map((g) => g.displayName);
  add(
    'identity.user#groups',
    `${u.displayName}: fixture groups it belongs to`,
    using('identity.user', 'groups', params, (v) =>
      compareSets(
        `${u.displayName} groups`,
        memberOf,
        fixtureNames(rowsOf(v).map(nameOf)).filter((n) => catalog.groups.some((g) => g.displayName === n)),
      ),
    ),
  );
}

// Reports over the directory fixtures.
add(
  'identity.disabled-users-with-licences#users',
  'disabled accounts that keep a licence vs Graph',
  using('identity.disabled-users-with-licences', 'users', {}, async (v) => {
    const graphRows = await all<{ displayName: string }>(
      '/users',
      {
        $filter: 'accountEnabled eq false and assignedLicenses/$count ne 0',
        $select: 'displayName',
        $count: 'true',
      },
      EVENTUAL,
    );
    const shown = rowsOf(v)
      .map(nameOf)
      .filter((n): n is string => !!n);
    return [
      ...compareSets(
        'disabled and licensed (Graph)',
        graphRows.map((r) => r.displayName),
        shown,
      ),
      ...compareSets(
        'disabled and licensed fixtures (catalogue)',
        fixtureUsers.filter((u) => !u.accountEnabled && u.directLicence).map((u) => u.displayName),
        fixtureNames(shown),
      ),
    ];
  }),
);

add(
  'identity.groups-without-owners#report',
  'ownerless fixture groups vs Graph and the catalogue',
  async (page, check) => {
    const d = await data('identity.groups-without-owners', 'report', {});
    if ('problem' in d) return { page, check, status: 'unknowable', details: [d.problem] };
    // 2.0: groups with no owner at all and groups owned by apps only (no person) are both listed, apart.
    const rows = rowsOf(d.value).filter((r) => r.noOwners === true);
    const listed = (appOnly: boolean) =>
      fixtureNames(rows.filter((r) => (r.appOnly === true) === appOnly).map(nameOf)).filter((n) =>
        fixtureGroups.some((g) => g.displayName === n),
      );
    const graphOwnerless: string[] = [];
    const appOwnedOnly: string[] = [];
    for (const g of fixtureGroups) {
      const id = await groupId(g.displayName);
      if (!id) continue;
      const o = await ownersOf(id);
      if (!o.users.length && !o.apps) graphOwnerless.push(g.displayName);
      else if (!o.users.length) appOwnedOnly.push(g.displayName);
    }
    return outcome(page, check, [
      ...compareSets('no owner at all (Graph)', graphOwnerless, listed(false)),
      ...compareSets('owned by an app only (Graph)', appOwnedOnly, listed(true)),
      ...compareSets(
        'no person as owner (catalogue)',
        fixtureGroups.filter((g) => !g.owners.length).map((g) => g.displayName),
        [...listed(false), ...listed(true)],
      ),
    ]);
  },
);

add(
  'identity.password-policies#users',
  'passwords that never expire (fixture users) vs Graph',
  // 2.0: one row per account under its most severe finding; the "never expires" view lists every exemption.
  using('identity.password-policies', 'users', { finding: 'neverExpires' }, async (v) => {
    const shown = fixtureNames(
      rowsOf(v)
        .filter((r) => String(r.finding ?? '').startsWith('Never expires'))
        .map(nameOf),
    ).filter((n) => ALL_FIXTURE_USERS.includes(n));
    const graphRows = await all<{ displayName: string; passwordPolicies?: string | null }>('/users', {
      $filter: "startswith(displayName,'AF-Test-User-')",
      $select: 'displayName,passwordPolicies',
    });
    const expected = graphRows
      .filter((r) => /DisablePasswordExpiration/.test(r.passwordPolicies ?? ''))
      .map((r) => r.displayName);
    return [
      ...compareSets('never expires (Graph)', expected, shown),
      ...compareSets(
        'never expires (catalogue ⊆)',
        fixtureUsers.filter((u) => u.passwordNeverExpires).map((u) => u.displayName),
        shown.filter((n) => fixtureUsers.some((u) => u.displayName === n && u.passwordNeverExpires)),
      ),
    ];
  }),
);

// App registrations.
const appNames = [...FIXTURE_APPS.map((a) => a.displayName), SAML_APP.displayName];
add(
  'identity.app-registrations#apps',
  'fixture apps with owner counts and expiry vs the catalogue and Graph',
  using('identity.app-registrations', 'apps', { q: 'AF-Test' }, async (v) => {
    const rows = rowsOf(v);
    const shown = byName(rows);
    const diffs = compareSets('fixture apps', appNames, fixtureNames(rows.map(nameOf)));
    const graphApps = await all<{
      id: string;
      displayName: string;
      passwordCredentials: Row[];
      keyCredentials: Row[];
    }>('/applications', {
      $filter: "startswith(displayName,'AF-Test')",
      $select: 'id,displayName,passwordCredentials,keyCredentials',
    });
    for (const a of graphApps) {
      const r = shown.get(a.displayName);
      if (!r) continue;
      const owners = (await all(`/applications/${a.id}/owners`, { $select: 'id' })).length;
      diffs.push(...compareValue(`${a.displayName} owners (Graph)`, owners, r.ownerCount));
      diffs.push(
        ...compareValue(`${a.displayName} secrets (Graph)`, a.passwordCredentials.length, r.secrets),
      );
      diffs.push(
        ...compareValue(`${a.displayName} certificates (Graph)`, a.keyCredentials.length, r.certificates),
      );
      const spec = FIXTURE_APPS.find((x) => x.displayName === a.displayName);
      if (spec)
        diffs.push(...compareValue(`${a.displayName} owners (catalogue)`, spec.owner ? 1 : 0, r.ownerCount));
      const next = [...a.passwordCredentials, ...a.keyCredentials]
        .map((c) => daysUntil(c.endDateTime, now))
        .filter((d): d is number => d !== undefined)
        .sort((x, y) => x - y)[0];
      if (next !== undefined && typeof r.nextExpiryDays === 'number')
        diffs.push(
          ...compareRange(
            `${a.displayName} days to next expiry (Graph ${next})`,
            r.nextExpiryDays,
            next - 1,
            next + 1,
          ),
        );
    }
    return diffs;
  }),
);

add(
  'identity.app-credential-expiry#credentials',
  'AF-Test-App-Expiring: its secret and certificate are listed as expiring',
  using('identity.app-credential-expiry', 'credentials', {}, async (v) => {
    const rows = rowsOf(v).filter((r) => r.app === 'AF-Test-App-Expiring');
    const [a] = await all<{ passwordCredentials: Row[]; keyCredentials: Row[] }>('/applications', {
      $filter: "displayName eq 'AF-Test-App-Expiring'",
      $select: 'passwordCredentials,keyCredentials',
    });
    const expected = [...(a?.passwordCredentials ?? []), ...(a?.keyCredentials ?? [])].filter((c) => {
      const d = daysUntil(c.endDateTime, now);
      return d !== undefined && d >= 0 && d <= 30;
    }).length;
    return compareValue(
      'AF-Test-App-Expiring credentials expiring within 30 days (Graph)',
      expected,
      rows.length,
    );
  }),
);

add(
  'identity.app-credential-hygiene#page',
  'AF-Test-App-Hygiene: three secrets, one long-lived',
  using('identity.app-credential-hygiene', 'page', {}, (v) => {
    // 2.0: one row per flagged credential, with the app's live secret count.
    const rows = rowsOf(v).filter((r) => r.displayName === 'AF-Test-App-Hygiene');
    const spec = FIXTURE_APPS.find((a) => a.key === 'hygiene')!;
    return [
      ...compareValue('hygiene secrets', spec.secrets.length, rows.length),
      ...compareValue(
        'several secrets flagged',
        spec.secrets.length,
        rows.filter((r) => typeof r.liveSecrets === 'number' && r.liveSecrets > 1).length,
      ),
      ...compareValue(
        'long-lived (> 1 year) flagged',
        spec.secrets.filter((s) => s.days > 366).length,
        rows.filter((r) => r.long === true).length,
      ),
    ];
  }),
);

add(
  'identity.app-registration-risks#apps',
  'AF-Test-App-Risky: implicit grant, public client, http redirect, critical permission',
  using('identity.app-registration-risks', 'apps', {}, (v) => {
    const rows = rowsOf(v);
    const risky = rows.find((r) => nameOf(r) === 'AF-Test-App-Risky');
    if (!risky) return ['AF-Test-App-Risky: not listed'];
    return [
      ...compareValue(
        'only the risky fixture app listed',
        ['AF-Test-App-Risky'],
        fixtureNames(rows.map(nameOf)).filter((n) => appNames.includes(n)),
      ),
      ...compareRange('http or wildcard redirect URIs', risky.wildcardOrHttp, 1, 1),
      ...compareValue(
        'critical permission requested',
        ['Mail.ReadWrite'],
        (risky.criticalPermissions as unknown[] | undefined)?.map(String) ?? [],
      ),
    ];
  }),
);

add(
  'identity.apps-without-owners#report',
  'ownerless fixture apps vs the catalogue and Graph',
  using('identity.apps-without-owners', 'report', {}, async (v) => {
    const shown = fixtureNames(rowsOf(v).map(nameOf)).filter((n) => appNames.includes(n));
    const graphApps = await all<{ id: string; displayName: string }>('/applications', {
      $filter: "startswith(displayName,'AF-Test')",
      $select: 'id,displayName',
    });
    const graphOwnerless: string[] = [];
    for (const a of graphApps)
      if (!(await all(`/applications/${a.id}/owners`, { $select: 'id' })).length)
        graphOwnerless.push(a.displayName);
    return [
      ...compareSets('ownerless (Graph)', graphOwnerless, shown),
      ...compareSets(
        'ownerless (catalogue ⊆)',
        FIXTURE_APPS.filter((a) => !a.owner).map((a) => a.displayName),
        shown.filter((n) => FIXTURE_APPS.some((a) => a.displayName === n)),
      ),
    ];
  }),
);

add(
  'identity.enterprise-apps#apps',
  `${SAML_APP.displayName}: SAML signing certificate days and assignment required vs Graph`,
  using('identity.enterprise-apps', 'apps', { q: 'AF-Test' }, async (v) => {
    const row = rowsOf(v).find((r) => nameOf(r) === SAML_APP.displayName);
    if (!row) return [`${SAML_APP.displayName}: not listed`];
    const [sp] = await all<{ keyCredentials: Row[]; appRoleAssignmentRequired: boolean }>(
      '/servicePrincipals',
      {
        $filter: `displayName eq '${SAML_APP.displayName}'`,
        $select: 'keyCredentials,appRoleAssignmentRequired',
      },
    );
    const days = (sp?.keyCredentials ?? [])
      .filter((k) => k.usage === 'Sign')
      .map((k) => daysUntil(k.endDateTime, now))
      .filter((d): d is number => d !== undefined);
    const diffs = compareValue(
      'assignment required (Graph)',
      sp?.appRoleAssignmentRequired,
      row.appRoleAssignmentRequired,
    );
    if (days.length)
      diffs.push(
        ...compareRange(
          `signing certificate days (Graph ${Math.min(...days)}–${Math.max(...days)})`,
          row.signingCertDays,
          Math.min(...days) - 1,
          Math.max(...days) + 1,
        ),
      );
    diffs.push(
      ...compareRange(
        'signing certificate days (catalogue)',
        row.signingCertDays,
        0,
        SAML_APP.signingCertificate.withinDays,
      ),
    );
    return diffs;
  }),
);

// Conditional Access, named locations.
add(
  'identity.conditional-access#policies',
  'the AF-Audit example policies, all report-only, vs the catalogue and Graph',
  using('identity.conditional-access', 'policies', { q: 'AF-Audit' }, async (v) => {
    const rows = rowsOf(v);
    const graphPolicies = await all<{ displayName: string; state: string }>(
      '/identity/conditionalAccess/policies',
      { $select: 'displayName,state' },
    );
    const audit = graphPolicies.filter((p) => p.displayName.startsWith('AF-Audit'));
    return [
      ...compareSets(
        'AF-Audit policies (catalogue)',
        CA_AUDIT_POLICIES.map((p) => p.displayName),
        fixtureNames(rows.map(nameOf)),
      ),
      ...compareSets(
        'AF-Audit policies (Graph)',
        audit.map((p) => p.displayName),
        fixtureNames(rows.map(nameOf)),
      ),
      ...compareValue(
        'report-only (Graph)',
        audit.filter((p) => p.state === 'enabledForReportingButNotEnforced').length,
        rows.filter((r) => /report/i.test(String(r.state))).length,
      ),
    ];
  }),
);
add(
  'identity.health#ca',
  'identity overview: Conditional Access policy states vs Graph',
  using('identity.health', 'ca', {}, async (v) => {
    const c = v as Row;
    const p = await all<{ state: string }>('/identity/conditionalAccess/policies', { $select: 'state' });
    return [
      ...compareValue('enforced', p.filter((x) => x.state === 'enabled').length, c.enabled),
      ...compareValue(
        'report-only',
        p.filter((x) => x.state === 'enabledForReportingButNotEnforced').length,
        c.reportOnly,
      ),
    ];
  }),
);
add(
  'identity.named-locations#locations',
  `${NAMED_LOCATION.displayName} with ${NAMED_LOCATION.cidr}`,
  using('identity.named-locations', 'locations', {}, (v) => {
    const row = rowsOf(v).find((r) => nameOf(r) === NAMED_LOCATION.displayName);
    if (!row) return [`${NAMED_LOCATION.displayName}: not listed`];
    return compareValue(
      `${NAMED_LOCATION.displayName} range`,
      true,
      JSON.stringify(row).includes(NAMED_LOCATION.cidr),
    );
  }),
);

// Licences and seats.
add(
  'm365.licences#skus',
  'seats enabled and assigned per SKU vs Graph subscribedSkus',
  using('m365.licences', 'skus', {}, async (v) => {
    const rows = rowsOf(v);
    const skus = await all<{
      skuPartNumber: string;
      consumedUnits: number;
      prepaidUnits: { enabled: number };
    }>('/subscribedSkus');
    const diffs: Difference[] = [];
    for (const s of skus) {
      const r = rows.find((x) => x.skuPartNumber === s.skuPartNumber);
      if (!r) {
        diffs.push(`${s.skuPartNumber}: not listed`);
        continue;
      }
      diffs.push(...compareValue(`${s.skuPartNumber} assigned`, s.consumedUnits, r.consumed));
      diffs.push(...compareValue(`${s.skuPartNumber} enabled`, s.prepaidUnits.enabled, r.enabled));
    }
    return diffs;
  }),
);

// Sign-ins of the sign-in accounts.
const accounts = signInAccounts(domain);
add(
  'identity.sign-ins#signIns',
  'the sign-in accounts’ sign-ins (7 days): count and failures vs Graph',
  using(
    'identity.sign-ins',
    'signIns',
    { range: 'P7D', user: 'af-test-signin' },
    async (v) => {
      const rows = rowsOf(v);
      const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
      const graphRows = await all<{ status?: { errorCode?: number }; userDisplayName?: string }>(
        '/auditLogs/signIns',
        {
          $filter: `createdDateTime ge ${since} and startswith(userPrincipalName,'af-test-signin')`,
          $select: 'id,status,userDisplayName',
        },
      );
      const failures = (list: Array<{ status?: unknown }>) =>
        list.filter((r) => ((r.status as { errorCode?: number } | undefined)?.errorCode ?? 0) !== 0).length;
      return [
        ...compareValue('sign-ins (Graph)', graphRows.length, rows.length),
        ...compareValue('failed sign-ins (Graph)', failures(graphRows), failures(rows)),
        ...compareSets(
          'accounts seen (Graph)',
          fixtureNames(graphRows.map((r) => r.userDisplayName)),
          fixtureNames(rows.map((r) => r.userDisplayName as string)),
        ),
        ...compareSets(
          'accounts seen (catalogue)',
          accounts.map((a) => a.displayName),
          fixtureNames(rows.map((r) => r.userDisplayName as string)),
        ),
      ];
    },
    'Microsoft delivers sign-in logs with a delay (usually minutes, up to about two hours); re-run later before treating a missing account as a bug',
  ),
);

// PIM eligibility (fixture: AF-Test-User-01 eligible for Reports Reader).
add(
  'identity.pim#tenant',
  'eligible role assignments vs Graph',
  using('identity.pim', 'tenant', {}, async (v) => {
    const eligible = rowsOf((v as Row)?.eligible);
    const graphRows = await all<{ principalId: string }>(
      '/roleManagement/directory/roleEligibilityScheduleInstances',
      { $select: 'principalId' },
    );
    return [
      ...compareValue('eligible assignments (Graph)', graphRows.length, eligible.length),
      ...compareValue(
        'AF-Test-User-01 eligible',
        true,
        eligible.some((r) => r.principalName === 'AF-Test-User-01' && r.role === 'Reports Reader'),
      ),
    ];
  }),
);

// Authentication methods (fixture: an SMS number on AF-Test-User-02, a Temporary Access Pass on AF-Test-User-03).
for (const [user, method] of [
  ['AF-Test-User-02', /phone|sms/i],
  ['AF-Test-User-03', /temporary access pass|tap/i],
] as const)
  add(
    'identity.user#auth',
    `${user}: its fixture authentication method`,
    using('identity.user', 'auth', { id: `@user:${user}` }, async (v) => {
      const methods = rowsOf((v as Row)?.methods);
      return compareValue(
        `${user} has the fixture method`,
        true,
        methods.some((m) => method.test(`${m.method ?? ''} ${m.detail ?? ''}`)),
      );
    }),
  );

// Intune fixture policies (the validation user needs an Intune read role; without one these are not knowable).
const compliance = [
  INTUNE_POLICIES.compliance.displayName,
  ...INTUNE_MORE.filter((p) => /compliance/i.test(p.path)).map((p) => p.displayName),
];
add(
  'endpoint.compliance#policies',
  'the AF-Test compliance policies are listed',
  using('endpoint.compliance', 'policies', {}, (v) =>
    compareSets('AF-Test compliance policies', compliance, fixtureNames(rowsOf(v).map(nameOf))),
  ),
);
add(
  'endpoint.configuration#profiles',
  'the AF-Test configuration profile and update ring are listed',
  using('endpoint.configuration', 'profiles', { q: 'AF-Test' }, (v) =>
    compareSets(
      'AF-Test configuration profiles',
      [
        INTUNE_POLICIES.configuration.displayName,
        ...INTUNE_MORE.filter((p) => /deviceConfigurations/.test(p.path)).map((p) => p.displayName),
      ],
      fixtureNames(rowsOf(v).map(nameOf)),
    ),
  ),
);

// Reports added in Phase E (not knowable until they are published on this AdminForge).
const reportsTo = (key: string) =>
  fixtureUsers.filter((u) => u.managerKey === key && u.accountEnabled).map((u) => u.displayName);
const disabledManagers = fixtureUsers.filter((u) => !u.accountEnabled).map((u) => u.key);
add(
  'identity.user-attribute-completeness#managers',
  'fixture users whose manager is disabled',
  // The manager check only runs when asked for (`managers: true`, a slower read).
  using('identity.user-attribute-completeness', 'managers', { managers: true }, (v) => {
    const expected = disabledManagers.flatMap(reportsTo);
    const shown = fixtureNames(
      rowsOf(v)
        .filter((r) => r.issue === 'disabledManager')
        .map(nameOf),
    );
    return compareSets(
      'disabled manager',
      expected,
      shown.filter((n) => ALL_FIXTURE_USERS.includes(n)),
    );
  }),
);
add(
  'identity.saml-certificate-expiry#apps',
  `${SAML_APP.displayName}: signing certificate expires within the window`,
  using('identity.saml-certificate-expiry', 'apps', {}, (v) =>
    rowsOf(v).some((r) => nameOf(r) === SAML_APP.displayName) ? [] : [`${SAML_APP.displayName}: not listed`],
  ),
);
add(
  'identity.licence-assignment-errors#report',
  'no licence errors on the fixture users',
  using('identity.licence-assignment-errors', 'report', {}, (v) =>
    compareSets(
      'fixture users with licence errors',
      [],
      fixtureNames(rowsOf(v).map(nameOf)).filter((n) => ALL_FIXTURE_USERS.includes(n)),
    ),
  ),
);

// Data Microsoft computes later: compared, but a difference is documented, not a failure.
add(
  'identity.auth-registration#byFeature',
  'registration report total vs Graph userRegistrationDetails',
  using(
    'identity.auth-registration',
    'byFeature',
    {},
    async (v) => {
      const n = (
        await all('/reports/authenticationMethods/userRegistrationDetails', {
          $select: 'id',
          $filter: "userType eq 'member'",
        })
      ).length;
      return compareValue('member registration rows', n, (v as Row).total);
    },
    'Microsoft refreshes the registration report every few hours; new accounts appear 24–48 h later',
  ),
);

// ── run ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const outcomes: Outcome[] = [];
try {
  for (const c of checks) {
    if (only.length && !only.some((o) => c.page.includes(o))) continue;
    try {
      outcomes.push(await c.run());
    } catch (err) {
      outcomes.push({
        page: c.page,
        check: c.check,
        status: 'unknowable',
        details: [`could not compare: ${maskError(err, { max: 140 })}`],
      });
    }
  }
} finally {
  await session.close();
}
for (const line of formatOutcomes(outcomes)) console.log(mask(line));
process.exitCode = exitCodeFor(outcomes);
