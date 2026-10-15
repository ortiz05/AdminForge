import type { ICacheClient, IPartitionManager } from '@azure/msal-node';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { tokenCache } from '../db/schema';
import { open, seal } from '../security/envelope';

/** Raw storage of sealed blobs by partition key. */
export interface SealedBlobStore {
  get(partitionKey: string): Promise<string | null>;
  set(partitionKey: string, sealed: string): Promise<void>;
  delete(partitionKey: string): Promise<void>;
}

/**
 * MSAL distributed cache client. Blobs are sealed with AES-256-GCM before they reach storage and the
 * partition key is the AAD, so a blob copied to another partition (session) fails to open.
 */
export interface TokenCacheStore extends ICacheClient {
  delete(partitionKey: string): Promise<void>;
}

export interface TokenCacheLogger {
  warn(obj: object, msg: string): void;
}

export function createTokenCache(store: SealedBlobStore, key: Buffer, log?: TokenCacheLogger): TokenCacheStore {
  return {
    async get(partitionKey) {
      const sealed = await store.get(partitionKey);
      if (!sealed) return '';
      try {
        return open(sealed, key, partitionKey);
      } catch {
        // Wrong key, rotated key, or tampering: treat as empty so the user simply signs in again.
        log?.warn({ partition: partitionKey.split(':')[0] }, 'token cache blob could not be opened; ignoring it');
        return '';
      }
    },
    async set(partitionKey, value) {
      await store.set(partitionKey, seal(value, key, partitionKey));
      return value;
    },
    delete: (partitionKey) => store.delete(partitionKey),
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

export class PgSealedBlobStore implements SealedBlobStore {
  constructor(private readonly db: Db) {}

  async get(partitionKey: string): Promise<string | null> {
    const [row] = await this.db.select({ sealed: tokenCache.sealed }).from(tokenCache).where(eq(tokenCache.partitionKey, partitionKey)).limit(1);
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
}
