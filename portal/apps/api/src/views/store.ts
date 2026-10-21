import { randomUUID } from 'node:crypto';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { savedViews } from '../db/schema';

/** A saved list/report view (params, columns, sort, filters…), personal or shared (R9). */
export interface ViewRecord {
  id: string;
  userOid: string;
  pageKey: string;
  name: string;
  state: Record<string, unknown>;
  shared: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type NewView = Pick<ViewRecord, 'userOid' | 'pageKey' | 'name' | 'state' | 'shared'>;
export type ViewPatch = Partial<Pick<ViewRecord, 'name' | 'state' | 'shared'>>;

export interface ViewStore {
  /** The user's own views for a page plus views others shared, ordered by name. */
  list(pageKey: string, userOid: string): Promise<ViewRecord[]>;
  get(id: string): Promise<ViewRecord | null>;
  create(view: NewView, now: Date): Promise<ViewRecord>;
  update(id: string, patch: ViewPatch, now: Date): Promise<ViewRecord | null>;
  delete(id: string): Promise<void>;
  /** The user's own views for a page (limits, name clashes). */
  own(pageKey: string, userOid: string): Promise<ViewRecord[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const byName = (a: ViewRecord, b: ViewRecord) =>
  a.name.localeCompare(b.name) || a.createdAt.getTime() - b.createdAt.getTime();
const toRecord = (r: typeof savedViews.$inferSelect): ViewRecord => ({
  ...r,
  state: (r.state ?? {}) as Record<string, unknown>,
});

export class SqliteViewStore implements ViewStore {
  constructor(private readonly db: Db) {}

  async list(pageKey: string, userOid: string): Promise<ViewRecord[]> {
    const rows = await this.db
      .select()
      .from(savedViews)
      .where(
        and(
          eq(savedViews.pageKey, pageKey),
          or(eq(savedViews.userOid, userOid), eq(savedViews.shared, true)),
        ),
      )
      .orderBy(asc(savedViews.name), asc(savedViews.createdAt));
    return rows.map(toRecord);
  }

  async own(pageKey: string, userOid: string): Promise<ViewRecord[]> {
    const rows = await this.db
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.pageKey, pageKey), eq(savedViews.userOid, userOid)));
    return rows.map(toRecord);
  }

  async get(id: string): Promise<ViewRecord | null> {
    if (!UUID.test(id)) return null;
    const [row] = await this.db.select().from(savedViews).where(eq(savedViews.id, id)).limit(1);
    return row ? toRecord(row) : null;
  }

  async create(view: NewView, now: Date): Promise<ViewRecord> {
    const [row] = await this.db
      .insert(savedViews)
      .values({ ...view, createdAt: now, updatedAt: now })
      .returning();
    return toRecord(row!);
  }

  async update(id: string, patch: ViewPatch, now: Date): Promise<ViewRecord | null> {
    if (!UUID.test(id)) return null;
    const [row] = await this.db
      .update(savedViews)
      .set({ ...patch, updatedAt: now })
      .where(eq(savedViews.id, id))
      .returning();
    return row ? toRecord(row) : null;
  }

  async delete(id: string): Promise<void> {
    if (!UUID.test(id)) return;
    await this.db.delete(savedViews).where(eq(savedViews.id, id));
  }

  /** Test helper: rows for a page (any user). */
  async countFor(pageKey: string): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(savedViews)
      .where(eq(savedViews.pageKey, pageKey));
    return r?.n ?? 0;
  }
}

/** In-memory store for tests and DB-less mock mode. */
export class MemoryViewStore implements ViewStore {
  readonly rows = new Map<string, ViewRecord>();

  async list(pageKey: string, userOid: string): Promise<ViewRecord[]> {
    return [...this.rows.values()]
      .filter((v) => v.pageKey === pageKey && (v.userOid === userOid || v.shared))
      .sort(byName)
      .map((v) => structuredClone(v));
  }
  async own(pageKey: string, userOid: string): Promise<ViewRecord[]> {
    return [...this.rows.values()]
      .filter((v) => v.pageKey === pageKey && v.userOid === userOid)
      .map((v) => structuredClone(v));
  }
  async get(id: string): Promise<ViewRecord | null> {
    const v = this.rows.get(id);
    return v ? structuredClone(v) : null;
  }
  async create(view: NewView, now: Date): Promise<ViewRecord> {
    const rec: ViewRecord = { ...structuredClone(view), id: randomUUID(), createdAt: now, updatedAt: now };
    this.rows.set(rec.id, rec);
    return structuredClone(rec);
  }
  async update(id: string, patch: ViewPatch, now: Date): Promise<ViewRecord | null> {
    const v = this.rows.get(id);
    if (!v) return null;
    const next = { ...v, ...structuredClone(patch), updatedAt: now };
    this.rows.set(id, next);
    return structuredClone(next);
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}
