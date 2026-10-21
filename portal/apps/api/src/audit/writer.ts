import { asc, desc, eq, gt } from 'drizzle-orm';
import { writeTx, yieldToLoop, type Db } from '../db/client';
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

export type VerifyResult =
  | {
      ok: true;
      count: number;
      /** The tail when the walk ended (absent for an empty chain). */ tail?: Checkpoint;
    }
  | { ok: false; brokenAt: number; seq: number };

/** A point in the chain: the last verified event's seq and hash. */
export interface Checkpoint {
  seq: number;
  hash: string;
}

/** What the audit-chain check found (`verifyIncremental`). */
export type ChainCheck = VerifyResult & {
  /** `full`: the whole chain was walked; `incremental`: only the events after the last verified checkpoint. */
  scope: 'full' | 'incremental';
  /** Events read and re-hashed in this check (the chain's length is `count`). */
  checked: number;
};

/** The audit-chain check walks the whole chain again once its last full walk is this old (D-05: daily). */
export const FULL_VERIFY_EVERY_MS = 86_400_000;

/**
 * Where a verified tail is recorded outside the database (the external anchor): by default one JSON line on stdout —
 * the api container's log, which the cluster's log shipping keeps off the volume. Someone who rewrites the table can
 * re-hash the chain, but not the checkpoints already shipped: compare them with `adminforge audit verify`.
 */
export type CheckpointSink = (checkpoint: Checkpoint & { count: number; ts: string }) => void;

export const stdoutCheckpoints: CheckpointSink = (cp) => {
  process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'audit chain checkpoint', ...cp })}\n`);
};

export interface AuditWriter {
  append(input: AuditInput): Promise<AuditRow>;
  /** Re-walks the whole chain (the Audit page, `adminforge audit verify`, backups, the daily audit-chain check). */
  verify(): Promise<VerifyResult>;
  /**
   * The hourly probes.audit-chain check: only the events after the last verified checkpoint, or the whole chain when
   * there is none yet or the last full walk is `fullEveryMs` old. Absent: the check calls `verify`.
   */
  verifyIncremental?(fullEveryMs?: number): Promise<ChainCheck>;
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
    // JSON round trip: drops undefined members exactly as JSON storage does.
    details: input.details ? (JSON.parse(JSON.stringify(input.details)) as Record<string, unknown>) : null,
    result: input.result,
    correlationId: input.correlationId,
    ip: input.ip ?? null,
  };
}

const eventOf = ({ seq: _seq, prevHash: _p, hash: _h, ...event }: AuditRow): AuditEvent => event;

function verifyRows(rows: AuditRow[], genesis = GENESIS, offset = 0): VerifyResult {
  const res = verifyChain(
    rows.map((r) => ({ ...eventOf(r), prevHash: r.prevHash, hash: r.hash })),
    genesis,
  );
  if (!res.ok) return { ok: false, brokenAt: offset + res.brokenAt, seq: rows[res.brokenAt]!.seq };
  const last = rows.at(-1);
  return { ok: true, count: rows.length, ...(last ? { tail: { seq: last.seq, hash: last.hash } } : {}) };
}

/** Rows per round trip when walking the chain: memory stays flat however long the audit log grows. */
export const VERIFY_BATCH = 2_000;

/** A verified point to continue from: the tail's seq and hash and the chain's length up to it. */
type Verified = Checkpoint & { count: number };

const rowOf = (r: typeof auditEvents.$inferSelect): AuditRow => ({
  ...r,
  ts: r.ts.toISOString(),
  details: (r.details as Record<string, unknown> | null) ?? null,
});

export class SqliteAuditWriter implements AuditWriter {
  /**
   * The last verified tail and when the whole chain was last walked, in this process's memory (D-05). Lost at a
   * restart, so the first check after one walks the whole chain; the checkpoints shipped to the log stay the anchor.
   */
  private verified: Verified | null = null;
  private fullAt: number | null = null;

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
    private readonly checkpoints: CheckpointSink | null = stdoutCheckpoints,
    private readonly batch = VERIFY_BATCH,
  ) {}

  async append(input: AuditInput): Promise<AuditRow> {
    const event = toAuditEvent(input, this.now());
    // BEGIN IMMEDIATE takes the write lock before reading the tail, so every appender — in this process or another
    // (the CLI) — chains onto the true tail.
    return writeTx(this.db, (tx) => {
      const last = tx
        .select({ hash: auditEvents.hash })
        .from(auditEvents)
        .orderBy(desc(auditEvents.seq))
        .limit(1)
        .get();
      const prevHash = last?.hash ?? GENESIS;
      const hash = chainHash(prevHash, { ...event });
      const row = tx
        .insert(auditEvents)
        .values({ ...event, ts: new Date(event.ts), prevHash, hash })
        .returning({ seq: auditEvents.seq })
        .get();
      return { ...event, seq: row.seq, prevHash, hash };
    });
  }

  /** Walks the whole chain in seq order, `batch` rows at a time (keyset paging), then records the verified tail. */
  async verify(): Promise<VerifyResult> {
    const { checked: _checked, ...r } = await this.walk(null);
    return r;
  }

  async verifyIncremental(fullEveryMs = FULL_VERIFY_EVERY_MS): Promise<ChainCheck> {
    const from = this.verified;
    if (!from || this.fullAt === null || this.now().getTime() - this.fullAt >= fullEveryMs)
      return { ...(await this.walk(null)), scope: 'full' };
    // The checkpoint event must still be there, unchanged: removing or rewriting the tail can't hide behind it.
    if (from.seq > 0) {
      const row = this.db.select().from(auditEvents).where(eq(auditEvents.seq, from.seq)).get();
      const ok = !!row && row.hash === from.hash && verifyRows([rowOf(row)], row.prevHash).ok;
      if (!ok) {
        this.verified = null;
        return { ok: false, brokenAt: from.count - 1, seq: from.seq, scope: 'incremental', checked: 1 };
      }
    }
    return { ...(await this.walk(from)), scope: 'incremental' };
  }

  /**
   * Re-hashes the events after `from` (the whole chain when null), `batch` rows per round trip with the event loop let
   * in between, ships the verified tail as a checkpoint and remembers it for the next incremental check.
   */
  private async walk(from: Verified | null): Promise<VerifyResult & { checked: number }> {
    let prev = from?.hash ?? GENESIS;
    let after = from?.seq ?? 0;
    let count = from?.count ?? 0;
    let checked = 0;
    let tail: Checkpoint | undefined = from && from.seq > 0 ? { seq: from.seq, hash: from.hash } : undefined;
    for (;;) {
      const rows = this.db
        .select()
        .from(auditEvents)
        .where(gt(auditEvents.seq, after))
        .orderBy(asc(auditEvents.seq))
        .limit(this.batch)
        .all();
      if (!rows.length) break;
      const res = verifyRows(rows.map(rowOf), prev, count);
      if (!res.ok) {
        this.verified = null;
        return { ...res, checked: checked + res.brokenAt - count + 1 };
      }
      count += res.count;
      checked += res.count;
      tail = res.tail;
      prev = tail!.hash;
      after = tail!.seq;
      if (rows.length < this.batch) break;
      await yieldToLoop();
    }
    if (tail) this.checkpoints?.({ ...tail, count, ts: this.now().toISOString() });
    this.verified = { seq: tail?.seq ?? 0, hash: tail?.hash ?? GENESIS, count };
    if (!from) this.fullAt = this.now().getTime();
    return { ok: true, count, checked, ...(tail ? { tail } : {}) };
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
