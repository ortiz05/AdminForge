import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { settings } from '../db/schema';

export interface SettingRecord<T = unknown> {
  key: string;
  value: T;
  version: number;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface SettingsStore {
  get<T = unknown>(key: string): Promise<SettingRecord<T> | null>;
  /**
   * Writes a new version. With `expectedVersion` the write only happens when the stored version matches
   * (0 = not stored yet); returns null on a mismatch (lost update).
   */
  put<T>(
    key: string,
    value: T,
    opts: { updatedBy: string | null; now: Date; expectedVersion?: number },
  ): Promise<SettingRecord<T> | null>;
}

export class PgSettingsStore implements SettingsStore {
  constructor(private readonly db: Db) {}

  async get<T>(key: string): Promise<SettingRecord<T> | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return row ? { ...row, value: row.value as T } : null;
  }

  async put<T>(
    key: string,
    value: T,
    opts: { updatedBy: string | null; now: Date; expectedVersion?: number },
  ): Promise<SettingRecord<T> | null> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(settings).where(eq(settings.key, key)).for('update').limit(1);
      const version = current?.version ?? 0;
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== version) return null;
      if (!current) {
        const [row] = await tx
          .insert(settings)
          .values({ key, value, version: 1, updatedBy: opts.updatedBy, updatedAt: opts.now })
          .returning();
        return { ...row!, value: row!.value as T };
      }
      const [row] = await tx
        .update(settings)
        .set({ value, version: version + 1, updatedBy: opts.updatedBy, updatedAt: opts.now })
        .where(and(eq(settings.key, key), eq(settings.version, version)))
        .returning();
      return row ? { ...row, value: row.value as T } : null;
    });
  }
}

export class MemorySettingsStore implements SettingsStore {
  readonly rows = new Map<string, SettingRecord>();

  async get<T>(key: string): Promise<SettingRecord<T> | null> {
    const r = this.rows.get(key);
    return r ? (structuredClone(r) as SettingRecord<T>) : null;
  }

  async put<T>(
    key: string,
    value: T,
    opts: { updatedBy: string | null; now: Date; expectedVersion?: number },
  ): Promise<SettingRecord<T> | null> {
    const version = this.rows.get(key)?.version ?? 0;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== version) return null;
    const rec: SettingRecord<T> = {
      key,
      value: structuredClone(value),
      version: version + 1,
      updatedBy: opts.updatedBy,
      updatedAt: opts.now,
    };
    this.rows.set(key, rec);
    return structuredClone(rec);
  }
}
