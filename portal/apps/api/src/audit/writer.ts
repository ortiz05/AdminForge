import { asc, desc, gt } from 'drizzle-orm';
import { writeTx, type Db } from '../db/client';
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
  /** Re-walks the whole chain (the Audit page, `adminforge audit verify`, and the probes.audit-chain check). */
  verify(): Promise<VerifyResult>;
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

/** Pause between verify batches so a long chain never holds the event loop for long (better-sqlite3 is synchronous). */
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export class SqliteAuditWriter implements AuditWriter {
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

  /** Walks the chain in seq order, `batch` rows at a time (keyset paging), then records the verified tail. */
  async verify(): Promise<VerifyResult> {
    let prev = GENESIS;
    let after = 0;
    let count = 0;
    let tail: Checkpoint | undefined;
    for (;;) {
      const rows = await this.db
        .select()
        .from(auditEvents)
        .where(gt(auditEvents.seq, after))
        .orderBy(asc(auditEvents.seq))
        .limit(this.batch);
      if (!rows.length) break;
      const res = verifyRows(
        rows.map((r) => ({
          ...r,
          ts: r.ts.toISOString(),
          details: (r.details as Record<string, unknown> | null) ?? null,
        })),
        prev,
        count,
      );
      if (!res.ok) return res;
      count += res.count;
      tail = res.tail;
      prev = tail!.hash;
      after = tail!.seq;
      if (rows.length < this.batch) break;
      await yieldToLoop();
    }
    if (tail) this.checkpoints?.({ ...tail, count, ts: this.now().toISOString() });
    return { ok: true, count, ...(tail ? { tail } : {}) };
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
