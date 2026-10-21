import { ApiError } from '@adminforge/connectors';
import { isGuid } from '@adminforge/schemas';
import type { ExecutionIdentity, OutboundExecutor } from '../execution/types';

/**
 * Report schedules created in the portal keep running as the automation identity — with application permissions —
 * long after the person who made them typed the form. Before every run (cron, retry, run now) the scheduler asks this
 * check whether that person (by object id) is still an enabled member of the tenant (not a guest) who holds every
 * portal role the schedule needs: Portal.Operator and the report's current `requires.portalRoles`.
 *
 * Portal roles are app roles on the Read app: its service principal's `appRoles` map role values to ids, and its
 * `appRoleAssignedTo` lists who holds each (users directly, or groups — the SG-AdminForge-<label>-<Role> groups).
 * Group membership is checked transitively with `checkMemberObjects`. Answers are cached for 10 minutes (per person;
 * the role map once). Anything that can't be read is "unverified": that run doesn't happen, the schedule stays on.
 */

export type CreatorVerdict =
  | { status: 'ok' }
  | {
      status: 'removed';
      /** not_found = the account was deleted; missing_role = it no longer holds `missing`. */
      reason: 'not_found' | 'disabled' | 'guest' | 'missing_role';
      missing?: string[];
    }
  | { status: 'unverified'; problem: string };

export interface CreatorAccessChecker {
  check(oid: string, roles: readonly string[], correlationId?: string): Promise<CreatorVerdict>;
}

/** Graph as the automation identity, read mode. `get` answers null for 404. */
export interface AutomationGraph {
  get(
    path: string,
    query: Record<string, string>,
    opts: { all?: boolean; pathTemplate?: string; correlationId?: string },
  ): Promise<unknown>;
  post(
    path: string,
    body: unknown,
    opts: { pathTemplate?: string; correlationId?: string },
  ): Promise<unknown>;
}

const AUTOMATION_READ: ExecutionIdentity = { kind: 'automation', mode: 'read' };
/** checkMemberObjects takes at most 20 ids per request. */
const MEMBER_CHUNK = 20;

/** The executor as AutomationGraph (404 → null on GET). */
export function automationGraph(outbound: OutboundExecutor): AutomationGraph {
  return {
    async get(path, query, opts) {
      try {
        const res = await outbound.execute(
          AUTOMATION_READ,
          {
            service: 'graph',
            method: 'GET',
            path,
            query,
            paging: opts.all ? 'all' : 'none',
            maxItems: 20_000,
            ...(opts.pathTemplate ? { pathTemplate: opts.pathTemplate } : {}),
          },
          { correlationId: opts.correlationId },
        );
        return res.data;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    async post(path, body, opts) {
      const res = await outbound.execute(
        AUTOMATION_READ,
        {
          service: 'graph',
          method: 'POST',
          path,
          body,
          ...(opts.pathTemplate ? { pathTemplate: opts.pathTemplate } : {}),
        },
        { correlationId: opts.correlationId },
      );
      return res.data;
    },
  };
}

interface RoleHolders {
  users: Set<string>;
  groups: Set<string>;
}

type Facts = { exists: false } | { exists: true; enabled: boolean; guest: boolean; held: Set<string> };

const lower = (v: unknown) => (typeof v === 'string' && isGuid(v) ? v.toLowerCase() : null);

export class CreatorAccess implements CreatorAccessChecker {
  private roles: { at: number; byRole: Map<string, RoleHolders> } | null = null;
  private readonly people = new Map<string, { at: number; facts: Facts }>();
  private readonly ttlMs: number;

  constructor(
    private readonly o: {
      graph: AutomationGraph;
      /** AF_READ_CLIENT_ID: the app whose app roles are the portal roles. */
      readClientId: string | null | undefined;
      now: () => Date;
      ttlMs?: number;
    },
  ) {
    this.ttlMs = o.ttlMs ?? 10 * 60_000;
  }

  async check(oid: string, roles: readonly string[], correlationId?: string): Promise<CreatorVerdict> {
    const id = lower(oid);
    if (!id) return { status: 'unverified', problem: 'The schedule has no valid creator object id.' };
    let facts: Facts;
    try {
      facts = await this.facts(id, correlationId);
    } catch (err) {
      return { status: 'unverified', problem: (err as Error).message.slice(0, 300) };
    }
    if (!facts.exists) return { status: 'removed', reason: 'not_found' };
    if (!facts.enabled) return { status: 'removed', reason: 'disabled' };
    if (facts.guest) return { status: 'removed', reason: 'guest' };
    const missing = [...new Set(roles)].filter((r) => !facts.held.has(r));
    return missing.length ? { status: 'removed', reason: 'missing_role', missing } : { status: 'ok' };
  }

  /** Forget cached answers (tests, or after access changed). */
  invalidate(): void {
    this.roles = null;
    this.people.clear();
  }

  private fresh(at: number) {
    return this.o.now().getTime() - at < this.ttlMs;
  }

  private async facts(oid: string, correlationId?: string): Promise<Facts> {
    const hit = this.people.get(oid);
    if (hit && this.fresh(hit.at)) return hit.facts;
    const byRole = await this.roleHolders(correlationId);
    const user = (await this.o.graph.get(
      `/users/${oid}`,
      { $select: 'id,accountEnabled,userType' },
      { pathTemplate: '/users/{id}', correlationId },
    )) as { accountEnabled?: unknown; userType?: unknown } | null;
    let facts: Facts;
    if (!user) facts = { exists: false };
    else {
      const groups = [...new Set([...byRole.values()].flatMap((h) => [...h.groups]))];
      const memberOf = new Set<string>();
      for (let i = 0; i < groups.length; i += MEMBER_CHUNK) {
        const data = (await this.o.graph.post(
          `/users/${oid}/checkMemberObjects`,
          { ids: groups.slice(i, i + MEMBER_CHUNK) },
          { pathTemplate: '/users/{id}/checkMemberObjects', correlationId },
        )) as { value?: unknown[] } | null;
        for (const g of data?.value ?? []) {
          const gid = lower(g);
          if (gid) memberOf.add(gid);
        }
      }
      const held = new Set<string>();
      for (const [role, h] of byRole)
        if (h.users.has(oid) || [...h.groups].some((g) => memberOf.has(g))) held.add(role);
      facts = {
        exists: true,
        enabled: user.accountEnabled !== false,
        guest: typeof user.userType === 'string' && user.userType.toLowerCase() === 'guest',
        held,
      };
    }
    if (this.people.size > 5_000) this.people.clear();
    this.people.set(oid, { at: this.o.now().getTime(), facts });
    return facts;
  }

  /** Role value → the users and groups assigned it on the Read app. */
  private async roleHolders(correlationId?: string): Promise<Map<string, RoleHolders>> {
    if (this.roles && this.fresh(this.roles.at)) return this.roles.byRole;
    const appId = lower(this.o.readClientId);
    if (!appId) throw new Error('AF_READ_CLIENT_ID is not configured, so portal roles can’t be read.');
    const sp = (await this.o.graph.get(
      `/servicePrincipals(appId='${appId}')`,
      { $select: 'id,appRoles' },
      { pathTemplate: "/servicePrincipals(appId='{appId}')", correlationId },
    )) as { id?: unknown; appRoles?: Array<{ id?: unknown; value?: unknown }> } | null;
    const spId = lower(sp?.id);
    if (!sp || !spId) throw new Error('The Read app’s enterprise application wasn’t found.');
    const valueOf = new Map<string, string>();
    for (const r of sp.appRoles ?? []) {
      const rid = lower(r.id);
      if (rid && typeof r.value === 'string') valueOf.set(rid, r.value);
    }
    const assigned = (await this.o.graph.get(
      `/servicePrincipals/${spId}/appRoleAssignedTo`,
      { $select: 'principalId,principalType,appRoleId', $top: '999' },
      { all: true, pathTemplate: '/servicePrincipals/{id}/appRoleAssignedTo', correlationId },
    )) as { value?: Array<{ principalId?: unknown; principalType?: unknown; appRoleId?: unknown }> } | null;
    const byRole = new Map<string, RoleHolders>();
    for (const a of assigned?.value ?? []) {
      const role = valueOf.get(lower(a.appRoleId) ?? '');
      const principal = lower(a.principalId);
      if (!role || !principal) continue;
      const h = byRole.get(role) ?? { users: new Set<string>(), groups: new Set<string>() };
      if (a.principalType === 'Group') h.groups.add(principal);
      else if (a.principalType === 'User') h.users.add(principal);
      byRole.set(role, h);
    }
    this.roles = { at: this.o.now().getTime(), byRole };
    return byRole;
  }
}
