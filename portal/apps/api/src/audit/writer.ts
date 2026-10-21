import { randomUUID } from 'node:crypto';
import { asc, desc, eq, gt } from 'drizzle-orm';
import { writeTx, yieldToLoop, type Db, type Tx } from '../db/client';
import { auditEvents } from '../db/schema';
import {
  CHAIN_KEYED_ACTION,
  CHAIN_START,
  chainHash,
  cutOverKeyId,
  GENESIS,
  walkChain,
  type ChainGap,
  type ChainPosition,
  type ChainRow,
  type CutOverDetails,
} from './chain';
import type { ChainKey, ChainKeyring } from './keys';

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
      /**
       * The first stretch keyed with a key declared lost (AUDIT_CHAIN_LOST_KEY_IDS, recorded by the cut-over after it):
       * its links were checked, its contents can't be. Where it starts, and the key it names.
       */
      lostKey?: { seq: number; keyId: string };
    }
  | {
      ok: false;
      brokenAt: number;
      seq: number;
      /**
       * Set when the events from `seq` are keyed with a key this process doesn't have (its id) and nothing declared it
       * lost: their links hold, but the walk can't tell whether they changed. Absent: the event at `seq` was changed or
       * removed (or isn't the cut-over AUDIT_CHAIN_KEYED_SINCE pins).
       */
      missingKey?: string;
    };

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

/**
 * A checkpoint from the shipped log against the chain (`adminforge audit verify --checkpoint`): `holds` — the event at
 * its seq still has its hash, and the walk verified everything up to it; `changed` — that event has another hash (the
 * history up to it was rewritten); `missing` — there is no event at that seq (removed, or the chain was cut short);
 * `unverified` — the walk failed before it (the chain's result says why).
 */
export type CheckpointVerdict = 'holds' | 'changed' | 'missing' | 'unverified';

/** Whether the chain is keyed (S-10): Settings, /readyz, `adminforge audit verify`. */
export type ChainState =
  | { keyed: false }
  | {
      keyed: true;
      /** seq of the first keyed event (the first cut-over). */
      since: number;
      /** The key the newest events are keyed with (its id, never the key) and the seq of its cut-over. */
      keyId: string;
      keyIdSince: number;
      /** AUDIT_CHAIN_KEYED_SINCE is set: removing the keyed part fails verification without the shipped log. */
      pinned: boolean;
    };

/** What `prepareChain` found at start, and the cut-over event it appended (a first key, or a new one). */
export interface ChainPrepared {
  state: ChainState;
  /** The tail after it (absent for an empty chain): logged at start, so a tail that moved back shows in the log. */
  tail?: Checkpoint;
  cutOver?: Checkpoint & {
    /** The hash it chains onto: the last unkeyed (or previous key's) event, to match with the checkpoints before. */
    prevHash: string;
    keyId: string;
    /** The key of the part before it (null: it was unkeyed). */
    previousKeyId: string | null;
    /** That key was declared lost (AUDIT_CHAIN_LOST_KEY_IDS): the events it keyed can't be verified any more. */
    previousKeyLost: boolean;
  };
}

/** The audit-chain check walks the whole chain again once its last full walk is this old (D-05: daily). */
export const FULL_VERIFY_EVERY_MS = 86_400_000;

/**
 * Where a verified tail is recorded outside the database (the external anchor): by default one JSON line on stdout —
 * the api container's log, which the cluster's log shipping keeps off the volume. Someone who rewrites the table can
 * re-hash an unkeyed chain, but not the checkpoints already shipped: compare them with
 * `adminforge audit verify --checkpoint <seq>:<hash>`.
 */
export type CheckpointSink = (checkpoint: Checkpoint & { count: number; ts: string }) => void;

export const stdoutCheckpoints: CheckpointSink = (cp) => {
  process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'audit chain checkpoint', ...cp })}\n`);
};

/**
 * Nothing can be chained onto the audit log with this configuration (the newest part is keyed from `seq` with key id
 * `keyId`): no key is configured, the key isn't held, or the configured key is one the log already moved on from. The
 * message is for administrators (configuration keys and key ids, never a key).
 */
export class AuditChainKeyError extends Error {
  readonly code = 'audit_chain_key_missing';
  constructor(
    readonly seq: number,
    readonly keyId: string,
    readonly reason: 'no_key' | 'not_held' | 'retired',
  ) {
    super(
      reason === 'no_key'
        ? `The audit log is keyed from event seq ${seq} (key id ${keyId}), but AUDIT_CHAIN_KEY is not set, so nothing can be added to it. Set AUDIT_CHAIN_KEY to the installation's key (its Secret). If that key is lost, set a new one and put the lost key's id in AUDIT_CHAIN_LOST_KEY_IDS: the events it keyed then can no longer be verified.`
        : reason === 'not_held'
          ? `The audit log is keyed from event seq ${seq} with a key (id ${keyId}) that AUDIT_CHAIN_KEY and AUDIT_CHAIN_PREVIOUS_KEYS don't hold, so nothing can be added to it here. Use the installation's keys (its Secret; in the pod: kubectl exec deploy/adminforge -c api -- adminforge …), with the earlier key in AUDIT_CHAIN_PREVIOUS_KEYS after a rotation. If that key is lost, put its id in AUDIT_CHAIN_LOST_KEY_IDS — but only if an "audit chain cut-over" line in the shipped log names that id at that seq: otherwise the event was forged, so investigate who had write access to the volume instead.`
          : `Since event seq ${seq} the audit log names key id ${keyId}, and AUDIT_CHAIN_KEY is a key it already moved on from. Either this process has an old Secret (use the installation's current key), or that event was forged: compare with the "audit chain cut-over" lines in the shipped log.`,
    );
    this.name = 'AuditChainKeyError';
  }
}

/**
 * AUDIT_CHAIN_KEYED_SINCE pins the first cut-over at `seq`, and the event there isn't one (`missing`: the keyed events
 * were removed, or the cut-over renamed and what follows re-hashed without the key) or doesn't verify (`unverified`: it
 * names a key that isn't configured and wasn't declared lost, or it was changed). The API doesn't start on such a chain.
 */
export class AuditChainPinError extends Error {
  readonly code = 'audit_chain_pin_broken';
  constructor(
    readonly seq: number,
    readonly reason: 'missing' | 'unverified' = 'missing',
    readonly keyId?: string,
  ) {
    super(
      `${
        reason === 'missing'
          ? `The audit log should be keyed from event seq ${seq} (AUDIT_CHAIN_KEYED_SINCE), but that event is not the cut-over that keyed it: the keyed events were removed or rewritten.`
          : `The cut-over AUDIT_CHAIN_KEYED_SINCE pins (event seq ${seq}) doesn't verify: it names key id ${keyId ?? 'unknown'}, which isn't configured (put that key in AUDIT_CHAIN_PREVIOUS_KEYS), or it was changed.`
      } If it was tampered with, don't run AdminForge on this database: snapshot the volume as evidence, restore from a backup and investigate who had write access to it (docs/operations.md → Audit chain checkpoints). A backup from before the key was set needs AUDIT_CHAIN_KEYED_SINCE removed.`,
    );
    this.name = 'AuditChainPinError';
  }
}

export interface AuditWriter {
  append(input: AuditInput): Promise<AuditRow>;
  /** Re-walks the whole chain (the Audit page, `adminforge audit verify`, backups, the daily audit-chain check). */
  verify(): Promise<VerifyResult>;
  /**
   * The hourly probes.audit-chain check: only the events after the last verified checkpoint, or the whole chain when
   * there is none yet or the last full walk is `fullEveryMs` old. Absent: the check calls `verify`.
   */
  verifyIncremental?(fullEveryMs?: number): Promise<ChainCheck>;
  /** Whether the chain is keyed, and since which event (Settings, /readyz). */
  chainState?(): ChainState;
  /**
   * At start (the API's createContext only): with a key configured, appends the cut-over event when the chain's newest
   * part isn't keyed with it (the first key, or a new one). Refuses (throws) a chain it can't extend — keyed without a
   * key configured, keyed with a key that isn't held and not declared lost, or by a key it moved on from — and one
   * whose pinned cut-over (AUDIT_CHAIN_KEYED_SINCE) is gone or doesn't verify.
   */
  prepareChain?(): ChainPrepared;
  /**
   * Throws when an append would (the newest part's key isn't held) or the pinned cut-over is gone: what other processes
   * (the CLI, scheduler one-shots) check before they change anything.
   */
  assertCanAppend?(): void;
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

const chainRowOf = ({ seq: _seq, ...row }: AuditRow): ChainRow => row as unknown as ChainRow;

/** A cut-over: where a keyed part starts, and the key id it names (`unreadable` when it names none). */
interface KeyedPart {
  seq: number;
  keyId: string;
}

const partOf = (row: { seq: number; action: string; details: unknown }): KeyedPart => ({
  seq: row.seq,
  keyId: cutOverKeyId(row) ?? 'unreadable',
});

/** The chain's state from its cut-overs (in seq order). */
function stateOf(cuts: readonly KeyedPart[], keys: ChainKeyring | null): ChainState {
  const first = cuts[0];
  const newest = cuts.at(-1);
  return first && newest
    ? {
        keyed: true,
        since: first.seq,
        keyId: newest.keyId,
        keyIdSince: newest.seq,
        pinned: (keys?.keyedSince ?? null) !== null,
      }
    : { keyed: false };
}

/** The key new events are chained with: none before the first cut-over, else the newest cut-over's (which we must have). */
function partKey(keys: ChainKeyring | null, part: KeyedPart | undefined): ChainKey | null {
  if (!part) return null;
  const key = keys?.get(part.keyId);
  if (!key) throw new AuditChainKeyError(part.seq, part.keyId, keys ? 'not_held' : 'no_key');
  return key;
}

/** An event by seq (the pinned cut-over, the lost part's cut-over). */
type RowAt = (seq: number) => AuditRow | undefined;

/**
 * Throws when the cut-over AUDIT_CHAIN_KEYED_SINCE pins is not there, or doesn't verify with a configured key (one row:
 * it must re-hash onto its own prev hash). A key declared lost can't be checked; the walk reports that stretch.
 */
function assertPinned(keys: ChainKeyring | null, rowAt: RowAt): void {
  const pin = keys?.keyedSince ?? null;
  if (pin === null) return;
  const row = rowAt(pin);
  const id = row && row.action === CHAIN_KEYED_ACTION ? cutOverKeyId(row) : undefined;
  if (!row || !id) throw new AuditChainPinError(pin);
  const key = keys!.get(id);
  if (!key) {
    if (keys!.lost.has(id)) return;
    throw new AuditChainPinError(pin, 'unverified', id);
  }
  const { seq: _seq, prevHash, hash, ...event } = row;
  if (chainHash(prevHash, event, key) !== hash) throw new AuditChainPinError(pin, 'unverified', id);
}

/**
 * What `prepareChain` must append, if anything: the cut-over to the configured key when the newest part isn't keyed
 * with it. Throws for a chain it can't extend (see AuditWriter.prepareChain).
 */
function cutOverFor(
  keys: ChainKeyring | null,
  cuts: readonly KeyedPart[],
  rowAt: RowAt,
  now: Date,
): { event: AuditEvent; key: ChainKey; previousKeyLost: boolean } | null {
  const part = cuts.at(-1);
  if (!keys) {
    if (part) throw new AuditChainKeyError(part.seq, part.keyId, 'no_key');
    return null;
  }
  assertPinned(keys, rowAt);
  if (part?.keyId === keys.current.id) return null;
  // A process started with an old key (a stale environment) must not take the chain back to it.
  if (part && cuts.some((c) => c.keyId === keys.current.id))
    throw new AuditChainKeyError(part.seq, part.keyId, 'retired');
  let previousKeyLost = false;
  let previousKeyFrom: string | undefined;
  if (part && !keys.get(part.keyId)) {
    if (!keys.lost.has(part.keyId)) throw new AuditChainKeyError(part.seq, part.keyId, 'not_held');
    previousKeyLost = true;
    // The declaration names the stretch it covers by where it starts: no other stretch can borrow it.
    previousKeyFrom = rowAt(part.seq)!.prevHash;
  }
  const details: CutOverDetails = {
    keyId: keys.current.id,
    previousKeyId: part?.keyId ?? null,
    ...(previousKeyLost ? { previousKeyLost: true as const, previousKeyFrom: previousKeyFrom! } : {}),
  };
  return {
    key: keys.current,
    previousKeyLost,
    event: toAuditEvent(
      {
        actorOid: 'system',
        actorUpn: 'AdminForge',
        action: CHAIN_KEYED_ACTION,
        targetType: 'audit',
        targetId: 'chain',
        result: 'success',
        correlationId: randomUUID(),
        details: { ...details },
      },
      now,
    ),
  };
}

const cutOverOf = (
  row: AuditRow,
  keyId: string,
  part: KeyedPart | undefined,
  previousKeyLost: boolean,
): NonNullable<ChainPrepared['cutOver']> => ({
  seq: row.seq,
  hash: row.hash,
  prevHash: row.prevHash,
  keyId,
  previousKeyId: part?.keyId ?? null,
  previousKeyLost,
});

/**
 * Where the pinned cut-over (AUDIT_CHAIN_KEYED_SINCE) breaks among `rows` (an index), or undefined when they don't
 * reach its seq or it is there. Rows past the pin without it there (removed, renumbered) break at the first of them.
 */
function pinBreak(rows: readonly AuditRow[], pin: number): { index?: number; seen: boolean } {
  const i = rows.findIndex((r) => r.seq >= pin);
  if (i < 0) return { seen: false };
  const r = rows[i]!;
  return r.seq === pin && r.action === CHAIN_KEYED_ACTION ? { seen: true } : { index: i, seen: true };
}

/** Rows per round trip when walking the chain: memory stays flat however long the audit log grows. */
export const VERIFY_BATCH = 2_000;

/**
 * A verified point to continue from: the tail's seq and hash, the key id of its part, the key ids already used and the
 * chain's length up to it.
 */
type Verified = Checkpoint & { count: number; keyId: string | null; used: readonly string[] };

const rowOf = (r: typeof auditEvents.$inferSelect): AuditRow => ({
  ...r,
  ts: r.ts.toISOString(),
  details: (r.details as Record<string, unknown> | null) ?? null,
});

/** Every cut-over, in seq order: a handful (one per key), found through `audit_action_idx`. */
const cutOversIn = (q: Db | Tx): KeyedPart[] =>
  q
    .select({ seq: auditEvents.seq, action: auditEvents.action, details: auditEvents.details })
    .from(auditEvents)
    .where(eq(auditEvents.action, CHAIN_KEYED_ACTION))
    .orderBy(asc(auditEvents.seq))
    .all()
    .map(partOf);

/** The newest cut-over only (appends: one index lookup). */
const newestCutOver = (q: Db | Tx): KeyedPart | undefined => {
  const row = q
    .select({ seq: auditEvents.seq, action: auditEvents.action, details: auditEvents.details })
    .from(auditEvents)
    .where(eq(auditEvents.action, CHAIN_KEYED_ACTION))
    .orderBy(desc(auditEvents.seq))
    .limit(1)
    .get();
  return row ? partOf(row) : undefined;
};

/** One event by seq. */
const rowAtIn = (q: Db | Tx, seq: number): AuditRow | undefined => {
  const row = q.select().from(auditEvents).where(eq(auditEvents.seq, seq)).get();
  return row ? rowOf(row) : undefined;
};

const tailOf = (q: Db | Tx) =>
  q
    .select({ seq: auditEvents.seq, hash: auditEvents.hash })
    .from(auditEvents)
    .orderBy(desc(auditEvents.seq))
    .limit(1)
    .get();

export class SqliteAuditWriter implements AuditWriter {
  /**
   * The last verified tail and when the whole chain was last walked, in this process's memory (D-05). Lost at a
   * restart, so the first check after one walks the whole chain; the checkpoints shipped to the log stay the anchor.
   */
  private verified: Verified | null = null;
  private fullAt: number | null = null;
  /** Bumped on every break found: a walk that started before it can't save its checkpoint afterwards. */
  private generation = 0;

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
    private readonly checkpoints: CheckpointSink | null = stdoutCheckpoints,
    private readonly batch = VERIFY_BATCH,
    /** AUDIT_CHAIN_KEY and its options (S-10); null: none configured, the chain must be unkeyed to extend it. */
    private readonly keys: ChainKeyring | null = null,
  ) {}

  async append(input: AuditInput): Promise<AuditRow> {
    const event = toAuditEvent(input, this.now());
    // BEGIN IMMEDIATE takes the write lock before reading the tail and the newest cut-over, so every appender — in this
    // process or another (the CLI) — chains onto the true tail with the key of the chain's newest part.
    return writeTx(this.db, (tx) => this.chainOnto(tx, event, partKey(this.keys, newestCutOver(tx))));
  }

  /**
   * Throws AuditChainKeyError when an append would, AuditChainPinError when the pinned cut-over is gone: a command checks
   * this before it changes anything, so the change isn't made without its audit event.
   */
  assertCanAppend(): void {
    partKey(this.keys, newestCutOver(this.db));
    assertPinned(this.keys, (seq) => rowAtIn(this.db, seq));
  }

  prepareChain(): ChainPrepared {
    return writeTx(this.db, (tx) => {
      const cuts = cutOversIn(tx);
      const cut = cutOverFor(this.keys, cuts, (seq) => rowAtIn(tx, seq), this.now());
      const row = cut ? this.chainOnto(tx, cut.event, cut.key) : null;
      const tail = tailOf(tx);
      return {
        state: stateOf(row ? [...cuts, partOf(row)] : cuts, this.keys),
        ...(tail ? { tail } : {}),
        ...(row && cut ? { cutOver: cutOverOf(row, cut.key.id, cuts.at(-1), cut.previousKeyLost) } : {}),
      };
    });
  }

  chainState(): ChainState {
    return stateOf(cutOversIn(this.db), this.keys);
  }

  /** Inserts one event after the tail, hashed with `key` (null: SHA-256). Inside a write transaction. */
  private chainOnto(tx: Tx, event: AuditEvent, key: ChainKey | null): AuditRow {
    const prevHash = tailOf(tx)?.hash ?? GENESIS;
    const hash = chainHash(prevHash, { ...event }, key);
    const row = tx
      .insert(auditEvents)
      .values({ ...event, ts: new Date(event.ts), prevHash, hash })
      .returning({ seq: auditEvents.seq })
      .get();
    return { ...event, seq: row.seq, prevHash, hash };
  }

  /** Walks the whole chain in seq order, `batch` rows at a time (keyset paging), then records the verified tail. */
  async verify(): Promise<VerifyResult> {
    const { checked: _checked, ...r } = await this.fullWalk();
    return r;
  }

  /**
   * The whole chain, then a checkpoint copied from the shipped log (`adminforge audit verify --checkpoint`): the event
   * at its seq must still be there with its hash. Re-hashing an unkeyed chain after a rewrite makes the walk pass, but
   * it can't give the rewritten event the hash the log already holds.
   */
  async verifyCheckpoint(cp: Checkpoint): Promise<{ chain: VerifyResult; checkpoint: CheckpointVerdict }> {
    const chain = await this.verify();
    if (!chain.ok && chain.seq <= cp.seq) return { chain, checkpoint: 'unverified' };
    const row = this.db
      .select({ hash: auditEvents.hash })
      .from(auditEvents)
      .where(eq(auditEvents.seq, cp.seq))
      .get();
    return { chain, checkpoint: !row ? 'missing' : row.hash === cp.hash ? 'holds' : 'changed' };
  }

  async verifyIncremental(fullEveryMs = FULL_VERIFY_EVERY_MS): Promise<ChainCheck> {
    const from = this.verified;
    if (!from || this.fullAt === null || this.now().getTime() - this.fullAt >= fullEveryMs)
      return { ...(await this.fullWalk()), scope: 'full' };
    // The checkpoint event must still be there, unchanged: removing or rewriting the tail can't hide behind it.
    if (!this.holds(from)) {
      this.broken();
      return { ok: false, brokenAt: from.count - 1, seq: from.seq, scope: 'incremental', checked: 1 };
    }
    return { ...(await this.walk(from)), scope: 'incremental' };
  }

  /** Whether the event at a verified checkpoint is still there with the same hash, and still re-hashes to it. */
  private holds(cp: Verified): boolean {
    if (cp.seq === 0) return true;
    const row = rowAtIn(this.db, cp.seq);
    if (!row || row.hash !== cp.hash) return false;
    // Its part's key: a cut-over names its own, any other event is in the part the checkpoint was verified in.
    const keyId = row.action === CHAIN_KEYED_ACTION ? (cutOverKeyId(row) ?? null) : cp.keyId;
    const key = keyId ? this.keys?.get(keyId) : null;
    if (keyId && !key) return false;
    const { seq: _seq, prevHash, hash, ...event } = row;
    return chainHash(prevHash, event, key) === hash;
  }

  /**
   * The whole chain, and then the checkpoint this process verified before: a chain rewritten from the start re-hashes
   * cleanly, but not onto the hash already verified at that seq (the shipped checkpoints anchor the same across a
   * restart).
   */
  private async fullWalk(): Promise<VerifyResult & { checked: number }> {
    const before = this.verified;
    const r = await this.walk(null);
    if (r.ok && before && !this.holds(before)) {
      this.broken();
      return { ok: false, brokenAt: before.count - 1, seq: before.seq, checked: r.checked };
    }
    return r;
  }

  /** A break was found: trust no checkpoint, and walk the whole chain until a walk succeeds again. */
  private broken() {
    this.generation++;
    this.verified = null;
    this.fullAt = null;
  }

  /**
   * Re-hashes the events after `from` (the whole chain when null), `batch` rows per round trip with the event loop let
   * in between, ships the verified tail as a checkpoint and remembers it for the next incremental check. A stretch it
   * has no key for is checked for links and carried on past; the result says where it is (`missingKey`, not ok) —
   * unless the cut-over after it declared that key lost (`lostKey`, ok). The pinned cut-over must be where it is pinned.
   */
  private async walk(from: Verified | null): Promise<VerifyResult & { checked: number }> {
    const generation = this.generation;
    const pin = this.keys?.keyedSince ?? null;
    let at: ChainPosition = from ? { hash: from.hash, keyId: from.keyId, used: from.used } : CHAIN_START;
    let after = from?.seq ?? 0;
    let count = from?.count ?? 0;
    let checked = 0;
    let tail: Checkpoint | undefined = from && from.seq > 0 ? { seq: from.seq, hash: from.hash } : undefined;
    let pinSeen = pin === null || after >= pin;
    let missing: (ChainGap & { seq: number }) | undefined;
    let lost: (ChainGap & { seq: number }) | undefined;
    /** The seq of the open stretch's first event, when that stretch began in an earlier batch. */
    let gapSeq = 0;
    for (;;) {
      const rows = this.db
        .select()
        .from(auditEvents)
        .where(gt(auditEvents.seq, after))
        .orderBy(asc(auditEvents.seq))
        .limit(this.batch)
        .all()
        .map(rowOf);
      if (!rows.length) break;
      const seqAt = (index: number) => (index >= count ? rows[index - count]!.seq : gapSeq);
      const pinned = pinSeen ? { seen: true } : pinBreak(rows, pin!);
      pinSeen = pinned.seen;
      const res = walkChain(rows.map(chainRowOf), at, this.keys, count);
      const brokenAt = Math.min(
        res.brokenAt ?? Infinity,
        pinned.index !== undefined ? count + pinned.index : Infinity,
      );
      if (brokenAt !== Infinity) {
        this.broken();
        return { ok: false, brokenAt, seq: seqAt(brokenAt), checked: checked + brokenAt - count + 1 };
      }
      if (res.missing) missing ??= { ...res.missing, seq: seqAt(res.missing.index) };
      if (res.lost) lost ??= { ...res.lost, seq: seqAt(res.lost.index) };
      if (res.position.gap) gapSeq = seqAt(res.position.gap.index);
      count += rows.length;
      checked += rows.length;
      at = res.position;
      const last = rows.at(-1)!;
      tail = { seq: last.seq, hash: last.hash };
      after = last.seq;
      if (rows.length < this.batch) break;
      await yieldToLoop();
    }
    // The chain ends before the cut-over it pins: the keyed part was cut off.
    if (!pinSeen) {
      this.broken();
      return { ok: false, brokenAt: count, seq: pin!, checked };
    }
    const unverified = missing ?? (at.gap ? { ...at.gap, seq: gapSeq } : undefined);
    if (unverified) {
      this.broken();
      return {
        ok: false,
        brokenAt: unverified.index,
        seq: unverified.seq,
        missingKey: unverified.keyId,
        checked,
      };
    }
    if (tail) this.checkpoints?.({ ...tail, count, ts: this.now().toISOString() });
    // Another walk found a break meanwhile: this one's checkpoint must not paper over it.
    if (generation === this.generation) {
      this.verified = { seq: tail?.seq ?? 0, hash: at.hash, count, keyId: at.keyId, used: at.used ?? [] };
      if (!from) this.fullAt = this.now().getTime();
    }
    return {
      ok: true,
      count,
      checked,
      ...(tail ? { tail } : {}),
      ...(lost ? { lostKey: { seq: lost.seq, keyId: lost.keyId } } : {}),
    };
  }
}

/** In-memory chain for tests and DB-less mock mode. */
export class MemoryAuditWriter implements AuditWriter {
  readonly rows: AuditRow[] = [];
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly keys: ChainKeyring | null = null,
  ) {}

  async append(input: AuditInput): Promise<AuditRow> {
    const event = toAuditEvent(input, this.now());
    return structuredClone(this.chainOnto(event, partKey(this.keys, this.cutOvers().at(-1))));
  }

  assertCanAppend(): void {
    partKey(this.keys, this.cutOvers().at(-1));
    assertPinned(this.keys, (seq) => this.rows.find((r) => r.seq === seq));
  }

  prepareChain(): ChainPrepared {
    const cuts = this.cutOvers();
    const cut = cutOverFor(this.keys, cuts, (seq) => this.rows.find((r) => r.seq === seq), this.now());
    const row = cut ? this.chainOnto(cut.event, cut.key) : null;
    const last = this.rows.at(-1);
    return {
      state: this.chainState(),
      ...(last ? { tail: { seq: last.seq, hash: last.hash } } : {}),
      ...(row && cut ? { cutOver: cutOverOf(row, cut.key.id, cuts.at(-1), cut.previousKeyLost) } : {}),
    };
  }

  chainState(): ChainState {
    return stateOf(this.cutOvers(), this.keys);
  }

  async verify(): Promise<VerifyResult> {
    const rows = this.rows;
    const pin = this.keys?.keyedSince ?? null;
    const res = walkChain(rows.map(chainRowOf), CHAIN_START, this.keys);
    const pinned = pin === null ? { seen: true } : pinBreak(rows, pin);
    const brokenAt = Math.min(res.brokenAt ?? Infinity, pinned.index ?? Infinity);
    if (brokenAt !== Infinity) return { ok: false, brokenAt, seq: rows[brokenAt]!.seq };
    if (!pinned.seen) return { ok: false, brokenAt: rows.length, seq: pin! };
    const gap = res.missing ?? res.position.gap;
    if (gap) return { ok: false, brokenAt: gap.index, seq: rows[gap.index]!.seq, missingKey: gap.keyId };
    const last = rows.at(-1);
    return {
      ok: true,
      count: rows.length,
      ...(last ? { tail: { seq: last.seq, hash: last.hash } } : {}),
      ...(res.lost ? { lostKey: { seq: rows[res.lost.index]!.seq, keyId: res.lost.keyId } } : {}),
    };
  }

  private cutOvers(): KeyedPart[] {
    return this.rows.filter((r) => r.action === CHAIN_KEYED_ACTION).map(partOf);
  }

  private chainOnto(event: AuditEvent, key: ChainKey | null): AuditRow {
    const prevHash = this.rows.at(-1)?.hash ?? GENESIS;
    const row: AuditRow = {
      ...event,
      seq: this.rows.length + 1,
      prevHash,
      hash: chainHash(prevHash, { ...event }, key),
    };
    this.rows.push(row);
    return row;
  }
}
