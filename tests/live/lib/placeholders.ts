import type { PortalSession } from './portal-session';

/**
 * Placeholders for live scripts: `@<kind>:<display name>[#<field>]` anywhere in a playbook's inputs (also inside
 * arrays and objects) is replaced by the object's id or address, looked up as the validation user through the portal
 * itself — its search, or a read-only page datasource — so no ids or addresses go on the command line or into output.
 *
 * | kind      | looks up                                           | default field | other fields                       |
 * | --------- | -------------------------------------------------- | ------------- | ---------------------------------- |
 * | `user`    | user (search)                                      | `id`          | `upn`, `mail` and any profile field |
 * | `mailbox` | the mailbox's user object (search, `identity.user`) | `mail`        | `id`, `userPrincipalName`, …       |
 * | `group`   | group (search)                                     | `id`          | `mail`                             |
 * | `dl`      | distribution list's group object (search)          | `mail`        | `id`                               |
 * | `team`    | the team's Microsoft 365 group (search)            | `id`          | `mail`                             |
 * | `site`    | SharePoint site (`m365.sharepoint-sites` search)    | `id`          | `webUrl`, `name`                   |
 * | `device`  | device (search)                                    | `id`          |                                    |
 * | `app`     | app registration (search)                          | `id`          |                                    |
 *
 * Example: `{"mailbox":"@mailbox:AF-Test-Shared-01","identity":"@dl:AF-Test-DL-01","teamId":"@team:AF-Test-Team-01",
 * "siteUrl":"@site:AF-Test-Team-01#webUrl"}`.
 */
export const PLACEHOLDER_KINDS = ['user', 'mailbox', 'group', 'dl', 'team', 'site', 'device', 'app'] as const;
export type PlaceholderKind = (typeof PLACEHOLDER_KINDS)[number];

export interface Placeholder {
  kind: PlaceholderKind;
  name: string;
  field: string;
}

const PATTERN = new RegExp(`^@(${PLACEHOLDER_KINDS.join('|')}):([^#]+?)(?:#([A-Za-z][A-Za-z0-9_]*))?$`);
const DEFAULT_FIELD: Record<PlaceholderKind, string> = {
  user: 'id',
  mailbox: 'mail',
  group: 'id',
  dl: 'mail',
  team: 'id',
  site: 'id',
  device: 'id',
  app: 'id',
};

/** `@kind:name[#field]` → its parts; anything else → undefined. */
export function parsePlaceholder(value: unknown): Placeholder | undefined {
  const m = typeof value === 'string' ? PATTERN.exec(value.trim()) : null;
  if (!m) return undefined;
  const kind = m[1] as PlaceholderKind;
  return { kind, name: m[2]!.trim(), field: m[3] ?? DEFAULT_FIELD[kind] };
}

/** Every placeholder in a JSON value, replaced by `lookup` (depth first; other values are kept as they are). */
export async function replacePlaceholders(
  value: unknown,
  lookup: (p: Placeholder, raw: string) => Promise<string>,
): Promise<{ value: unknown; count: number }> {
  let count = 0;
  const walk = async (v: unknown): Promise<unknown> => {
    const p = parsePlaceholder(v);
    if (p) {
      count++;
      return lookup(p, v as string);
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const item of v) out.push(await walk(item));
      return out;
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v)) out[k] = await walk(item);
      return out;
    }
    return v;
  };
  return { value: await walk(value), count };
}

type Api = Pick<PortalSession, 'api'>;
/** User fields the portal search returns (anything else comes from the User page's profile datasource). */
const BASIC_USER_FIELDS = new Set(['id', 'upn', 'userPrincipalName']);
type Row = Record<string, unknown>;
type SearchHit = { type: string; id?: string; title: string; subtitle?: string };

const sameName = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

async function searchOne(
  s: Api,
  type: 'user' | 'group' | 'device' | 'app',
  name: string,
): Promise<SearchHit> {
  const r = await s.api<{ results?: SearchHit[]; sources?: { directory?: string } }>(
    'GET',
    `/api/search?q=${encodeURIComponent(name)}&type=${type}`,
  );
  if (r.status !== 200) throw new Error(`portal search answered ${r.status}`);
  const directory = r.json.sources?.directory;
  if (directory && directory !== 'ok')
    throw new Error(`portal search could not read the directory (${directory})`);
  const hits = (r.json.results ?? []).filter((x) => x.type === type && x.id);
  const hit = hits.find((x) => x.title === name) ?? hits.find((x) => sameName(x.title, name));
  if (!hit) throw new Error(`no ${type} named exactly like that (directory search can lag a few minutes)`);
  return hit;
}

/** Runs one datasource of a published page as the validation user (read mode) and returns its data. */
async function datasource(s: Api, page: string, name: string, params: Row): Promise<unknown> {
  const def = await s.api<{ version?: string }>('GET', `/api/definitions/page/${encodeURIComponent(page)}`);
  if (def.status !== 200 || !def.json.version)
    throw new Error(`page ${page} is not available (${def.status})`);
  const r = await s.api<{ data?: unknown; error?: { code?: string } }>('POST', '/api/datasources/execute', {
    page,
    version: def.json.version,
    datasource: name,
    params,
  });
  if (r.status !== 200)
    throw new Error(`${page}#${name} answered ${r.status} ${r.json?.error?.code ?? ''}`.trim());
  return r.json.data;
}

const rowsOf = (data: unknown): Row[] => {
  const v = Array.isArray(data)
    ? data
    : ((data as { value?: unknown; rows?: unknown } | null)?.value ??
      (data as { rows?: unknown } | null)?.rows);
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Row[]) : [];
};

/** The fields of the object a placeholder names (only what the lookup needs; never printed). */
async function fieldsOf(s: Api, p: Placeholder): Promise<Row> {
  switch (p.kind) {
    case 'user':
    case 'mailbox': {
      const hit = await searchOne(s, 'user', p.name);
      const basic: Row = { id: hit.id, upn: hit.subtitle, userPrincipalName: hit.subtitle };
      if (BASIC_USER_FIELDS.has(p.field)) return basic;
      // Mail and other profile fields: the User page's own profile datasource.
      const profile = await datasource(s, 'identity.user', 'profile', { id: hit.id });
      return { ...basic, ...(profile as Row) };
    }
    case 'group':
    case 'dl':
    case 'team': {
      const hit = await searchOne(s, 'group', p.name);
      return { id: hit.id, mail: hit.subtitle };
    }
    case 'site': {
      const rows = rowsOf(await datasource(s, 'm365.sharepoint-sites', 'sites', { q: p.name }));
      const row =
        rows.find((r) => sameName(r.displayName, p.name)) ?? rows.find((r) => sameName(r.name, p.name));
      if (!row)
        throw new Error(
          'no site with that name in SharePoint search (a new site can take a while to be indexed)',
        );
      return row;
    }
    case 'device':
    case 'app': {
      const hit = await searchOne(s, p.kind, p.name);
      return { id: hit.id };
    }
  }
}

/**
 * Replaces every placeholder in `inputs` (see the table above). Lookups are cached per run. Errors name the
 * placeholder as typed (`@dl:AF-Test-DL-01`), never what it resolved to.
 */
export async function resolvePlaceholders<T>(s: Api, inputs: T): Promise<{ inputs: T; count: number }> {
  const cache = new Map<string, Promise<Row>>();
  const { value, count } = await replacePlaceholders(inputs, async (p, raw) => {
    // Users and mailboxes read their profile only for fields search doesn't return.
    const profile = (p.kind === 'user' || p.kind === 'mailbox') && !BASIC_USER_FIELDS.has(p.field);
    const key = `${p.kind}:${p.name.toLowerCase()}${profile ? ':profile' : ''}`;
    let fields = cache.get(key);
    if (!fields) {
      fields = fieldsOf(s, p);
      cache.set(key, fields);
    }
    let row: Row;
    try {
      row = await fields;
    } catch (err) {
      throw new Error(`could not resolve ${raw}: ${(err as Error).message}`, { cause: err });
    }
    const v = row[p.field];
    if (typeof v !== 'string' || !v)
      throw new Error(`could not resolve ${raw}: the object has no "${p.field}"`);
    return v;
  });
  return { inputs: value as T, count };
}
