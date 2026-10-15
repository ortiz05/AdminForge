import { eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { preauth } from '../db/schema';
import type { AppKind } from './types';

/** Extra data carried through an arm round trip (audited at the callback). */
export interface PreauthDetails {
  minutes?: number;
  reason?: string;
}

/** A pending sign-in or arm: OAuth state, PKCE verifier, nonce, and where to go afterwards. */
export interface PreauthRecord {
  state: string;
  kind: AppKind;
  verifier: string;
  nonce: string;
  returnTo: string;
  /** For arm (write) round trips: the session that started it. */
  sessionIdHash: string | null;
  details: PreauthDetails | null;
  expiresAt: Date;
}

export const PREAUTH_TTL_MS = 10 * 60_000;

export interface PreauthStore {
  put(record: PreauthRecord): Promise<void>;
  /** Removes and returns the record (single use). Expiry is checked by the caller. */
  take(state: string): Promise<PreauthRecord | null>;
  purge(now: Date): Promise<number>;
}

export class PgPreauthStore implements PreauthStore {
  constructor(private readonly db: Db) {}

  async put(record: PreauthRecord): Promise<void> {
    await this.db.insert(preauth).values(record);
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
      details: (row.details as PreauthDetails | null) ?? null,
      expiresAt: row.expiresAt,
    };
  }

  async purge(now: Date): Promise<number> {
    const removed = await this.db.delete(preauth).where(lt(preauth.expiresAt, now)).returning({ state: preauth.state });
    return removed.length;
  }
}

export class MemoryPreauthStore implements PreauthStore {
  readonly rows = new Map<string, PreauthRecord>();

  async put(record: PreauthRecord): Promise<void> {
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
