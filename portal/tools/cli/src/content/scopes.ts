/**
 * The permission comparison behind `adminforge validate --scopes`: what content declares (`requires.scopes`, per app:
 * schedules, probes and feeds → automation identity, write playbooks and runbooks → Write app, everything else → Read
 * app; `appFor`) versus what is granted in Entra (delegated consent grants and app-role assignments, read with the
 * provisioner's Graph client) versus what provisioning would grant (`provisionedScopes`: the same
 * `desiredPermissions` rule as `provision entra`, ceilings included).
 *
 * `declaredScopes` and `compareScopes` are pure; `consentedScopes` only reads Graph. Also used by `provision entra`
 * (which files declare a permission, for its warnings) and by tests that keep the catalog and content aligned.
 */
import type { GraphClient } from '@adminforge/connectors';
import type { LoadedDefinition, Scopes } from '@adminforge/schemas';
import { AUTOMATION_BUILTIN_USES, RESOURCES, type ResourceKey } from '../provision/catalog';
import {
  baselinePermissions,
  CEILINGS,
  desiredPermissions,
  type CeilingSettings,
  type ContentScopes,
} from '../provision/entra-desired';

/** Services whose permissions `validate --scopes` compares (connections use their own audiences and are not checked). */
export const SCOPE_SERVICES = [
  'graph',
  'arm',
  'logAnalytics',
  'exchange',
  'teams',
  'sharepointAdmin',
] as const;
export type ScopeService = (typeof SCOPE_SERVICES)[number];
export type ScopeApp = 'read' | 'write' | 'automation';

/** Microsoft first-party resource app ids (identical in every tenant). */
export const RESOURCE_APP_IDS: Record<ScopeService, string> = {
  graph: RESOURCES.graph.appId,
  arm: RESOURCES.arm.appId,
  logAnalytics: RESOURCES.logAnalytics.appId,
  exchange: RESOURCES.exchange.appId,
  teams: '48ac35b8-9aa8-4d74-927d-1f4a14a0b239',
  sharepointAdmin: '00000003-0000-0ff1-ce00-000000000000',
};
const SERVICE_BY_APP_ID = new Map(Object.entries(RESOURCE_APP_IDS).map(([s, id]) => [id, s as ScopeService]));

const RESOURCE_SERVICE: Record<ResourceKey, ScopeService> = {
  graph: 'graph',
  arm: 'arm',
  logAnalytics: 'logAnalytics',
  exchange: 'exchange',
  teams: 'teams',
  sharepoint: 'sharepointAdmin',
};
/** Provisioning's resource key → the service key content uses in `requires.scopes`. */
export const serviceForResource = (resource: ResourceKey): ScopeService => RESOURCE_SERVICE[resource];

/** Sign-in scopes every delegated app holds; never reported as unused. */
const OIDC = new Set(['openid', 'profile', 'offline_access', 'email', 'user.read']);

export type ScopeSet = Record<ScopeApp, Partial<Record<ScopeService, Set<string>>>>;
export const emptyScopeSet = (): ScopeSet => ({ read: {}, write: {}, automation: {} });

export interface Declared {
  scopes: ScopeSet;
  /** `app:service:scope` → files declaring it. */
  files: Map<string, string[]>;
  /** Connection scopes (own audiences) are listed, not checked. */
  connections: string[];
}

/** Which app a definition's `requires.scopes` belong to: schedules/probes/feeds → automation identity; write content → Write app. */
export function appFor(def: LoadedDefinition['def']): ScopeApp {
  if (def.kind === 'schedule' || def.kind === 'probe' || def.kind === 'feed') return 'automation';
  if ((def.kind === 'playbook' || def.kind === 'runbook') && def.mode === 'write') return 'write';
  return 'read';
}

export function declaredScopes(defs: readonly LoadedDefinition[]): Declared {
  const scopes = emptyScopeSet();
  const files = new Map<string, string[]>();
  const connections = new Set<string>();
  const add = (app: ScopeApp, s: Scopes | undefined, file: string) => {
    for (const service of SCOPE_SERVICES) {
      for (const scope of s?.[service] ?? []) {
        (scopes[app][service] ??= new Set()).add(scope);
        const k = `${app}:${service}:${scope}`;
        files.set(k, [...(files.get(k) ?? []), file]);
      }
    }
    for (const id of Object.keys(s?.connections ?? {})) connections.add(id);
  };
  for (const d of defs) {
    add(appFor(d.def), d.def.requires?.scopes, d.file);
    // Datasource-level requirements belong to the same app as their page.
    if ('datasources' in d.def)
      for (const ds of Object.values(d.def.datasources ?? {}))
        add(appFor(d.def), ds.requires?.scopes, d.file);
  }
  return { scopes, files, connections: [...connections].sort() };
}

/** `X.ReadWrite.Y` also grants `X.Read.Y` (and `.All` variants); other names must match exactly (case-insensitive). */
function satisfied(have: Set<string>, scope: string): boolean {
  const lower = new Set([...have].map((s) => s.toLowerCase()));
  const want = scope.toLowerCase();
  return (
    lower.has(want) ||
    lower.has(want.replace('.read.', '.readwrite.')) ||
    (want.endsWith('.read') && lower.has(`${want.slice(0, -5)}.readwrite`))
  );
}

export interface ScopeFinding {
  app: ScopeApp;
  service: ScopeService;
  scope: string;
  files?: string[];
}

export interface ScopeComparison {
  /** Declared, expected by provisioning, and not granted: `provision entra` fixes it. */
  missing: ScopeFinding[];
  /** Granted, but neither declared by content nor expected by provisioning (or, without `provisioned`, not declared). */
  unused: ScopeFinding[];
  /** Declared, but a ceiling withholds it (provisioning skips it too); `reason` names the env key. */
  withheld: Array<ScopeFinding & { reason: string }>;
  /** Declared for a workload whose resource service principal is not in this tenant (provisioning skips it too). */
  unlicensed: ScopeFinding[];
  /** Granted by provisioning's baseline (catalog.ts) though no content declares it; `builtin` = code relies on it. */
  baseline: Array<ScopeFinding & { builtin?: string }>;
}

/** What provisioning expects for each app (provision/entra-desired.ts desiredPermissions), as scope sets. */
export interface Provisioned {
  /** Everything provisioning requests (baseline ∪ content ∪ read-only scopes of write content), after the ceilings. */
  expected: ScopeSet;
  /** The baseline alone. */
  baseline: ScopeSet;
  /** `app:service:scope` (lower case) → why a ceiling withholds it. */
  withheld: Map<string, string>;
}

/** Pure: the same desired permissions `provision entra` computes, keyed like content declarations. */
export function provisionedScopes(settings: CeilingSettings, declared: ScopeSet): Provisioned {
  const { requests, withheld } = desiredPermissions(settings, declared as ContentScopes);
  const toSet = (reqs: Record<ScopeApp, Array<{ resource: ResourceKey; values: readonly string[] }>>) => {
    const set = emptyScopeSet();
    for (const app of ['read', 'write', 'automation'] as const)
      for (const r of reqs[app])
        for (const v of r.values) (set[app][serviceForResource(r.resource)] ??= new Set()).add(v);
    return set;
  };
  return {
    expected: toSet(requests),
    baseline: toSet(baselinePermissions()),
    withheld: new Map(
      withheld.map((w) => [
        `${w.app}:${serviceForResource(w.resource)}:${w.value}`.toLowerCase(),
        CEILINGS[w.ceiling].reason,
      ]),
    ),
  };
}

const has = (set: Set<string> | undefined, scope: string) =>
  [...(set ?? [])].some((s) => s.toLowerCase() === scope.toLowerCase());

/**
 * Declared-but-not-consented (missing) and consented-but-not-declared (unused), per app and service. With
 * `provisioned` (and `present`, the resources that exist in the tenant) the comparison agrees with `provision entra`:
 * withheld and unlicensed permissions aren't "missing", and what provisioning grants on purpose — the read-only scopes
 * of write content on the Read app, the baseline — isn't "unused" (the baseline is listed separately).
 */
export function compareScopes(
  declared: Declared,
  consented: ScopeSet,
  provisioned?: Provisioned,
  present?: ReadonlySet<ScopeService>,
): ScopeComparison {
  const out: ScopeComparison = { missing: [], unused: [], withheld: [], unlicensed: [], baseline: [] };
  for (const app of ['read', 'write', 'automation'] as const) {
    for (const service of SCOPE_SERVICES) {
      const want = declared.scopes[app][service] ?? new Set<string>();
      const have = consented[app][service] ?? new Set<string>();
      for (const scope of [...want].sort()) {
        if (satisfied(have, scope)) continue;
        const finding = { app, service, scope, files: declared.files.get(`${app}:${service}:${scope}`) };
        const reason = provisioned?.withheld.get(`${app}:${service}:${scope}`.toLowerCase());
        if (reason) out.withheld.push({ ...finding, reason });
        else if (present && !present.has(service)) out.unlicensed.push(finding);
        else out.missing.push(finding);
      }
      for (const scope of [...have].sort()) {
        if (OIDC.has(scope.toLowerCase())) continue;
        const used = [...want].some(
          (w) => w.toLowerCase() === scope.toLowerCase() || satisfied(new Set([scope]), w),
        );
        if (used) continue;
        if (provisioned && has(provisioned.expected[app][service], scope)) {
          if (has(provisioned.baseline[app][service], scope))
            out.baseline.push({
              app,
              service,
              scope,
              builtin:
                app === 'automation' && service === 'graph' ? AUTOMATION_BUILTIN_USES[scope] : undefined,
            });
          // Otherwise derived on purpose (read-only scopes of write content: dry runs read with the Read app).
          continue;
        }
        out.unused.push({ app, service, scope });
      }
    }
  }
  return out;
}

interface Sp {
  id: string;
  appId: string;
  appRoles?: Array<{ id: string; value?: string | null }>;
}

const odata = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * What Entra actually granted: tenant-wide delegated grants (oauth2PermissionGrants, AllPrincipals) for the Read and
 * Write apps, and application permissions (appRoleAssignments) for the automation identity. Read with the provisioner.
 */
export async function consentedScopes(
  graph: GraphClient,
  apps: Partial<Record<ScopeApp, string>>,
): Promise<{ scopes: ScopeSet; notFound: ScopeApp[]; present: Set<ScopeService> }> {
  const scopes = emptyScopeSet();
  const notFound: ScopeApp[] = [];
  // Which Microsoft resources exist here: unlicensed workloads have no service principal (provisioning skips them).
  const present = new Set<ScopeService>();
  for (const service of SCOPE_SERVICES) {
    const r = await graph.request<{ value?: Sp[] }>({
      path: '/servicePrincipals',
      query: { $filter: `appId eq ${odata(RESOURCE_APP_IDS[service])}`, $select: 'id,appId' },
    });
    if (r.data.value?.length) present.add(service);
  }
  const resources = new Map<string, Sp | null>();
  const resource = async (id: string) => {
    if (!resources.has(id)) {
      const r = await graph
        .request<Sp>({
          path: `/servicePrincipals/${encodeURIComponent(id)}`,
          query: { $select: 'id,appId,appRoles' },
        })
        .catch(() => null);
      resources.set(id, r?.data ?? null);
    }
    return resources.get(id) ?? null;
  };
  for (const app of ['read', 'write', 'automation'] as const) {
    const appId = apps[app];
    if (!appId) continue;
    const found = await graph.request<{ value: Sp[] }>({
      path: '/servicePrincipals',
      query: { $filter: `appId eq ${odata(appId)}`, $select: 'id,appId' },
    });
    const sp = found.data.value?.[0];
    if (!sp) {
      notFound.push(app);
      continue;
    }
    if (app === 'automation') {
      const assignments = await graph.all<{ resourceId: string; appRoleId: string }>({
        path: `/servicePrincipals/${encodeURIComponent(sp.id)}/appRoleAssignments`,
      });
      for (const a of assignments) {
        const res = await resource(a.resourceId);
        const service = res ? SERVICE_BY_APP_ID.get(res.appId) : undefined;
        const value = res?.appRoles?.find((r) => r.id === a.appRoleId)?.value;
        if (service && value) (scopes.automation[service] ??= new Set()).add(value);
      }
    } else {
      const grants = await graph.all<{ resourceId: string; scope?: string; consentType?: string }>({
        path: '/oauth2PermissionGrants',
        query: { $filter: `clientId eq ${odata(sp.id)}` },
      });
      for (const g of grants.filter((x) => x.consentType === 'AllPrincipals')) {
        const res = await resource(g.resourceId);
        const service = res ? SERVICE_BY_APP_ID.get(res.appId) : undefined;
        if (!service) continue;
        for (const s of (g.scope ?? '').split(/\s+/).filter(Boolean))
          (scopes[app][service] ??= new Set()).add(s);
      }
    }
  }
  return { scopes, notFound, present };
}
