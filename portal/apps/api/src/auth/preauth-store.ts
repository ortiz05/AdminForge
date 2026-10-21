import { count, eq, gt, lt } from 'drizzle-orm';
import { writeTx, type Db } from '../db/client';
import { preauth } from '../db/schema';
import { AppError } from '../errors';
import type { AppKind } from './types';

/** Extra data carried through an arm round trip (audited at the callback), or the schedule a grant is for. */
export interface PreauthDetails {
  minutes?: number;
  reason?: string;
  /** kind `schedule`: the schedule whose creator is granting it their read access (ADR-014). */
  scheduleId?: string;
  scheduleKey?: string;
}

/** read = sign-in; write = arm; schedule = a schedule's creator granting it their read access (Read app). */
export type PreauthKind = AppKind | 'schedule';

/** A pending sign-in or arm: OAuth state, PKCE verifier, nonce, and where to go afterwards. */
export interface PreauthRecord {
  state: string;
  kind: PreauthKind;
  verifier: string;
  nonce: string;
  returnTo: string;
  /** For arm (write) round trips: the session that started it. */
  sessionIdHash: string | null;
  /** sha256 of the browser-binding cookie: the callback must come back to the same browser. */
  bindingHash: string | null;
  details: PreauthDetails | null;
  expiresAt: Date;
}

export const PREAUTH_TTL_MS = 10 * 60_000;

/**
 * Round trips that may be pending at once (S-28). Every anonymous `GET /auth/login` writes one, on the one SQLite
 * writer, and the per-address limits don't bound the table when many addresses send them. Beyond this many unexpired
 * rows a new sign-in start is refused with `signin_busy` and nothing is written; arming and a schedule's consent (which
 * need a signed-in session and are limited per session) still start. Far above what ~50 people signing in at once need.
 */
export const PREAUTH_MAX_PENDING = 5_000;

export interface PreauthStoreOptions {
  /** Default PREAUTH_MAX_PENDING. */
  maxPending?: number;
}

/** 503: the pending sign-ins are full; the person waits for them to expire. */
export const signinBusy = () =>
  new AppError(
    503,
    'signin_busy',
    'AdminForge has too many sign-ins in progress right now, so it didn’t start yours.',
    {
      hint: 'Wait a few minutes, then sign in again. If it keeps happening, give a portal administrator the reference.',
    },
  );

/** Only sign-ins start without a session; the cap applies to them. */
const capped = (record: PreauthRecord) => record.sessionIdHash === null;

/**
 * When `record`'s round trip started: every record is written with `expiresAt` = start + PREAUTH_TTL_MS
 * (`beginRoundTrip`), so the rows still pending then are those that expire after it — no clock of the store's own.
 */
const startOf = (record: PreauthRecord) => new Date(record.expiresAt.getTime() - PREAUTH_TTL_MS);

export interface PreauthStore {
  /** Writes the record; a sign-in start beyond PREAUTH_MAX_PENDING pending rows throws `signin_busy` instead. */
  put(record: PreauthRecord): Promise<void>;
  /** Removes and returns the record (single use). Expiry is checked by the caller. */
  take(state: string): Promise<PreauthRecord | null>;
  purge(now: Date): Promise<number>;
}

export class SqlitePreauthStore implements PreauthStore {
  private readonly maxPending: number;
  constructor(
    private readonly db: Db,
    opts: PreauthStoreOptions = {},
  ) {
    this.maxPending = opts.maxPending ?? PREAUTH_MAX_PENDING;
  }

  async put(record: PreauthRecord): Promise<void> {
    // The count and the insert in one write transaction: two sign-ins can't both take the last place.
    const written = writeTx(this.db, (tx) => {
      if (capped(record)) {
        const [row] = tx
          .select({ n: count() })
          .from(preauth)
          .where(gt(preauth.expiresAt, startOf(record)))
          .all();
        if ((row?.n ?? 0) >= this.maxPending) return false;
      }
      tx.insert(preauth).values(record).run();
      return true;
    });
    if (!written) throw signinBusy();
  }

  async take(state: string): Promise<PreauthRecord | null> {
    const [row] = await this.db.delete(preauth).where(eq(preauth.state, state)).returning();
    if (!row) return null;
    return {
      state: row.state,
      kind: row.kind,
      verifier: row.verifier,
      nonce: row.nonce,
      returnTo: row.returnTo,
      sessionIdHash: row.sessionIdHash,
      bindingHash: row.bindingHash,
      details: (row.details as PreauthDetails | null) ?? null,
      expiresAt: row.expiresAt,
    };
  }

  async purge(now: Date): Promise<number> {
    const removed = await this.db
      .delete(preauth)
      .where(lt(preauth.expiresAt, now))
      .returning({ state: preauth.state });
    return removed.length;
  }
}

export class MemoryPreauthStore implements PreauthStore {
  readonly rows = new Map<string, PreauthRecord>();
  private readonly maxPending: number;
  constructor(opts: PreauthStoreOptions = {}) {
    this.maxPending = opts.maxPending ?? PREAUTH_MAX_PENDING;
  }

  async put(record: PreauthRecord): Promise<void> {
    if (capped(record)) {
      const start = startOf(record).getTime();
      let pending = 0;
      for (const r of this.rows.values()) if (r.expiresAt.getTime() > start) pending++;
      if (pending >= this.maxPending) throw signinBusy();
    }
    this.rows.set(record.state, structuredClone(record));
  }

  async take(state: string): Promise<PreauthRecord | null> {
    const row = this.rows.get(state) ?? null;
    this.rows.delete(state);
    return row;
  }

  async purge(now: Date): Promise<number> {
    let removed = 0;
    for (const [state, r] of this.rows) {
      if (r.expiresAt.getTime() < now.getTime()) {
        this.rows.delete(state);
        removed++;
      }
    }
    return removed;
  }
}
