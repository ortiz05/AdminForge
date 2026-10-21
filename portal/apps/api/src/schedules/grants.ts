import { eq } from 'drizzle-orm';
import { identityLabel, type Schedule } from '@adminforge/schemas';
import { portalRoles } from '../auth/roles';
import type { TokenCacheStore } from '../auth/token-cache';
import { hasAccountStatus, isGuestAccount, ReauthRequired, type AuthClient } from '../auth/types';
import type { UserScope } from '../datasources/executor';
import type { Db } from '../db/client';
import { scheduleGrants } from '../db/schema';
import { AppError } from '../errors';
import type { ExecutionIdentity } from '../execution/types';
import type { ScheduleRow } from './types';

/**
 * Who a schedule runs as (ADR-014), ready for its jobs: the automation identity, a named app identity, or — for a
 * read-only schedule made in the portal — its creator, through the delegated read access they granted that schedule.
 *
 * A grant is a row here (who, which MSAL account, whether it still works) plus the refresh token sealed in the token
 * cache under `schedule:<id>` (written by the consent round trip, auth/schedule-consent.ts). Before each run the
 * creator's roles are re-read from Entra (as at sign-in); a refused refresh — password reset, revoked sessions,
 * Conditional Access sign-in frequency, 90 days unused — puts the schedule in "needs sign-in", and only the creator
 * can renew it. A creator who lost the roles loses the grant (row and tokens).
 */

export type GrantStatus = 'active' | 'needs_sign_in';

export interface ScheduleGrantRow {
  scheduleId: string;
  userOid: string;
  upn: string;
  homeAccountId: string;
  status: GrantStatus;
  /** Why it needs sign-in (an error code), when it does. */
  reason: string | null;
  consentedAt: Date;
  checkedAt: Date | null;
}

export interface ScheduleGrantStore {
  get(scheduleId: string): Promise<ScheduleGrantRow | null>;
  /** Inserts or replaces the grant of a schedule (a new consent). */
  put(row: ScheduleGrantRow): Promise<void>;
  setStatus(scheduleId: string, status: GrantStatus, reason: string | null, at: Date): Promise<void>;
  delete(scheduleId: string): Promise<void>;
}

/** The token-cache partition of a schedule's grant (AAD of its sealed blob, so it opens for this schedule only). */
export const grantPartition = (scheduleId: string) => `schedule:${scheduleId}`;

export class SqliteScheduleGrantStore implements ScheduleGrantStore {
  constructor(private readonly db: Db) {}

  async get(scheduleId: string): Promise<ScheduleGrantRow | null> {
    const [row] = await this.db
      .select()
      .from(scheduleGrants)
      .where(eq(scheduleGrants.scheduleId, scheduleId))
      .limit(1);
    return row ? { ...row, status: row.status as GrantStatus } : null;
  }

  async put(row: ScheduleGrantRow): Promise<void> {
    await this.db
      .insert(scheduleGrants)
      .values(row)
      .onConflictDoUpdate({
        target: scheduleGrants.scheduleId,
        set: {
          userOid: row.userOid,
          upn: row.upn,
          homeAccountId: row.homeAccountId,
          status: row.status,
          reason: row.reason,
          consentedAt: row.consentedAt,
          checkedAt: row.checkedAt,
        },
      });
  }

  async setStatus(scheduleId: string, status: GrantStatus, reason: string | null, at: Date): Promise<void> {
    await this.db
      .update(scheduleGrants)
      .set({ status, reason, checkedAt: at })
      .where(eq(scheduleGrants.scheduleId, scheduleId));
  }

  async delete(scheduleId: string): Promise<void> {
    await this.db.delete(scheduleGrants).where(eq(scheduleGrants.scheduleId, scheduleId));
  }
}

export class MemoryScheduleGrantStore implements ScheduleGrantStore {
  readonly rows = new Map<string, ScheduleGrantRow>();
  async get(scheduleId: string) {
    const r = this.rows.get(scheduleId);
    return r ? structuredClone(r) : null;
  }
  async put(row: ScheduleGrantRow) {
    this.rows.set(row.scheduleId, structuredClone(row));
  }
  async setStatus(scheduleId: string, status: GrantStatus, reason: string | null, at: Date) {
    const r = this.rows.get(scheduleId);
    if (r) this.rows.set(scheduleId, { ...r, status, reason, checkedAt: at });
  }
  async delete(scheduleId: string) {
    this.rows.delete(scheduleId);
  }
}

export const AUTOMATION_READ = { kind: 'automation', mode: 'read' } as const satisfies ExecutionIdentity;
/** `user` in expression scope for scheduled reports run by an app-only identity. */
export const AUTOMATION_SCOPE_USER: UserScope = {
  oid: 'automation',
  upn: 'automation identity',
  name: 'Automation identity',
  roles: ['Portal.Reader'],
};

/** The schedule runs with its creator's access, which needs (another) sign-in: nothing runs until they do. */
export class NeedsSignIn extends AppError {
  constructor(
    owner: string,
    /** Already in "needs sign-in" before this run (no new notification). */
    readonly known: boolean,
    first = false,
  ) {
    super(
      409,
      'needs_sign_in',
      first
        ? `This schedule runs with ${owner}’s own access, and they haven’t signed in for it yet, so it didn’t run.`
        : `This schedule runs with ${owner}’s own access, and Microsoft needs them to sign in again, so it didn’t run.`,
      {
        hint: first
          ? 'The person who created the schedule opens it in AdminForge and chooses “Sign in”. Until then it doesn’t run; a portal administrator can turn it off or delete it.'
          : 'The person who created the schedule opens it in AdminForge and chooses “Sign in again”. Until then it doesn’t run; a portal administrator can turn it off or delete it.',
      },
    );
  }
}

export interface PreparedIdentity {
  identity: ExecutionIdentity;
  user: UserScope;
  /** "automation identity", "app identity reports-team", "avery@example.com (their own access)". */
  executedAs: string;
}

export interface ScheduleIdentitiesOptions {
  grants: ScheduleGrantStore;
  /** Entra sign-in (null in mock mode: user schedules can't run). */
  auth: AuthClient | null;
  tokenCache: Pick<TokenCacheStore, 'delete'>;
  now: () => Date;
}

/** The creator lost what the schedule needs: their grant is gone and the scheduler turns the schedule off. */
export class CreatorAccessLost extends AppError {
  constructor(
    message: string,
    readonly detail: 'roles' | 'account',
    readonly missing: readonly string[] = [],
  ) {
    super(403, 'creator_access_removed', message, {
      hint: 'Someone who may open the report can schedule it again; this one runs again only after the creator’s access is restored and they sign in for it.',
    });
  }
}

export class ScheduleIdentities {
  constructor(private readonly o: ScheduleIdentitiesOptions) {}

  get grants(): ScheduleGrantStore {
    return this.o.grants;
  }

  /**
   * The identity `s` runs as now. For a creator schedule this re-reads the creator's roles with Entra and checks they
   * still hold `requiredRoles`; throws NeedsSignIn when the grant can't be used, `creator_access_removed` (and drops the
   * grant) when the creator lost access.
   */
  async prepare(s: ScheduleRow, requiredRoles: readonly string[]): Promise<PreparedIdentity> {
    const def = s.definition;
    const identity = def.identity;
    if (!identity || identity === 'automation')
      return {
        identity: { ...AUTOMATION_READ, schedule: s.key },
        user: AUTOMATION_SCOPE_USER,
        executedAs: identityLabel(identity),
      };
    if ('app' in identity)
      return {
        identity: { kind: 'automation', mode: 'read', app: identity.app, schedule: s.key },
        user: {
          ...AUTOMATION_SCOPE_USER,
          upn: `app identity ${identity.app}`,
          name: `App identity ${identity.app}`,
        },
        executedAs: identityLabel(identity),
      };
    return this.prepareUser(s, def, requiredRoles);
  }

  private async prepareUser(
    s: ScheduleRow,
    def: Schedule,
    requiredRoles: readonly string[],
  ): Promise<PreparedIdentity> {
    const owner = def.owner;
    const grant = await this.o.grants.get(s.id);
    if (!grant) throw new NeedsSignIn(owner, false, true);
    // Only ever the creator's own access (the consent route checks it too).
    if (!s.createdBy || grant.userOid !== s.createdBy) {
      await this.remove(s.id);
      throw new NeedsSignIn(owner, false, true);
    }
    if (grant.status === 'needs_sign_in') throw new NeedsSignIn(owner, true);
    const auth = this.o.auth;
    if (!auth)
      throw new AppError(
        503,
        'live_data_unavailable',
        'Schedules that run as their creator need Entra sign-in.',
        {
          hint: 'Run it as the automation identity instead (mock mode has no tenant to sign in to).',
        },
      );
    const partitionKey = grantPartition(s.id);
    let claims;
    try {
      // A forced refresh with openid: Entra re-evaluates the account and its app roles, as at sign-in.
      claims = await auth.refreshClaims({ kind: 'read', partitionKey, homeAccountId: grant.homeAccountId });
    } catch (err) {
      if (err instanceof ReauthRequired) {
        await this.markNeedsSignIn(s.id, 'reauth');
        throw new NeedsSignIn(owner, false);
      }
      throw err;
    }
    // Without the account-status claim a guest can't be told from a member: don't run (fail closed), keep the grant.
    if (!hasAccountStatus(claims))
      throw new AppError(
        503,
        'creator_unverified',
        `AdminForge couldn’t confirm that ${owner}, who created this schedule, is still a member of the organisation, so it didn’t run.`,
        {
          hint: 'An administrator needs to run `pnpm adminforge provision entra` (it adds the acct claim to the Read app). It tries again at its next time.',
        },
      );
    const roles = portalRoles(claims);
    const missing = requiredRoles.filter((r) => !(roles as string[]).includes(r));
    if (claims.oid !== grant.userOid || isGuestAccount(claims) || missing.length) {
      await this.remove(s.id);
      throw new CreatorAccessLost(
        missing.length
          ? `${owner} created this schedule to run with their own access, but they no longer hold the ${missing.join(' and ')} role, so it didn’t run, was turned off and their sign-in for it was removed.`
          : `${owner} created this schedule to run with their own access, but their account can’t be used for it any more, so it didn’t run, was turned off and their sign-in for it was removed.`,
        missing.length ? 'roles' : 'account',
        missing,
      );
    }
    await this.o.grants.setStatus(s.id, 'active', null, this.o.now());
    return {
      identity: {
        kind: 'grant',
        mode: 'read',
        grant: {
          scheduleId: s.id,
          scheduleKey: s.key,
          oid: grant.userOid,
          upn: grant.upn,
          homeAccountId: grant.homeAccountId,
          partitionKey,
        },
      },
      user: { oid: grant.userOid, upn: grant.upn, name: claims.name ?? grant.upn, roles },
      executedAs: identityLabel(def.identity, grant.upn),
    };
  }

  /** "Needs sign-in": nothing runs until the creator signs in for the schedule again. */
  async markNeedsSignIn(scheduleId: string, reason: string): Promise<void> {
    await this.o.grants.setStatus(scheduleId, 'needs_sign_in', reason, this.o.now());
  }

  /** Drops a schedule's grant: the row and the sealed tokens. */
  async remove(scheduleId: string): Promise<void> {
    await this.o.grants.delete(scheduleId);
    await this.o.tokenCache.delete(grantPartition(scheduleId));
  }
}
