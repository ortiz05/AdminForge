import { and, eq, lt, or, sql } from 'drizzle-orm';
import { writeTx, type Db, type Tx } from '../db/client';
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

/**
 * One id rotation as the movers see it: the old and the new id hash, and whether the session gains write access with
 * it (arming a read-only session — an id that existed while it was read-only must not carry the new write access, not
 * even through runs bound to it: they read on, and ask before their next write).
 */
export interface SessionMove {
  from: string;
  to: string;
  gainsWrite: boolean;
}

/**
 * Something else kept under a session's id hash that moves with the session when its id is rotated (S-08: arming).
 * `moveSessionTx` runs inside the rotation's immediate transaction — on SQLite `tx` is that transaction (synchronous:
 * never `await` in it; `withTx`), for the memory stores null — so the move commits with the new session row or not at
 * all. `sessionMoved` runs once the rotation committed, for what is kept in memory (held show-once secrets, open
 * streams, back-offs).
 */
export interface SessionMover {
  moveSessionTx?(move: SessionMove, tx: Tx | null): void;
  sessionMoved?(move: SessionMove): void;
}

/** A session id rotation (SessionStore.rotate). */
export interface SessionRotation {
  /** The current id hash. */
  from: string;
  /** The new id's hash. */
  to: string;
  /** Applied to the row as it moves (arming: the write window and a new CSRF token). */
  patch: SessionPatch;
  now: Date;
  /** Where a mover that failed after the commit is reported (the rotation stands). */
  log?: { warn(obj: object, msg: string): void };
}

/** How long an old id is remembered after a rotation: a request still carrying it is refused, its cookie kept. */
export const ROTATED_GRACE_MS = 60_000;

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
  /**
   * S-08: moves the session to a new id hash — the row (with `patch` applied) and everything the registered movers keep
   * under the old hash, in one immediate transaction — so the old id stops working at once. Null, with nothing moved,
   * when the session is gone (signed out meanwhile).
   */
  rotate(rotation: SessionRotation): Promise<SessionRecord | null>;
  /** Registers what moves with a session when its id is rotated; returns the function that unregisters it. */
  onRotate(mover: SessionMover): () => void;
  /**
   * Whether `idHash` was rotated away within ROTATED_GRACE_MS. A request still carrying it (in flight while the arm
   * completed) is refused like any unknown id, but its cookie is not cleared: the browser already holds the new one,
   * under the same name.
   */
  rotatedAway(idHash: string, now: Date): boolean;
}

/** Runs `fn` in the rotation's transaction, or in one of its own when the session store isn't on this database. */
export function withTx(db: Db, tx: Tx | null, fn: (tx: Tx) => void): void {
  if (tx) fn(tx);
  else writeTx(db, fn);
}

/** The patch without its `undefined` fields (they would overwrite the row's values as it moves). */
const defined = (patch: SessionPatch): SessionPatch =>
  Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as SessionPatch;

/** The movers and the recently rotated ids of one session store (per process). */
class Rotations {
  private readonly movers = new Set<SessionMover>();
  /** Old id hash → until when a request carrying it keeps its cookie. */
  private readonly away = new Map<string, number>();

  add(mover: SessionMover): () => void {
    this.movers.add(mover);
    return () => void this.movers.delete(mover);
  }

  /** What the movers are told: `before` and `after` are the row under its old and its new id. */
  static move(before: SessionRecord, after: SessionRecord, now: Date): SessionMove {
    return {
      from: before.idHash,
      to: after.idHash,
      gainsWrite: isArmed(after, now) && !isArmed(before, now),
    };
  }

  /** Inside the transaction: a mover that throws rolls the whole rotation back. */
  moveTx(move: SessionMove, tx: Tx | null) {
    for (const m of this.movers) {
      const result: unknown = m.moveSessionTx?.(move, tx);
      // An async mover would write after the commit, outside the transaction: refuse it loudly.
      if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new Error('A session mover must be synchronous');
    }
  }

  /** After the commit: in-memory state follows. A mover that fails is logged; the rotation already happened. */
  moved(move: SessionMove, { now, log }: Pick<SessionRotation, 'now' | 'log'>) {
    const t = now.getTime();
    if (this.away.size > 10_000) for (const [h, until] of this.away) if (until <= t) this.away.delete(h);
    this.away.set(move.from, t + ROTATED_GRACE_MS);
    for (const m of this.movers) {
      try {
        m.sessionMoved?.(move);
      } catch (err) {
        log?.warn({ err: { name: (err as Error).name } }, 'in-memory state did not follow a rotated session');
      }
    }
  }

  isAway(idHash: string, now: Date): boolean {
    return (this.away.get(idHash) ?? 0) > now.getTime();
  }
}

/** Whether the session is armed at `now` (write account held and window still open). */
export const isArmed = (s: Pick<SessionRecord, 'writeAccountId' | 'writeExpiresAt'>, now: Date) =>
  Boolean(s.writeAccountId && s.writeExpiresAt && s.writeExpiresAt.getTime() > now.getTime());

const DAY_MS = 86_400_000;

export class SqliteSessionStore implements SessionStore {
  private readonly rotations = new Rotations();

  constructor(private readonly db: Db) {}

  async rotate(rotation: SessionRotation): Promise<SessionRecord | null> {
    const { from, to, patch, now } = rotation;
    // BEGIN IMMEDIATE: the row and everything keyed by its hash move together, or nothing does.
    const done = writeTx(this.db, (tx) => {
      const row = tx.select().from(sessions).where(eq(sessions.idHash, from)).get();
      if (!row) return null;
      tx.delete(sessions).where(eq(sessions.idHash, from)).run();
      const next = tx
        .insert(sessions)
        .values({ ...row, ...defined(patch), idHash: to })
        .returning()
        .get();
      const move = Rotations.move(row, next, now);
      this.rotations.moveTx(move, tx);
      return { next, move };
    });
    if (!done) return null;
    this.rotations.moved(done.move, rotation);
    return done.next;
  }

  onRotate(mover: SessionMover): () => void {
    return this.rotations.add(mover);
  }

  rotatedAway(idHash: string, now: Date): boolean {
    return this.rotations.isAway(idHash, now);
  }

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
  private readonly rotations = new Rotations();

  async rotate(rotation: SessionRotation): Promise<SessionRecord | null> {
    const { from, to, patch, now } = rotation;
    const row = this.rows.get(from);
    if (!row) return null;
    if (this.rows.has(to)) throw new Error('duplicate session');
    const next: SessionRecord = { ...row, ...structuredClone(defined(patch)), idHash: to };
    const move = Rotations.move(row, next, now);
    this.rows.delete(from);
    this.rows.set(to, next);
    try {
      this.rotations.moveTx(move, null);
    } catch (err) {
      // As the database's rollback would: the session stays under its old id (movers that ran are not undone — the
      // memory stores serve tests and DB-less mock mode only).
      this.rows.delete(to);
      this.rows.set(from, row);
      throw err;
    }
    this.rotations.moved(move, rotation);
    return structuredClone(next);
  }

  onRotate(mover: SessionMover): () => void {
    return this.rotations.add(mover);
  }

  rotatedAway(idHash: string, now: Date): boolean {
    return this.rotations.isAway(idHash, now);
  }

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
