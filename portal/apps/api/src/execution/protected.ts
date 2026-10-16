import type { ServiceId } from '@adminforge/connectors';
import type { Config } from '../config';
import { AppError } from '../errors';
import type { ExecutionIdentity } from './types';

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

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MAX_DEPTH = 32;

/** Graph writes refused while the protected set can't be read: where AdminForge's own access lives. */
const SENSITIVE_GRAPH = [
  /^\/groups(\/[^/]+|\([^)]*\))(\/(members|owners)(\/|$)|\/?$)/i,
  /^\/(applications|servicePrincipals)(\/|\(|$)/i,
  /\/(appRoleAssignments|appRoleAssignedTo)(\/|\(|$)/i,
  /^\/users\/[^/]+\/authentication(\/|$)/i,
  /^\/directoryObjects\/[^/]+\/?$/i,
];

/** "a, b c" → lower-case GUIDs. */
export const idList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => GUID.test(s));

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Every GUID in a string (raw and percent-decoded), lower case. */
function idsIn(text: string, out: Set<string>) {
  for (const t of text.includes('%') ? [text, decode(text)] : [text])
    for (const m of t.matchAll(GUID_ANY)) out.add(m[0].toLowerCase());
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

/** Whether a write is one that must not go ahead without the protected set. */
export function isSensitiveWrite(t: WriteTarget): boolean {
  if (t.service !== 'graph') return false;
  const path = decode(t.path.split('?')[0]!).replace(/^\/(v1\.0|beta)(?=\/)/, '');
  return SENSITIVE_GRAPH.some((re) => re.test(path));
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
  who.kind === 'automation' ? 'automation' : `user:${who.session.userOid}`;

export class ProtectedObjects {
  /** Lower-case app ids: Read, Write, Automation, AF_PROTECTED_APP_IDS. */
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
    const own = [c.AF_READ_CLIENT_ID, c.AF_WRITE_CLIENT_ID, c.AF_AUTOMATION_CLIENT_ID].flatMap((id) =>
      idList(id),
    );
    this.appIds = [...new Set([...own, ...idList(c.AF_PROTECTED_APP_IDS)])];
    this.roleApps = new Set([...idList(c.AF_READ_CLIENT_ID), ...idList(c.AF_WRITE_CLIENT_ID)]);
    this.configured = new Set([...this.appIds, ...idList(c.AF_PROTECTED_USER_IDS)]);
    this.ttlMs = o.ttlMs ?? 10 * 60_000;
    this.retryMs = o.retryMs ?? 60_000;
  }

  /**
   * Throws `protected_object` when a write names a protected object, `protected_objects_unavailable` when the set
   * couldn't be read and the write is a sensitive one; returns when the write may go ahead.
   */
  async check(identity: ExecutionIdentity, targets: WriteTarget[], correlationId?: string): Promise<void> {
    if (!targets.length) return;
    const named = new Set<string>();
    for (const t of targets) for (const id of referencedIds(t)) named.add(id);
    // Named in configuration: refused without asking Graph.
    for (const id of named) if (this.configured.has(id)) throw protectedObjectRefused();
    const { ids, complete } = await this.current(identity, correlationId);
    for (const id of named) if (ids.has(id)) throw protectedObjectRefused();
    if (!complete && targets.some(isSensitiveWrite)) throw protectedObjectsUnavailable();
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
      return typeof id === 'string' && GUID.test(id) ? id.toLowerCase() : undefined;
    };
    // An app id with no registration or service principal in this tenant (404) is simply skipped.
    const objects = await Promise.all(
      this.appIds.map(async (appId) => {
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
        if (typeof a?.principalId === 'string' && GUID.test(a.principalId))
          ids.add(a.principalId.toLowerCase());
    return ids;
  }
}
