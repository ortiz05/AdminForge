import { and, desc, eq, gte, lt, lte, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { AuditRow, AuditWriter } from '../audit/writer';
import type { Database } from '../db/client';
import { auditEvents } from '../db/schema';

export interface AuditQuery {
  /** UPN substring (case-insensitive) or exact object id. */
  actor?: string;
  /** Exact action, or a prefix ending in `.` or `*` (e.g. `session.` / `session.*`). */
  action?: string;
  from?: Date;
  to?: Date;
  /** Opaque cursor from the previous page (the last seq seen). */
  cursor?: string;
  limit?: number;
}

/** GET /api/audit item. */
export interface AuditItem {
  seq: number;
  ts: string;
  actorUpn: string | null;
  actorOid: string | null;
  mode: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  result: string;
  correlationId: string;
  details: Record<string, unknown> | null;
}

export interface AuditPage {
  items: AuditItem[];
  cursor?: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const prefixOf = (action: string) => (/[.*]$/.test(action) ? action.replace(/\*$/, '') : undefined);

type RowLike = Omit<AuditRow, 'prevHash' | 'hash' | 'ts' | 'details'> & {
  ts: string | Date;
  details: unknown;
};

const toItem = (r: RowLike): AuditItem => ({
  seq: r.seq,
  ts: typeof r.ts === 'string' ? r.ts : r.ts.toISOString(),
  actorUpn: r.actorUpn ?? null,
  actorOid: r.actorOid ?? null,
  mode: r.mode ?? null,
  action: r.action,
  targetType: r.targetType ?? null,
  targetId: r.targetId ?? null,
  result: r.result,
  correlationId: r.correlationId,
  details: (r.details as Record<string, unknown> | null) ?? null,
});

/**
 * `column LIKE pattern ESCAPE '\'` — SQLite has no default escape character, and its LIKE ignores case for ASCII
 * letters (as ILIKE did for the UPN search).
 */
const likeEscaped = (column: AnyColumn, pattern: string) => sql`${column} like ${pattern} escape '\\'`;

/** Newest first, keyset-paged by seq. Works on the database or the in-memory chain (tests, DB-less mock mode). */
export async function queryAudit(
  database: Database | null,
  audit: AuditWriter,
  q: AuditQuery,
): Promise<AuditPage> {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const before = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : undefined;
  const prefix = q.action ? prefixOf(q.action) : undefined;
  let rows: AuditItem[];
  if (database) {
    const where: SQL[] = [];
    if (before !== undefined) where.push(lt(auditEvents.seq, before));
    if (q.actor)
      where.push(
        GUID.test(q.actor)
          ? eq(auditEvents.actorOid, q.actor.toLowerCase())
          : likeEscaped(auditEvents.actorUpn, `%${escapeLike(q.actor)}%`),
      );
    if (q.action)
      where.push(
        prefix !== undefined
          ? likeEscaped(auditEvents.action, `${escapeLike(prefix)}%`)
          : eq(auditEvents.action, q.action),
      );
    if (q.from) where.push(gte(auditEvents.ts, q.from));
    if (q.to) where.push(lte(auditEvents.ts, q.to));
    const found = await database.db
      .select()
      .from(auditEvents)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(auditEvents.seq))
      .limit(limit + 1);
    rows = found.map(toItem);
  } else {
    const mem = (audit as { rows?: AuditRow[] }).rows ?? [];
    const actor = q.actor?.toLowerCase();
    rows = [...mem]
      .reverse()
      .filter((r) => before === undefined || r.seq < before)
      .filter(
        (r) =>
          !actor ||
          (GUID.test(actor)
            ? r.actorOid?.toLowerCase() === actor
            : (r.actorUpn ?? '').toLowerCase().includes(actor)),
      )
      .filter(
        (r) => !q.action || (prefix !== undefined ? r.action.startsWith(prefix) : r.action === q.action),
      )
      .filter(
        (r) =>
          (!q.from || Date.parse(r.ts) >= q.from.getTime()) && (!q.to || Date.parse(r.ts) <= q.to.getTime()),
      )
      .slice(0, limit + 1)
      .map(toItem);
  }
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, ...(more ? { cursor: String(items.at(-1)!.seq) } : {}) };
}

/**
 * GET /api/audit/verify: `checked` rows re-hashed; `brokenAt` = seq of the first row whose hash does not chain — or,
 * with `keyMissing`, the first row keyed with an audit chain key that isn't configured (S-10; never the key or its id).
 */
export async function verifyAudit(
  audit: AuditWriter,
): Promise<{ ok: boolean; checked: number; brokenAt?: number; keyMissing?: boolean }> {
  const r = await audit.verify();
  if (r.ok) return { ok: true, checked: r.count };
  return { ok: false, checked: r.brokenAt, brokenAt: r.seq, ...(r.missingKey ? { keyMissing: true } : {}) };
}
