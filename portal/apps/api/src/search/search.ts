import { RESOURCE_GRAPH_API_VERSION, RESOURCE_GRAPH_PATH } from '@adminforge/connectors';
import { odataSearchEscape } from '@adminforge/expressions';
import type { Definition } from '@adminforge/schemas';
import { hasRole } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import type { DefinitionRecord, DefinitionRegistry } from '../definitions/types';
import type { OutboundExecutor } from '../execution/types';
import { kqlString } from '../datasources/advanced';
import { definitionHref } from '../routes/nav';

export const SEARCH_TYPES = [
  'page',
  'dashboard',
  'report',
  'playbook',
  'runbook',
  'user',
  'group',
  'device',
  'app',
  'resource',
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchResult {
  type: SearchType;
  /** Definition key, object id, or Azure resource id. */
  id?: string;
  title: string;
  subtitle?: string;
  /** In-app route, or an https deep link into the Entra / Azure portals (`external: true`). */
  href: string;
  external?: boolean;
  icon?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  /** Per source: ok | timeout | error | skipped (type filter, query too short, or no permission). */
  sources: Record<'definitions' | 'directory' | 'azure', 'ok' | 'timeout' | 'error' | 'skipped'>;
}

const DEF_KINDS = new Set<SearchType>(['page', 'dashboard', 'report', 'playbook', 'runbook']);
const DIRECTORY = new Set<SearchType>(['user', 'group', 'device', 'app']);
const PER_SOURCE = 6;

/** Entity pages the palette opens when they exist in content; otherwise it deep-links to the Microsoft portal. */
const ENTITY_PAGES: Record<'user' | 'group' | 'device' | 'app' | 'resource', string> = {
  user: 'identity.user',
  group: 'identity.group',
  device: 'identity.device',
  app: 'identity.app-registration',
  resource: 'azure.resource',
};
const PORTAL_LINKS = {
  user: (id: string) =>
    `https://entra.microsoft.com/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${encodeURIComponent(id)}`,
  group: (id: string) =>
    `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/${encodeURIComponent(id)}`,
  device: (id: string) =>
    `https://entra.microsoft.com/#view/Microsoft_AAD_Devices/DeviceDetailsMenuBlade/~/Properties/objectId/${encodeURIComponent(id)}`,
  app: (appId: string) =>
    `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/${encodeURIComponent(appId)}`,
  resource: (id: string) =>
    `https://portal.azure.com/#@/resource${id.split('/').map(encodeURIComponent).join('/')}`,
};

/** KQL string literal quoting (shared with the query builder compiler). */
export { kqlString };

function score(def: Definition, q: string): number {
  const title = def.title.toLowerCase();
  const nav = ((def as { nav?: { label?: string } }).nav?.label ?? '').toLowerCase();
  if (title === q || nav === q) return 100;
  if (title.startsWith(q) || nav.startsWith(q)) return 80;
  if (title.includes(q) || nav.includes(q)) return 60;
  if (def.id.toLowerCase().includes(q)) return 40;
  if (def.tags?.some((t) => t.toLowerCase().includes(q))) return 30;
  if (def.summary?.toLowerCase().includes(q)) return 10;
  return 0;
}

/** Pages that need context (a required param without a default, e.g. an entity id) are not palette targets. */
const needsContext = (def: Definition) =>
  'params' in def &&
  Object.values(def.params ?? {}).some(
    (p) =>
      (p as { required?: boolean; default?: unknown }).required &&
      (p as { default?: unknown }).default === undefined,
  );

export function searchDefinitions(
  records: DefinitionRecord[],
  q: string,
  roles: string[],
  types: ReadonlySet<SearchType>,
): SearchResult[] {
  const needle = q.trim().toLowerCase();
  // Every role in requires.portalRoles: the rule the page or playbook itself enforces.
  const allowed = (r: DefinitionRecord) =>
    (r.def.requires?.portalRoles ?? []).every((role) => hasRole({ roles }, role));
  return records
    .filter((r) => DEF_KINDS.has(r.kind as SearchType) && types.has(r.kind as SearchType))
    .filter((r) => r.def.status !== 'draft' && !needsContext(r.def))
    .filter(allowed)
    .map((r) => ({ r, s: needle ? score(r.def, needle) : 1 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.r.def.title.localeCompare(b.r.def.title))
    .slice(0, PER_SOURCE * 2)
    .map(({ r }) => ({
      type: r.kind as SearchType,
      id: r.key,
      title: r.def.title,
      ...(r.def.summary ? { subtitle: r.def.summary } : {}),
      href: definitionHref(r.kind, r.key),
      ...((r.def as { nav?: { icon?: string } }).nav?.icon
        ? { icon: (r.def as { nav?: { icon?: string } }).nav!.icon }
        : {}),
    }));
}

async function timeboxed<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<{ status: 'ok'; value: T } | { status: 'timeout' | 'error' }> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ status: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      ac.abort(new Error('search source timed out'));
      resolve({ status: 'timeout' });
    }, ms);
  });
  try {
    return await Promise.race([run(ac.signal).then((value) => ({ status: 'ok' as const, value })), timeout]);
  } catch {
    return { status: ac.signal.aborted ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
  }
}

interface GraphObject {
  id?: string;
  appId?: string;
  displayName?: string;
  userPrincipalName?: string;
  mail?: string;
  operatingSystem?: string;
}

export interface SearchDeps {
  definitions: DefinitionRegistry;
  outbound: OutboundExecutor;
  timeoutMs: number;
  /** DATA_MODE=fixtures: fixtures ignore $search, so results are filtered here. */
  fixtures?: boolean;
}

/**
 * Command palette fan-out (§9): definitions (local), Entra users/groups/devices/apps (one Graph `$batch` with
 * `$search`) and Azure resources (Resource Graph). Every source is time-boxed; a slow or forbidden source is reported
 * in `sources` and never fails the search.
 */
export async function search(
  deps: SearchDeps,
  session: SessionRecord,
  query: string,
  opts: { type?: SearchType; correlationId?: string } = {},
): Promise<SearchResponse> {
  const q = query.trim().slice(0, 100);
  const types = new Set<SearchType>(opts.type ? [opts.type] : SEARCH_TYPES);
  const identity = { kind: 'delegated' as const, session, mode: 'read' as const };
  const sources: SearchResponse['sources'] = {
    definitions: 'skipped',
    directory: 'skipped',
    azure: 'skipped',
  };
  const entityPages = new Map<string, Promise<string | null>>();
  const entityPage = (kind: keyof typeof ENTITY_PAGES) => {
    let p = entityPages.get(kind);
    if (!p) {
      p = (async () => {
        for (const k of ['page', 'dashboard', 'report'] as const)
          if (await deps.definitions.get(k, ENTITY_PAGES[kind])) return ENTITY_PAGES[kind];
        return null;
      })();
      entityPages.set(kind, p);
    }
    return p;
  };
  const entityHref = async (
    kind: keyof typeof ENTITY_PAGES,
    id: string,
    linkId = id,
  ): Promise<Pick<SearchResult, 'href' | 'external'>> => {
    const page = await entityPage(kind);
    return page
      ? { href: `/p/${page}?id=${encodeURIComponent(id)}` }
      : { href: PORTAL_LINKS[kind](linkId), external: true };
  };

  const tasks: Array<Promise<SearchResult[]>> = [];

  if ([...types].some((t) => DEF_KINDS.has(t))) {
    tasks.push(
      timeboxed(deps.timeoutMs, async () => {
        const lists = await Promise.all(
          (['page', 'dashboard', 'report', 'playbook', 'runbook'] as const).map((k) =>
            deps.definitions.list(k),
          ),
        );
        return searchDefinitions(lists.flat(), q, session.roles, types);
      }).then((r) => {
        sources.definitions = r.status;
        return r.status === 'ok' ? r.value : [];
      }),
    );
  }

  const dirTypes = [...types].filter((t) => DIRECTORY.has(t));
  if (dirTypes.length && q.length >= 2) {
    const term = odataSearchEscape(q);
    const eventual = { ConsistencyLevel: 'eventual' };
    const spec = {
      user: {
        path: '/users',
        query: {
          $search: `"displayName:${term}" OR "userPrincipalName:${term}"`,
          $select: 'id,displayName,userPrincipalName',
          $top: PER_SOURCE,
        },
      },
      group: {
        path: '/groups',
        query: {
          $search: `"displayName:${term}" OR "mail:${term}"`,
          $select: 'id,displayName,mail',
          $top: PER_SOURCE,
        },
      },
      device: {
        path: '/devices',
        query: {
          $search: `"displayName:${term}"`,
          $select: 'id,displayName,operatingSystem',
          $top: PER_SOURCE,
        },
      },
      app: {
        path: '/applications',
        query: { $search: `"displayName:${term}"`, $select: 'id,appId,displayName', $top: PER_SOURCE },
      },
    } as const;
    const requests = dirTypes.map((t) => ({
      id: t,
      method: 'GET',
      ...spec[t as keyof typeof spec],
      headers: eventual,
    }));
    tasks.push(
      timeboxed(deps.timeoutMs, async (signal) => {
        const res = await deps.outbound.execute<{
          responses: Array<{ id: string; status: number; body: unknown }>;
        }>(
          identity,
          { service: 'graph', method: 'POST', path: '/$batch', body: { requests } },
          { correlationId: opts.correlationId, signal },
        );
        const out: SearchResult[] = [];
        const needle = q.toLowerCase();
        for (const r of res.data.responses) {
          if (r.status < 200 || r.status >= 300) continue;
          const type = r.id as 'user' | 'group' | 'device' | 'app';
          let rows = ((r.body as { value?: GraphObject[] } | undefined)?.value ?? []).filter(
            (o) => o.id && o.displayName,
          );
          if (deps.fixtures)
            rows = rows.filter((o) =>
              [o.displayName, o.userPrincipalName, o.mail].some((v) => v?.toLowerCase().includes(needle)),
            );
          for (const o of rows.slice(0, PER_SOURCE)) {
            const link = await entityHref(type, o.id!, type === 'app' ? (o.appId ?? o.id!) : o.id!);
            out.push({
              type,
              id: o.id!,
              title: o.displayName!,
              ...(o.userPrincipalName || o.mail || o.operatingSystem || o.appId
                ? { subtitle: o.userPrincipalName ?? o.mail ?? o.operatingSystem ?? o.appId }
                : {}),
              ...link,
            });
          }
        }
        return out;
      }).then((r) => {
        sources.directory = r.status;
        return r.status === 'ok' ? r.value : [];
      }),
    );
  }

  if (types.has('resource') && q.length >= 2) {
    const kql = `Resources | where name contains ${kqlString(q)} | project id, name, type, resourceGroup, subscriptionId, location | order by name asc | take ${PER_SOURCE}`;
    tasks.push(
      timeboxed(deps.timeoutMs, async (signal) => {
        const res = await deps.outbound.execute<{
          value: Array<{ id?: string; name?: string; type?: string; resourceGroup?: string }>;
        }>(
          identity,
          {
            service: 'arm',
            method: 'POST',
            path: RESOURCE_GRAPH_PATH,
            apiVersion: RESOURCE_GRAPH_API_VERSION,
            body: { query: kql },
          },
          { correlationId: opts.correlationId, signal },
        );
        const needle = q.toLowerCase();
        const rows = (res.data.value ?? []).filter(
          (r) => r.id && r.name && (!deps.fixtures || r.name.toLowerCase().includes(needle)),
        );
        const out: SearchResult[] = [];
        for (const r of rows.slice(0, PER_SOURCE)) {
          out.push({
            type: 'resource',
            id: r.id!,
            title: r.name!,
            subtitle: [r.type, r.resourceGroup].filter(Boolean).join(' · '),
            ...(await entityHref('resource', r.id!)),
          });
        }
        return out;
      }).then((r) => {
        sources.azure = r.status;
        return r.status === 'ok' ? r.value : [];
      }),
    );
  }

  const results = (await Promise.all(tasks)).flat();
  return { query: q, results, sources };
}
