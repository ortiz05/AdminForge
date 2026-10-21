import { and, eq, lt, or, sql } from 'drizzle-orm';
import { writeTx, type Db } from '../db/client';
import { sessions } from '../db/schema';

/** A signed-in session as stored (the cookie's id is never stored, only its sha256). */
export interface SessionRecord {
  idHash: string;
  userOid: string;
  upn: string;
  displayName: string;
  tenantId: string;
  tenantName: string;
  tenantDomain: string;
  roles: string[];
  csrf: string;
  readAccountId: string | null;
  writeAccountId: string | null;
  writeExpiresAt: Date | null;
  writeExtended: boolean;
  writeReason: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  /** Absolute expiry. Idle expiry is lastSeenAt + SESSION_IDLE_MINUTES. */
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  /**
   * When the roles were last confirmed with Entra (sign-in, then the 5-minute re-check by the API or the run worker).
   * Null for sessions from before it was recorded.
   */
  rolesCheckedAt?: Date | null;
}

export type SessionPatch = Partial<Omit<SessionRecord, 'idHash' | 'createdAt'>>;

export interface SessionStore {
  create(session: SessionRecord): Promise<void>;
  get(idHash: string): Promise<SessionRecord | null>;
  update(idHash: string, patch: SessionPatch): Promise<SessionRecord | null>;
  delete(idHash: string): Promise<void>;
  /**
   * Housekeeping: drops token-cache partitions of unusable sessions (expired, idle, or disarmed by
   * time) right away, and the session rows themselves after `retainDays`. Returns rows removed. A schedule's grant
   * partition (`schedule:<id>`, ADR-014) belongs to the schedule, not a session: it stays while the schedule's grant
   * row exists and goes once it doesn't (the schedule was deleted, or its creator lost access).
   */
  purge(input: { now: Date; idleMinutes: number; retainDays?: number }): Promise<number>;
}

/** Whether the session is armed at `now` (write account held and window still open). */
export const isArmed = (s: Pick<SessionRecord, 'writeAccountId' | 'writeExpiresAt'>, now: Date) =>
  Boolean(s.writeAccountId && s.writeExpiresAt && s.writeExpiresAt.getTime() > now.getTime());

const DAY_MS = 86_400_000;

export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: Db) {}

  async create(session: SessionRecord): Promise<void> {
    await this.db.insert(sessions).values(session);
  }

  async get(idHash: string): Promise<SessionRecord | null> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.idHash, idHash)).limit(1);
    return row ?? null;
  }

  async update(idHash: string, patch: SessionPatch): Promise<SessionRecord | null> {
    const [row] = await this.db.update(sessions).set(patch).where(eq(sessions.idHash, idHash)).returning();
    return row ?? null;
  }

  async delete(idHash: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.idHash, idHash));
  }

  async purge({
    now,
    idleMinutes,
    retainDays = 7,
  }: {
    now: Date;
    idleMinutes: number;
    retainDays?: number;
  }): Promise<number> {
    const idleCutoff = new Date(now.getTime() - idleMinutes * 60_000);
    const unusable = or(lt(sessions.expiresAt, now), lt(sessions.lastSeenAt, idleCutoff));
    const t = now.getTime();
    const idle = idleCutoff.getTime();
    return writeTx(this.db, (tx) => {
      // Refresh tokens of sessions nobody can use any more go first.
      tx.run(sql`
        delete from token_cache where exists (
          select 1 from sessions s
           where (token_cache.partition_key = 'read:' || s.id_hash or token_cache.partition_key = 'write:' || s.id_hash)
             and (s.expires_at < ${t} or s.last_seen_at < ${idle}))`);
      tx.run(sql`
        delete from token_cache where exists (
          select 1 from sessions s
           where token_cache.partition_key = 'write:' || s.id_hash and s.write_expires_at < ${t})`);
      // Orphaned partitions (session row already gone). Schedules' grants are not sessions' (ADR-014).
      tx.run(sql`
        delete from token_cache
         where updated_at < ${t - DAY_MS}
           and partition_key not like 'schedule:%'
           and not exists (
             select 1 from sessions s where token_cache.partition_key in ('read:' || s.id_hash, 'write:' || s.id_hash))`);
      // A schedule's grant partition without its grant row: the schedule is gone, or the grant was withdrawn.
      tx.run(sql`
        delete from token_cache
         where partition_key like 'schedule:%'
           and not exists (
             select 1 from schedule_grants g where token_cache.partition_key = 'schedule:' || g.schedule_id)`);
      const retainCutoff = new Date(t - retainDays * DAY_MS);
      const removed = tx
        .delete(sessions)
        .where(
          and(
            unusable,
            or(
              lt(sessions.expiresAt, retainCutoff),
              lt(sessions.lastSeenAt, new Date(idleCutoff.getTime() - retainDays * DAY_MS)),
            ),
          ),
        )
        .returning({ idHash: sessions.idHash })
        .all();
      return removed.length;
    });
  }
}

/**
 * Emergency: everyone is signed out at once (`adminforge db sign-out-everyone`). Deletes every session, pending sign-in
 * and the sessions' sealed tokens; with `scheduleGrants`, also the tokens of schedules that run with their creator's
 * access (they then need the creator's consent again). The API reads sessions from the database on every request, so
 * this takes effect while it runs: the next request and every open event stream end with "signed out".
 */
export function signOutEveryone(
  db: Db,
  opts: { scheduleGrants?: boolean } = {},
): { sessions: number; signIns: number; tokens: number } {
  return writeTx(db, (tx) => {
    const tokens = tx.run(
      opts.scheduleGrants
        ? sql`delete from token_cache`
        : sql`delete from token_cache where partition_key not like 'schedule:%'`,
    ).changes;
    const signIns = tx.run(sql`delete from preauth`).changes;
    const removed = tx.run(sql`delete from sessions`).changes;
    return { sessions: removed, signIns, tokens };
  });
}

/** In-memory store for tests and DB-less mock mode. */
export class MemorySessionStore implements SessionStore {
  readonly rows = new Map<string, SessionRecord>();

  async create(session: SessionRecord): Promise<void> {
    if (this.rows.has(session.idHash)) throw new Error('duplicate session');
    this.rows.set(session.idHash, structuredClone(session));
  }

  async get(idHash: string): Promise<SessionRecord | null> {
    const row = this.rows.get(idHash);
    return row ? structuredClone(row) : null;
  }

  async update(idHash: string, patch: SessionPatch): Promise<SessionRecord | null> {
    const row = this.rows.get(idHash);
    if (!row) return null;
    const next = { ...row, ...structuredClone(patch) };
    this.rows.set(idHash, next);
    return structuredClone(next);
  }

  async delete(idHash: string): Promise<void> {
    this.rows.delete(idHash);
  }

  async purge({
    now,
    idleMinutes,
    retainDays = 7,
  }: {
    now: Date;
    idleMinutes: number;
    retainDays?: number;
  }): Promise<number> {
    let removed = 0;
    const retainMs = retainDays * DAY_MS;
    for (const [id, s] of this.rows) {
      const idleAt = s.lastSeenAt.getTime() + idleMinutes * 60_000;
      const deadAt = Math.min(s.expiresAt.getTime(), idleAt);
      if (deadAt + retainMs < now.getTime()) {
        this.rows.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
