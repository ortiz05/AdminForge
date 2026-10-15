import { asc, desc, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditEvents } from '../db/schema';
import { chainHash, GENESIS, verifyChain } from './chain';

export type AuditResult = 'success' | 'failure' | 'denied';

/** What callers supply. `ts` defaults to now. */
export interface AuditInput {
  ts?: Date;
  actorOid?: string | null;
  actorUpn?: string | null;
  sessionHash?: string | null;
  mode?: 'read' | 'write' | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown> | null;
  result: AuditResult;
  correlationId: string;
  ip?: string | null;
}

/**
 * The hashed event is exactly the persisted columns minus seq/prevHash/hash, with every column
 * present (null when absent) and `ts` as an ISO string, so a row read back re-hashes identically.
 */
export interface AuditEvent {
  ts: string;
  actorOid: string | null;
  actorUpn: string | null;
  sessionHash: string | null;
  mode: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  result: string;
  correlationId: string;
  ip: string | null;
}

export interface AuditRow extends AuditEvent {
  seq: number;
  prevHash: string;
  hash: string;
}

export interface AuditWriter {
  append(input: AuditInput): Promise<AuditRow>;
  /** Re-walks the whole chain (the Audit page, `adminforge audit verify`, and the probes.audit-chain check). */
  verify(): Promise<{ ok: true; count: number } | { ok: false; brokenAt: number; seq: number }>;
}

export function toAuditEvent(input: AuditInput, now: Date): AuditEvent {
  return {
    ts: (input.ts ?? now).toISOString(),
    actorOid: input.actorOid ?? null,
    actorUpn: input.actorUpn ?? null,
    sessionHash: input.sessionHash ?? null,
    mode: input.mode ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    // JSON round trip: drops undefined members exactly as jsonb storage would.
    details: input.details ? (JSON.parse(JSON.stringify(input.details)) as Record<string, unknown>) : null,
    result: input.result,
    correlationId: input.correlationId,
    ip: input.ip ?? null,
  };
}

const eventOf = ({ seq: _seq, prevHash: _p, hash: _h, ...event }: AuditRow): AuditEvent => event;

function verifyRows(rows: AuditRow[]) {
  const res = verifyChain(rows.map((r) => ({ ...eventOf(r), prevHash: r.prevHash, hash: r.hash })));
  return res.ok
    ? { ok: true as const, count: rows.length }
    : { ok: false as const, brokenAt: res.brokenAt, seq: rows[res.brokenAt]!.seq };
}

/** Lock key shared by every writer of the chain (pg_advisory_xact_lock). */
const AUDIT_LOCK = sql`select pg_advisory_xact_lock(hashtext('adminforge.audit_events'))`;

export class PgAuditWriter implements AuditWriter {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async append(input: AuditInput): Promise<AuditRow> {
    const event = toAuditEvent(input, this.now());
    return this.db.transaction(async (tx) => {
      // Serialises appenders across processes so prev_hash always points at the true tail.
      await tx.execute(AUDIT_LOCK);
      const [last] = await tx
        .select({ hash: auditEvents.hash })
        .from(auditEvents)
        .orderBy(desc(auditEvents.seq))
        .limit(1);
      const prevHash = last?.hash ?? GENESIS;
      const hash = chainHash(prevHash, { ...event });
      const [row] = await tx
        .insert(auditEvents)
        .values({ ...event, ts: new Date(event.ts), prevHash, hash })
        .returning({ seq: auditEvents.seq });
      return { ...event, seq: row!.seq, prevHash, hash };
    });
  }

  async verify() {
    const rows = await this.db.select().from(auditEvents).orderBy(asc(auditEvents.seq));
    return verifyRows(
      rows.map((r) => ({
        ...r,
        ts: r.ts.toISOString(),
        details: (r.details as Record<string, unknown> | null) ?? null,
      })),
    );
  }
}

/** In-memory chain for tests and DB-less mock mode. */
export class MemoryAuditWriter implements AuditWriter {
  readonly rows: AuditRow[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  async append(input: AuditInput): Promise<AuditRow> {
    const event = toAuditEvent(input, this.now());
    const prevHash = this.rows.at(-1)?.hash ?? GENESIS;
    const row: AuditRow = {
      ...event,
      seq: this.rows.length + 1,
      prevHash,
      hash: chainHash(prevHash, { ...event }),
    };
    this.rows.push(row);
    return structuredClone(row);
  }

  async verify() {
    return verifyRows(this.rows);
  }
}
