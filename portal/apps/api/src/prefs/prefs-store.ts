import { UserPrefs } from '@adminforge/schemas';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { userPrefs } from '../db/schema';

export interface PrefsStore {
  get(userOid: string): Promise<UserPrefs>;
  put(userOid: string, prefs: UserPrefs): Promise<void>;
}

/** Stored prefs that no longer match the schema are dropped rather than breaking /api/me. */
const sanitize = (value: unknown): UserPrefs => {
  const parsed = UserPrefs.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
};

export class PgPrefsStore implements PrefsStore {
  constructor(private readonly db: Db) {}

  async get(userOid: string): Promise<UserPrefs> {
    const [row] = await this.db
      .select({ prefs: userPrefs.prefs })
      .from(userPrefs)
      .where(eq(userPrefs.userOid, userOid))
      .limit(1);
    return sanitize(row?.prefs);
  }

  async put(userOid: string, prefs: UserPrefs): Promise<void> {
    const updatedAt = new Date();
    await this.db
      .insert(userPrefs)
      .values({ userOid, prefs, updatedAt })
      .onConflictDoUpdate({ target: userPrefs.userOid, set: { prefs, updatedAt } });
  }
}

export class MemoryPrefsStore implements PrefsStore {
  readonly rows = new Map<string, UserPrefs>();
  async get(userOid: string): Promise<UserPrefs> {
    return sanitize(structuredClone(this.rows.get(userOid)));
  }
  async put(userOid: string, prefs: UserPrefs): Promise<void> {
    this.rows.set(userOid, structuredClone(prefs));
  }
}
