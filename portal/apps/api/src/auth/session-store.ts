import { and, eq, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { sessions, tokenCache } from '../db/schema';

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
}

export type SessionPatch = Partial<Omit<SessionRecord, 'idHash' | 'createdAt'>>;

export interface SessionStore {
  create(session: SessionRecord): Promise<void>;
  get(idHash: string): Promise<SessionRecord | null>;
  update(idHash: string, patch: SessionPatch): Promise<SessionRecord | null>;
  delete(idHash: string): Promise<void>;
  /**
   * Housekeeping: drops token-cache partitions of unusable sessions (expired, idle, or disarmed by
   * time) right away, and the session rows themselves after `retainDays`. Returns rows removed.
   */
  purge(input: { now: Date; idleMinutes: number; retainDays?: number }): Promise<number>;
}

/** Whether the session is armed at `now` (write account held and window still open). */
export const isArmed = (s: Pick<SessionRecord, 'writeAccountId' | 'writeExpiresAt'>, now: Date) =>
  Boolean(s.writeAccountId && s.writeExpiresAt && s.writeExpiresAt.getTime() > now.getTime());

const DAY_MS = 86_400_000;

export class PgSessionStore implements SessionStore {
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

  async purge({ now, idleMinutes, retainDays = 7 }: { now: Date; idleMinutes: number; retainDays?: number }): Promise<number> {
    const idleCutoff = new Date(now.getTime() - idleMinutes * 60_000);
    const unusable = or(lt(sessions.expiresAt, now), lt(sessions.lastSeenAt, idleCutoff));
    return this.db.transaction(async (tx) => {
      // Refresh tokens of sessions nobody can use any more go first.
      await tx.execute(sql`
        delete from ${tokenCache} t using ${sessions} s
        where (t.partition_key = 'read:' || s.id_hash or t.partition_key = 'write:' || s.id_hash)
          and (s.expires_at < ${now} or s.last_seen_at < ${idleCutoff})`);
      await tx.execute(sql`
        delete from ${tokenCache} t using ${sessions} s
        where t.partition_key = 'write:' || s.id_hash and s.write_expires_at < ${now}`);
      // Orphaned partitions (session row already gone).
      await tx.execute(sql`
        delete from ${tokenCache} t
        where t.updated_at < ${new Date(now.getTime() - DAY_MS)}
          and not exists (select 1 from ${sessions} s where t.partition_key in ('read:' || s.id_hash, 'write:' || s.id_hash))`);
      const retainCutoff = new Date(now.getTime() - retainDays * DAY_MS);
      const removed = await tx
        .delete(sessions)
        .where(and(unusable, or(lt(sessions.expiresAt, retainCutoff), lt(sessions.lastSeenAt, new Date(idleCutoff.getTime() - retainDays * DAY_MS)))))
        .returning({ idHash: sessions.idHash });
      return removed.length;
    });
  }
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

  async purge({ now, idleMinutes, retainDays = 7 }: { now: Date; idleMinutes: number; retainDays?: number }): Promise<number> {
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
