import type { ICacheClient, IPartitionManager } from '@azure/msal-node';
import { eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { tokenCache } from '../db/schema';
import { open, seal, type EnvelopeKey } from '../security/envelope';
import { withTx } from './session-store';

/** Raw storage of sealed blobs by partition key. */
export interface SealedBlobStore {
  get(partitionKey: string): Promise<string | null>;
  set(partitionKey: string, sealed: string): Promise<void>;
  delete(partitionKey: string): Promise<void>;
  /**
   * Synchronous, inside a session rotation's transaction (`tx`; null for the memory store): the blob at `from` goes,
   * and `reseal(blob)` is stored at `to` — unless `to` already holds one (the newer blob wins) or `reseal` gives null.
   */
  moveTx(from: string, to: string, tx: Tx | null, reseal: (sealed: string) => string | null): void;
}

/**
 * MSAL distributed cache client. Blobs are sealed with AES-256-GCM before they reach storage and the
 * partition key is the AAD, so a blob copied to another partition (session) fails to open.
 */
export interface TokenCacheStore extends ICacheClient {
  delete(partitionKey: string): Promise<void>;
  /**
   * S-08: moves a partition when its session's id is rotated (arming), inside the rotation's transaction. The blob is
   * opened under the old key and sealed again under the new one (the partition key is the AAD, so a copied blob would
   * not open). A partition the new id already has wins — the Write app redeems straight into the new id's — and the
   * old one is dropped; so is one that no longer opens (rotated key, tampering).
   */
  movePartitionTx(from: string, to: string, tx: Tx | null): void;
}

export interface TokenCacheLogger {
  warn(obj: object, msg: string): void;
}

export function createTokenCache(
  store: SealedBlobStore,
  key: EnvelopeKey,
  log?: TokenCacheLogger,
): TokenCacheStore {
  return {
    async get(partitionKey) {
      const sealed = await store.get(partitionKey);
      if (!sealed) return '';
      try {
        return open(sealed, key, partitionKey);
      } catch {
        // Wrong key, rotated key, or tampering: treat as empty so the user simply signs in again.
        log?.warn(
          { partition: partitionKey.split(':')[0] },
          'token cache blob could not be opened; ignoring it',
        );
        return '';
      }
    },
    async set(partitionKey, value) {
      await store.set(partitionKey, seal(value, key, partitionKey));
      return value;
    },
    delete: (partitionKey) => store.delete(partitionKey),
    movePartitionTx(from, to, tx) {
      store.moveTx(from, to, tx, (sealed) => {
        try {
          return seal(open(sealed, key, from), key, to);
        } catch {
          log?.warn({ partition: from.split(':')[0] }, 'token cache blob could not be opened; dropping it');
          return null;
        }
      });
    },
  };
}

/** One fixed partition per MSAL client instance (one client per request). */
export class FixedPartition implements IPartitionManager {
  constructor(private readonly key: string) {}
  async getKey(): Promise<string> {
    return this.key;
  }
  async extractKey(): Promise<string> {
    return this.key;
  }
}

export class SqliteSealedBlobStore implements SealedBlobStore {
  constructor(private readonly db: Db) {}

  async get(partitionKey: string): Promise<string | null> {
    const [row] = await this.db
      .select({ sealed: tokenCache.sealed })
      .from(tokenCache)
      .where(eq(tokenCache.partitionKey, partitionKey))
      .limit(1);
    return row?.sealed ?? null;
  }

  async set(partitionKey: string, sealed: string): Promise<void> {
    const updatedAt = new Date();
    await this.db
      .insert(tokenCache)
      .values({ partitionKey, sealed, updatedAt })
      .onConflictDoUpdate({ target: tokenCache.partitionKey, set: { sealed, updatedAt } });
  }

  async delete(partitionKey: string): Promise<void> {
    await this.db.delete(tokenCache).where(eq(tokenCache.partitionKey, partitionKey));
  }

  moveTx(from: string, to: string, tx: Tx | null, reseal: (sealed: string) => string | null): void {
    withTx(this.db, tx, (t) => {
      const row = t
        .select({ sealed: tokenCache.sealed })
        .from(tokenCache)
        .where(eq(tokenCache.partitionKey, from))
        .get();
      if (!row) return;
      t.delete(tokenCache).where(eq(tokenCache.partitionKey, from)).run();
      const taken = t
        .select({ key: tokenCache.partitionKey })
        .from(tokenCache)
        .where(eq(tokenCache.partitionKey, to))
        .get();
      const sealed = taken ? null : reseal(row.sealed);
      if (sealed) t.insert(tokenCache).values({ partitionKey: to, sealed, updatedAt: new Date() }).run();
    });
  }
}

export class MemorySealedBlobStore implements SealedBlobStore {
  readonly rows = new Map<string, string>();
  async get(partitionKey: string) {
    return this.rows.get(partitionKey) ?? null;
  }
  async set(partitionKey: string, sealed: string) {
    this.rows.set(partitionKey, sealed);
  }
  async delete(partitionKey: string) {
    this.rows.delete(partitionKey);
  }
  moveTx(from: string, to: string, _tx: Tx | null, reseal: (sealed: string) => string | null) {
    const blob = this.rows.get(from);
    if (blob === undefined) return;
    this.rows.delete(from);
    const sealed = this.rows.has(to) ? null : reseal(blob);
    if (sealed) this.rows.set(to, sealed);
  }
}
