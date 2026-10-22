import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { writeTx, type Db, type Tx } from '../db/client';
import { preauth } from '../db/schema';
import { AppError } from '../errors';
import { withTx } from './session-store';
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
  /** Sign-ins: a keyed hash of the client's address key (flow.ts), for its share of the pending sign-ins. */
  addressHash?: string | null;
  details: PreauthDetails | null;
  expiresAt: Date;
}

export const PREAUTH_TTL_MS = 10 * 60_000;

/**
 * Round trips that may be pending at once (S-28). Every anonymous `GET /auth/login` writes one, on the one SQLite
 * writer, and the per-address limits don't bound the table when many addresses send them. Far above what ~50 people
 * signing in at once need. When the table is full, the oldest pending sign-in that has had PREAUTH_EVICT_AFTER_MS to
 * finish makes room (its callback then says the sign-in expired): a flood from a few addresses (300 a minute each)
 * cycles through the table without locking anyone out, and a real sign-in started amid it still has minutes to
 * finish. Only when even the oldest pending sign-in is younger than that (more than 2,500 starts a minute, from many
 * addresses) is a new sign-in refused with `signin_busy`, and nothing is written. Arming and a schedule's consent
 * (which need a signed-in session and are limited per session) always start and are never evicted.
 */
export const PREAUTH_MAX_PENDING = 5_000;

/** How long a pending sign-in is kept, however full the table, before a newer one may take its place. */
export const PREAUTH_EVICT_AFTER_MS = 2 * 60_000;

export interface PreauthStoreOptions {
  /** Default PREAUTH_MAX_PENDING. */
  maxPending?: number;
  /** Default PREAUTH_EVICT_AFTER_MS. */
  evictAfterMs?: number;
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

/**
 * The latest `expiresAt` a pending sign-in may have and still be evicted for `record`: one that started at least
 * `evictAfterMs` before it.
 */
const evictableUntil = (record: PreauthRecord, evictAfterMs: number) =>
  startOf(record).getTime() - evictAfterMs + PREAUTH_TTL_MS;

export interface PreauthStore {
  /**
   * Writes the record. A sign-in start that finds PREAUTH_MAX_PENDING round trips pending first evicts the oldest
   * pending sign-ins that are old enough; if there are none, it throws `signin_busy` and writes nothing.
   */
  put(record: PreauthRecord): Promise<void>;
  /** Removes and returns the record (single use). Expiry is checked by the caller. */
  take(state: string): Promise<PreauthRecord | null>;
  purge(now: Date): Promise<number>;
  /** S-08: round trips a session started (arming, a schedule's consent) follow it when its id is rotated. */
  moveSessionTx(from: string, to: string, tx: Tx | null): void;
}

export class SqlitePreauthStore implements PreauthStore {
  private readonly maxPending: number;
  private readonly evictAfterMs: number;
  constructor(
    private readonly db: Db,
    opts: PreauthStoreOptions = {},
  ) {
    this.maxPending = opts.maxPending ?? PREAUTH_MAX_PENDING;
    this.evictAfterMs = opts.evictAfterMs ?? PREAUTH_EVICT_AFTER_MS;
  }

  async put(record: PreauthRecord): Promise<void> {
    // Count, evict and insert in one write transaction: two sign-ins can't both take the last place.
    const written = writeTx(this.db, (tx) => {
      if (capped(record)) {
        const start = startOf(record);
        const [row] = tx.select({ n: count() }).from(preauth).where(gt(preauth.expiresAt, start)).all();
        const over = (row?.n ?? 0) - this.maxPending + 1;
        if (over > 0) {
          // A fair share first: the address holding the most pending sign-ins gives up its oldest, whatever their age,
          // when it holds more than this start's address — a few addresses can't hold the table against everyone else.
          if (record.addressHash) {
            const pendingSignIns = and(isNull(preauth.sessionIdHash), gt(preauth.expiresAt, start));
            const [heaviest] = tx
              .select({ address: preauth.addressHash, n: count() })
              .from(preauth)
              .where(and(pendingSignIns, isNotNull(preauth.addressHash)))
              .groupBy(preauth.addressHash)
              .orderBy(desc(count()))
              .limit(1)
              .all();
            const [mine] = tx
              .select({ n: count() })
              .from(preauth)
              .where(and(pendingSignIns, eq(preauth.addressHash, record.addressHash)))
              .all();
            if (
              heaviest?.address &&
              heaviest.address !== record.addressHash &&
              heaviest.n > (mine?.n ?? 0) + over
            ) {
              const theirs = tx
                .select({ state: preauth.state })
                .from(preauth)
                .where(and(pendingSignIns, eq(preauth.addressHash, heaviest.address)))
                .orderBy(asc(preauth.expiresAt))
                .limit(over)
                .all();
              tx.delete(preauth)
                .where(
                  inArray(
                    preauth.state,
                    theirs.map((r) => r.state),
                  ),
                )
                .run();
              tx.insert(preauth).values(record).run();
              return true;
            }
          }
          const oldest = tx
            .select({ state: preauth.state, expiresAt: preauth.expiresAt })
            .from(preauth)
            .where(and(isNull(preauth.sessionIdHash), gt(preauth.expiresAt, start)))
            .orderBy(asc(preauth.expiresAt))
            .limit(over)
            .all();
          const until = evictableUntil(record, this.evictAfterMs);
          if (oldest.length < over || oldest.some((r) => r.expiresAt.getTime() > until)) return false;
          tx.delete(preauth)
            .where(
              inArray(
                preauth.state,
                oldest.map((r) => r.state),
              ),
            )
            .run();
        }
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
      ...(row.addressHash ? { addressHash: row.addressHash } : {}),
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

  moveSessionTx(from: string, to: string, tx: Tx | null): void {
    withTx(this.db, tx, (t) =>
      t.update(preauth).set({ sessionIdHash: to }).where(eq(preauth.sessionIdHash, from)).run(),
    );
  }
}

export class MemoryPreauthStore implements PreauthStore {
  readonly rows = new Map<string, PreauthRecord>();
  private readonly maxPending: number;
  private readonly evictAfterMs: number;
  constructor(opts: PreauthStoreOptions = {}) {
    this.maxPending = opts.maxPending ?? PREAUTH_MAX_PENDING;
    this.evictAfterMs = opts.evictAfterMs ?? PREAUTH_EVICT_AFTER_MS;
  }

  async put(record: PreauthRecord): Promise<void> {
    if (capped(record)) {
      const start = startOf(record).getTime();
      const pending = [...this.rows.values()].filter((r) => r.expiresAt.getTime() > start);
      const over = pending.length - this.maxPending + 1;
      if (over > 0 && record.addressHash) {
        // A fair share first (see SqlitePreauthStore.put).
        const byAddress = new Map<string, PreauthRecord[]>();
        for (const r of pending)
          if (r.sessionIdHash === null && r.addressHash)
            byAddress.set(r.addressHash, [...(byAddress.get(r.addressHash) ?? []), r]);
        const mine = byAddress.get(record.addressHash)?.length ?? 0;
        const [address, theirs] = [...byAddress.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
        if (address && theirs && address !== record.addressHash && theirs.length > mine + over) {
          for (const r of theirs.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime()).slice(0, over))
            this.rows.delete(r.state);
          this.rows.set(record.state, structuredClone(record));
          return;
        }
      }
      if (over > 0) {
        const oldest = pending
          .filter((r) => r.sessionIdHash === null)
          .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
          .slice(0, over);
        const until = evictableUntil(record, this.evictAfterMs);
        if (oldest.length < over || oldest.some((r) => r.expiresAt.getTime() > until)) throw signinBusy();
        for (const r of oldest) this.rows.delete(r.state);
      }
    }
    this.rows.set(record.state, structuredClone(record));
  }

  async take(state: string): Promise<PreauthRecord | null> {
    const row = this.rows.get(state) ?? null;
    this.rows.delete(state);
    return row;
  }

  moveSessionTx(from: string, to: string): void {
    for (const [state, r] of this.rows)
      if (r.sessionIdHash === from) this.rows.set(state, { ...r, sessionIdHash: to });
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
