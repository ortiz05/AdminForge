import type { ServiceId } from '@adminforge/connectors';
import { decodeEscapes, GUID_PATTERN, isGuid } from '@adminforge/schemas';
import { ReauthRequired } from '../auth/types';
import type { Config } from '../config';
import { AppError } from '../errors';
import { identityCacheKey, type ExecutionIdentity } from './types';

/**
 * Protected objects (finding IAM-01): the central guard for declared writes, so no playbook — whatever it checks
 * itself — can change what keeps AdminForge's own access in place. A write is refused when its path, query or JSON
 * body names (case-insensitive, anywhere: `/groups/{id}/…`, `(appId='{id}')`, `"@odata.id": "…/directoryObjects/{id}"`,
 * `principalId`, …):
 *  - AdminForge's own apps (AF_READ_CLIENT_ID, AF_WRITE_CLIENT_ID, AF_AUTOMATION_CLIENT_ID) and AF_PROTECTED_APP_IDS:
 *    the app ids, their application objects and their service principals;
 *  - every principal holding an AdminForge app role (appRoleAssignedTo of the Read and Write apps' service principals:
 *    the SG-AdminForge-<label>-<Role> groups and anyone assigned directly) — by id, never by name;
 *  - AF_PROTECTED_USER_IDS (break-glass / emergency-access accounts).
 * Because the match is by id, a Graph write that names a user by sign-in name or address (`/users/{upn}`, an
 * `@odata.id` naming one) is refused outright (S-15): content resolves the user's object id first (`$guid()`, which
 * `adminforge validate` requires on `/users/` write paths). The refusal, not a UPN lookup, keeps the guard free of
 * another Graph dependency.
 * A delegated permission grant (`/oauth2PermissionGrants/{id}`) has an id that is not a GUID and names nobody, so a
 * write to one is checked by reading the grant (its `clientId`, the service principal holding it): a grant held by one
 * of the apps above is refused, and a grant that can't be read is refused too (fail closed).
 *
 * The directory part is read through the executor itself (automation identity first; otherwise the caller's own Read
 * sign-in) and cached for 10 minutes. When it can't be read, the ids from configuration (and the last answer) are
 * still enforced, and writes to group membership/ownership, groups, apps, service principals, app-role assignments,
 * directory objects and authentication methods are refused (fail closed); other writes go ahead.
 * Refusals never name the protected ids.
 */

export type ProtectedConfig = Partial<
  Pick<
    Config,
    | 'AF_READ_CLIENT_ID'
    | 'AF_WRITE_CLIENT_ID'
    | 'AF_AUTOMATION_CLIENT_ID'
    | 'AF_PROTECTED_APP_IDS'
    | 'AF_PROTECTED_USER_IDS'
    | 'SCHEDULE_IDENTITIES'
  >
>;

/** A Graph GET as `who` (all pages with `all`); null when Graph answers 404. */
export type GraphRead = (
  who: ExecutionIdentity,
  path: string,
  query: Record<string, string>,
  opts: { all?: boolean; correlationId?: string },
) => Promise<unknown>;

export interface ProtectedOptions {
  config: ProtectedConfig;
  read: GraphRead;
  /** The automation identity can read the directory (configured, or DATA_MODE=fixtures). */
  automation: boolean;
  now: () => Date;
  /** How long a directory answer is used (default 10 min). */
  ttlMs?: number;
  /** How long an identity that failed to read it is not asked again (default 1 min). */
  retryMs?: number;
}

/** One request a declared write sends (each changing `$batch` sub-request is one). */
export interface WriteTarget {
  service: ServiceId;
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

const GUID_ANY = new RegExp(GUID_PATTERN, 'g');
const MAX_DEPTH = 32;

/** Graph writes refused while the protected set can't be read: where AdminForge's own access lives. */
const SENSITIVE_GRAPH = [
  /^\/groups(\/[^/]+|\([^)]*\))(\/(members|owners)(\/|$)|\/?$)/i,
  /^\/(applications|servicePrincipals)(\/|\(|$)/i,
  /\/(appRoleAssignments|appRoleAssignedTo)(\/|\(|$)/i,
  /^\/users\/[^/]+\/authentication(\/|$)/i,
  /^\/directoryObjects(\/|\(|$)/i,
];

/** "a, b c" → lower-case GUIDs. */
export const idList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => isGuid(s));

/** Percent-decoded, each run of valid escapes on its own (one stray `%` doesn't leave the rest encoded). */
const decode = (s: string) => decodeEscapes(s);

/** Every GUID in a string (raw and percent-decoded), lower case. */
/** 32 hex digits on their own: Graph accepts a GUID without hyphens (`/groups/{32 hex}`, verified 2026-10-22). */
const GUID_BARE = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;
const hyphenate = (h: string) =>
  `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toLowerCase();

function idsIn(text: string, out: Set<string>) {
  for (const t of text.includes('%') ? [text, decode(text)] : [text]) {
    for (const m of t.matchAll(GUID_ANY)) out.add(m[0].toLowerCase());
    for (const m of t.matchAll(GUID_BARE)) out.add(hyphenate(m[0]));
  }
}

/** Every GUID in a JSON value's strings and keys. */
function idsInValue(value: unknown, out: Set<string>, depth = 0) {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  if (typeof value === 'string') idsIn(value, out);
  else if (Array.isArray(value)) for (const v of value) idsInValue(v, out, depth + 1);
  else if (typeof value === 'object')
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      idsIn(k, out);
      idsInValue(v, out, depth + 1);
    }
}

/** The ids a write names (path, query values, body). */
export function referencedIds(t: WriteTarget): Set<string> {
  const out = new Set<string>();
  idsIn(t.path, out);
  idsInValue(t.query, out);
  idsInValue(t.body, out);
  return out;
}

/**
 * `/users/{key}` (group 1: everything up to the next `/`, so `/users/('…')` is a key too) or `users(…)` (group 2:
 * `'{key}'`, `{key}`, `id='{key}'`, any other alternate key). Matched after runs of `/` are collapsed, so
 * `/users//{upn}` can't hide the key behind an empty segment.
 */
const USER_REF = /(?:^|\/)users(?:\/([^/?#]*)|\(([^)]*)\)?)/giu; // `u`: folds like .NET (`userſ`)
/**
 * Keys whose values reference directory objects (`members/$ref` bodies, `owners@odata.bind`, the `$id` query of a
 * `$ref` delete), in any case and in the OData 4.01 spellings (`@id`, `@bind`) as well as without the `@`.
 */
const isReferenceKey = (k: string) => /^[@$]?(odata\.)?id$/i.test(k) || /(^|@|\.)(odata\.)?bind$/i.test(k);
/** A string that is a Graph resource reference wherever it sits: the Graph host, or a versioned path. */
const GRAPH_REFERENCE = /^\s*(https:\/\/graph\.microsoft\.com\/|\/*(v1\.0|beta)\/)/i;

/** Whether one reference names a user by anything but an object id (the collection itself names nobody). */
function userKeyNotGuid(ref: string): boolean {
  // The path only (scheme and host dropped), runs of `/` collapsed: Graph's front end may treat them as one.
  const text = decode(ref)
    .replace(/^\s*[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .replace(/\/{2,}/g, '/');
  for (const m of text.matchAll(USER_REF)) {
    const key = (
      m[1] ??
      m[2]!
        .trim()
        .replace(/^id\s*=\s*/i, '')
        .replace(/^'(.*)'$/, '$1')
    ).trim();
    if (key !== '' && !isGuid(key)) return true;
  }
  return false;
}

/**
 * Every reference in a JSON value: the values under reference keys (`@odata.id`, `…@odata.bind`, any case or
 * spelling), and any other string that is a Graph URL or versioned path. Other text (descriptions, display names)
 * names nobody, even when it contains `/users/`.
 */
function references(value: unknown, out: string[], underKey = false, depth = 0) {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (underKey || GRAPH_REFERENCE.test(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) references(v, out, underKey, depth + 1);
    return;
  }
  if (typeof value === 'object')
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      references(v, out, isReferenceKey(k), depth + 1);
}

/**
 * Whether a Graph write names a user by anything but an object id (S-15): the segment after `/users/` (or the key in
 * `users('…')`) in its path, or in a reference in its query (`$id=…`) or body (`@odata.id`, `…@odata.bind`, a Graph
 * URL). Graph accepts a sign-in name there, but the protected-object guard matches ids only, so such a write could
 * reach a protected account unnoticed. `chatMembers`: the body names Teams chat members (the notify step's one-on-one
 * chat, set only by code) — a conversation, not a change to anyone's account — so only the path is checked.
 */
export function namesUserByName(t: WriteTarget, opts: { chatMembers?: boolean } = {}): boolean {
  if (t.service !== 'graph') return false;
  const path = t.path.split('?')[0]!.replace(/^\/(v1\.0|beta)(?=\/)/, '');
  if (userKeyNotGuid(path)) return true;
  const refs: string[] = [];
  references(t.query, refs);
  if (!opts.chatMembers) references(t.body, refs);
  return refs.some(userKeyNotGuid);
}

/** The collections whose objects the guard protects, and their cast types, as .NET folds them (`groupſ` → GROUPS). */
const OBJECT_COLLECTIONS = new Set(['GROUPS', 'APPLICATIONS', 'SERVICEPRINCIPALS', 'DIRECTORYOBJECTS']);
const OBJECT_TYPES = new Set(['GROUP', 'APPLICATION', 'SERVICEPRINCIPAL', 'DIRECTORYOBJECT']);
/** What may follow a collection instead of a key: a reference, a count, and collection-wide actions. */
const COLLECTION_ACTIONS = new Set([
  '$REF',
  '$COUNT',
  'DELTA',
  'GETBYIDS',
  'VALIDATEPROPERTIES',
  'GETAVAILABLEEXTENSIONPROPERTIES',
]);

/** A path's segments: host and version dropped, empty segments dropped, each segment decoded on its own. */
function pathSegments(ref: string): string[] {
  const path = ref
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .split(/[?#]/)[0]!;
  const segments = path
    .split('/')
    .filter((x) => x !== '')
    .map((x) => decodeEscapes(x).trim());
  if (/^(v1\.0|beta)$/i.test(segments[0] ?? '')) segments.shift();
  return segments;
}

/** A key that names an object by id: `{id}`, `'{id}'`, `id='{id}'`, `appId='{id}'`. */
const isIdKey = (key: string) =>
  isGuid(
    key
      .trim()
      .replace(/^(id|appId)\s*=\s*/i, '')
      .replace(/^'(.*)'$/s, '$1')
      .trim(),
  );

/**
 * Whether a reference names a group, app, service principal or directory object by anything but its id (or an app's
 * appId): an alternate key in parentheses (`groups(uniqueName='…')`, after a cast too:
 * `directoryObjects/microsoft.graph.group(uniqueName='…')`), a key in its own segment (`groups/('…')`,
 * `groups/uniqueName='…'`), or a segment after the collection that isn't a hyphenated GUID, a cast or a collection
 * action. Names are folded as .NET does, so `groupſ(…)` is `groups(…)`.
 */
function objectKeyNotGuid(ref: string): boolean {
  const segments = pathSegments(ref);
  let itemPath = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    // A drive item addressed by path (`root:/IT/Applications/f.json:`): folder names, not collections.
    const opens = /^root:$/i.test(seg) || (/:$/.test(seg) && segments[i - 1]?.toLowerCase() === 'items');
    if (itemPath || opens) {
      if (opens || /:$/.test(seg)) itemPath = opens && !itemPath ? true : !itemPath;
      continue;
    }
    const call = /^([^(]*)\((.*)\)$/s.exec(seg);
    const raw = (call ? call[1]! : seg).trim().toUpperCase();
    const base = raw.startsWith('MICROSOFT.GRAPH.') ? raw.slice('MICROSOFT.GRAPH.'.length) : raw;
    const collection = OBJECT_COLLECTIONS.has(base);
    if (!collection && !OBJECT_TYPES.has(base)) {
      // `groups (…)`, `groups(…);`: a protected collection's name followed by anything but a strict key.
      const lead = /^([A-Za-zſı]+)/u.exec(seg.trim())?.[1]?.toUpperCase();
      if (lead && OBJECT_COLLECTIONS.has(lead) && seg.trim().toUpperCase() !== lead) return true;
      continue;
    }
    if (call) {
      if (!isIdKey(call[2]!)) return true;
      continue;
    }
    if (!collection) continue; // a cast segment (`…/microsoft.graph.group/members`)
    const next = segments[i + 1];
    if (next === undefined) continue; // the collection itself
    const key = /^\((.*)\)$/s.exec(next);
    if (key) {
      if (!isIdKey(key[1]!)) return true;
      continue;
    }
    if (isGuid(next) || /^microsoft\.graph\./i.test(next) || COLLECTION_ACTIONS.has(next.toUpperCase()))
      continue;
    return true;
  }
  return false;
}

/**
 * Whether a Graph write addresses a group, app, service principal or directory object by an alternate key instead of
 * its id (or an app's appId), in its path or in a reference in its query or body: the guard matches ids only.
 */
export function namesObjectByKey(t: WriteTarget): boolean {
  if (t.service !== 'graph') return false;
  if (objectKeyNotGuid(t.path)) return true;
  const refs: string[] = [];
  references(t.query, refs);
  references(t.body, refs);
  return refs.some(objectKeyNotGuid);
}

export const objectNotById = () =>
  new AppError(
    403,
    'object_not_by_id',
    'This change names a group or app by another key (such as its unique name) instead of object ID, so AdminForge didn’t make it.',
    {
      hint: 'For the content author: look the object up first and pass its object ID through $guid(). AdminForge checks every change against the objects it protects by object ID.',
    },
  );

/** S-15: a declared Graph write naming a user by sign-in name or address instead of object id. */
export const userNotById = () =>
  new AppError(
    403,
    'user_not_by_id',
    'This change names a user by sign-in name or email address instead of object ID, so AdminForge didn’t make it.',
    {
      hint: 'For the content author: look the user up first and pass their object ID through $guid(). AdminForge checks every change against the accounts it protects by object ID.',
    },
  );

const GRANTS = 'OAUTH2PERMISSIONGRANTS';
/** What a delegated permission grant's id looks like (base64url). */
const GRANT_ID = /^[A-Za-z0-9_-]{1,256}$/;
/** A segment naming the grant collection, matched as .NET would (`toUpperCase` folds dotless ı and long ſ too). */
const isGrants = (name: string) => name.trim().toUpperCase() === GRANTS;

/**
 * Where a Graph path names delegated permission grants: the key after each `oauth2PermissionGrants` segment (`/{id}`,
 * `('{id}')`, `(id='{id}')`), at the top level or under another object (`/users/{id}/oauth2PermissionGrants/{id}`),
 * each segment percent-decoded on its own and runs of `/` collapsed. `mentioned` is true even without a key.
 */
function grantRefs(t: Pick<WriteTarget, 'service' | 'path'>): { mentioned: boolean; ids: string[] } {
  if (t.service !== 'graph') return { mentioned: false, ids: [] };
  const segments = t.path
    .split('?')[0]!
    .split('/')
    .filter((x) => x !== '')
    .map(decode);
  let mentioned = false;
  const ids = new Set<string>();
  segments.forEach((seg, i) => {
    const call = /^([^(]*)\((.*)\)$/s.exec(seg);
    if (call && isGrants(call[1]!)) {
      mentioned = true;
      const key = call[2]!
        .trim()
        .replace(/^id\s*=\s*/i, '')
        .replace(/^'(.*)'$/s, '$1');
      if (key) ids.add(key);
    } else if (isGrants(seg)) {
      mentioned = true;
      const key = segments[i + 1];
      if (key) ids.add(key);
    }
  });
  return { mentioned, ids: [...ids] };
}

/**
 * The delegated permission grants a Graph write deletes or changes (their ids: base64url, not GUIDs, so
 * `referencedIds` can't tell whose grant it is). Creating one (`POST /oauth2PermissionGrants`) names its `clientId` in
 * the body, which `referencedIds` checks.
 */
export const permissionGrantIds = (t: Pick<WriteTarget, 'service' | 'path'>): string[] => grantRefs(t).ids;

/** Whether a write is one that must not go ahead without the protected set. */
export function isSensitiveWrite(t: WriteTarget): boolean {
  if (t.service !== 'graph') return false;
  // Segment by segment, decoded, folded as .NET does (`groupſ`), casts dropped (`/groups/{id}/microsoft.graph.group/
  // members`), runs of `/` read as one: none of them may take a write out of the rule if Graph reads it as the plain path.
  const path =
    '/' +
    pathSegments(t.path)
      .filter((x) => !/^microsoft\.graph\./i.test(x))
      .map((x) => x.toUpperCase().toLowerCase())
      .join('/');
  return SENSITIVE_GRAPH.some((re) => re.test(path)) || grantRefs(t).mentioned;
}

export const protectedObjectRefused = () =>
  new AppError(
    403,
    'protected_object',
    'AdminForge doesn’t change its own apps, the groups that grant portal roles, or accounts marked as protected.',
    {
      hint: 'Make this change in the Microsoft Entra admin center, outside AdminForge, under your organization’s change process.',
    },
  );

export const protectedObjectsUnavailable = () =>
  new AppError(
    503,
    'protected_objects_unavailable',
    'AdminForge couldn’t confirm which objects it must never change, so it didn’t make this change.',
    {
      hint: 'Try again in a few minutes. If it keeps happening, a portal administrator should check that the automation identity (or your account) can read app registrations and enterprise apps (Application.Read.All).',
    },
  );

const readerKey = (who: ExecutionIdentity) =>
  who.kind === 'delegated' ? `user:${who.session.userOid}` : identityCacheKey(who);

/** Display-name prefix of the named app identities' registrations (provision/entra-desired.ts `appNames`). */
const IDENTITY_APP_PREFIX = 'AdminForge Identity ';

export class ProtectedObjects {
  /** Lower-case app ids: Read, Write, Automation, the named app identities, AF_PROTECTED_APP_IDS. */
  private readonly appIds: string[];
  /** App ids whose service principals carry the portal roles (Read, Write). */
  private readonly roleApps: Set<string>;
  /** What configuration names (app ids, AF_PROTECTED_USER_IDS): enforced even when Graph can't be read. */
  private readonly configured: Set<string>;
  private cache: { ids: Set<string>; at: number } | null = null;
  private readonly failedUntil = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<Set<string>>>();
  private readonly ttlMs: number;
  private readonly retryMs: number;

  constructor(private readonly o: ProtectedOptions) {
    const c = o.config;
    // AdminForge's own apps, including every named app identity a schedule may run as (ADR-014).
    const own = [
      c.AF_READ_CLIENT_ID,
      c.AF_WRITE_CLIENT_ID,
      c.AF_AUTOMATION_CLIENT_ID,
      ...(c.SCHEDULE_IDENTITIES ?? []).map((i) => i.clientId),
    ].flatMap((id) => idList(id));
    this.appIds = [...new Set([...own, ...idList(c.AF_PROTECTED_APP_IDS)])];
    this.roleApps = new Set([...idList(c.AF_READ_CLIENT_ID), ...idList(c.AF_WRITE_CLIENT_ID)]);
    this.configured = new Set([...this.appIds, ...idList(c.AF_PROTECTED_USER_IDS)]);
    this.ttlMs = o.ttlMs ?? 10 * 60_000;
    this.retryMs = o.retryMs ?? 60_000;
  }

  /**
   * Throws `user_not_by_id` when a Graph write names a user by anything but an object id (S-15; not for AdminForge's
   * own notification mail, whose sender is configured as an address, nor for the members of the notify step's Teams
   * chat: `chatMembers`), `object_not_by_id` when it names a group or app by another key, `protected_object` when a write names a
   * protected object, `protected_objects_unavailable` when the set couldn't be read and the write is a sensitive one;
   * returns when the write may go ahead.
   */
  async check(
    identity: ExecutionIdentity,
    targets: WriteTarget[],
    correlationId?: string,
    opts: { notification?: boolean; chatMembers?: boolean } = {},
  ): Promise<void> {
    if (!targets.length) return;
    if (!opts.notification && targets.some((t) => namesUserByName(t, { chatMembers: opts.chatMembers })))
      throw userNotById();
    if (targets.some(namesObjectByKey)) throw objectNotById();
    const named = new Set<string>();
    for (const t of targets) for (const id of referencedIds(t)) named.add(id);
    // Named in configuration: refused without asking Graph.
    for (const id of named) if (this.configured.has(id)) throw protectedObjectRefused();
    const { ids, complete } = await this.current(identity, correlationId);
    for (const id of named) if (ids.has(id)) throw protectedObjectRefused();
    if (!complete && targets.some(isSensitiveWrite)) throw protectedObjectsUnavailable();
    // Delegated permission grants: whose grant it is, read from Graph (the protected set is complete here: grant
    // writes are sensitive ones).
    const grants = new Set(targets.flatMap(permissionGrantIds));
    if (grants.size && !complete) throw protectedObjectsUnavailable();
    // Grant ids are base64url: anything else after the segment (a cast, `$count`, a stray key) isn't a grant this
    // guard can look up, so it isn't sent.
    if ([...grants].some((g) => !GRANT_ID.test(g))) throw protectedObjectsUnavailable();
    for (const grantId of grants) {
      const clientId = await this.grantClient(identity, grantId, correlationId);
      if (clientId !== null && ids.has(clientId)) throw protectedObjectRefused();
    }
  }

  /**
   * The service principal holding a delegated permission grant (lower-case object id), read through the executor
   * like the rest of the protected set: the automation identity first, then the caller's own Read sign-in. Null when
   * Graph doesn't know the grant (404: the write will get the same answer). Throws `protected_objects_unavailable`
   * when no reader can read it, or the answer isn't that grant with a client (fail closed: a cast or other segment
   * read in place of a key answers something else). A caller who must sign in again is told so. Not cached: grants
   * come and go.
   */
  private async grantClient(
    identity: ExecutionIdentity,
    grantId: string,
    correlationId?: string,
  ): Promise<string | null> {
    for (const who of this.readers(identity)) {
      let data: unknown;
      try {
        data = await this.o.read(
          who,
          `/oauth2PermissionGrants/${encodeURIComponent(grantId)}`,
          { $select: 'id,clientId' },
          { correlationId },
        );
      } catch (err) {
        if (who.kind === 'delegated' && err instanceof ReauthRequired) throw err;
        continue; // the next reader may have the permission this one lacks
      }
      if (data === null) return null;
      const grant = data as { id?: unknown; clientId?: unknown };
      if (grant.id === grantId && typeof grant.clientId === 'string' && isGuid(grant.clientId))
        return grant.clientId.toLowerCase();
      break;
    }
    throw protectedObjectsUnavailable();
  }

  /** The protected set; `complete` = read from Graph within the TTL. */
  async current(
    identity: ExecutionIdentity,
    correlationId?: string,
  ): Promise<{ ids: Set<string>; complete: boolean }> {
    const now = this.o.now().getTime();
    if (this.cache && now - this.cache.at < this.ttlMs) return { ids: this.cache.ids, complete: true };
    for (const who of this.readers(identity)) {
      const key = readerKey(who);
      if ((this.failedUntil.get(key) ?? 0) > now) continue;
      let pending = this.inflight.get(key);
      if (!pending) {
        pending = this.resolve(who, correlationId).finally(() => this.inflight.delete(key));
        this.inflight.set(key, pending);
      }
      try {
        const ids = await pending;
        this.cache = { ids, at: this.o.now().getTime() };
        this.failedUntil.delete(key);
        return { ids, complete: true };
      } catch {
        this.noteFailure(key);
      }
    }
    // Unresolved: configuration plus the last directory answer, if any.
    return { ids: this.cache?.ids ?? this.configured, complete: false };
  }

  /** Forget the cached answer (tests, or after provisioning changed the role groups). */
  invalidate(): void {
    this.cache = null;
    this.failedUntil.clear();
  }

  /** Who reads the directory: the automation identity, then the caller's own Read sign-in. */
  private readers(identity: ExecutionIdentity): ExecutionIdentity[] {
    const out: ExecutionIdentity[] = [];
    if (this.o.automation) out.push({ kind: 'automation', mode: 'read' });
    if (identity.kind === 'delegated')
      out.push({ kind: 'delegated', session: identity.session, mode: 'read' });
    return out;
  }

  private noteFailure(key: string) {
    const now = this.o.now().getTime();
    if (this.failedUntil.size > 1000)
      for (const [k, until] of this.failedUntil) if (until <= now) this.failedUntil.delete(k);
    this.failedUntil.set(key, now + this.retryMs);
  }

  private async resolve(who: ExecutionIdentity, correlationId?: string): Promise<Set<string>> {
    const ids = new Set(this.configured);
    const read = (path: string, query: Record<string, string>, all = false) =>
      this.o.read(who, path, query, { all, correlationId });
    const idOf = (data: unknown) => {
      const id = (data as { id?: unknown } | null)?.id;
      return typeof id === 'string' && isGuid(id) ? id.toLowerCase() : undefined;
    };
    // Named app identities no longer configured (removed from AF_SCHEDULE_IDENTITIES, ADR-014) keep their
    // registrations and application permissions until someone deletes them: still AdminForge's, still protected.
    // (Only where AdminForge's own apps are configured: without them there is nothing of AdminForge's to look for.)
    const retired = this.appIds.length
      ? await read(
          '/applications',
          { $filter: `startswith(displayName,'${IDENTITY_APP_PREFIX}')`, $select: 'id,appId', $top: '999' },
          true,
        )
      : null;
    const known = new Set(this.appIds);
    const retiredIds = ((retired as { value?: Array<{ appId?: unknown }> } | null)?.value ?? [])
      .map((a) => (typeof a?.appId === 'string' && isGuid(a.appId) ? a.appId.toLowerCase() : null))
      .filter((a): a is string => !!a && !known.has(a));
    for (const appId of retiredIds) ids.add(appId);
    // An app id with no registration or service principal in this tenant (404) is simply skipped.
    const objects = await Promise.all(
      [...this.appIds, ...retiredIds].map(async (appId) => {
        const [app, sp] = await Promise.all([
          read(`/applications(appId='${appId}')`, { $select: 'id,appId' }),
          read(`/servicePrincipals(appId='${appId}')`, { $select: 'id,appId' }),
        ]);
        return { appId, app: idOf(app), sp: idOf(sp) };
      }),
    );
    const roleSps: string[] = [];
    for (const o of objects) {
      if (o.app) ids.add(o.app);
      if (o.sp) {
        ids.add(o.sp);
        if (this.roleApps.has(o.appId)) roleSps.push(o.sp);
      }
    }
    const holders = await Promise.all(
      roleSps.map((sp) =>
        read(`/servicePrincipals/${sp}/appRoleAssignedTo`, { $select: 'principalId', $top: '999' }, true),
      ),
    );
    for (const data of holders)
      for (const a of (data as { value?: Array<{ principalId?: unknown }> } | null)?.value ?? [])
        if (typeof a?.principalId === 'string' && isGuid(a.principalId)) ids.add(a.principalId.toLowerCase());
    return ids;
  }
}
