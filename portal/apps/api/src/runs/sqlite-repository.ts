import type { HumanTask, RunEventInput, RunStatus, StepRecord } from '@adminforge/engine';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { withTx } from '../auth/session-store';
import { writeTx, type Database, type Tx } from '../db/client';
import { Leases } from '../db/leases';
import { approvals, runs, runStepEvents, runSteps } from '../db/schema';
import {
  RUN_STATUS_ACTIVE,
  RUN_STATUS_OPEN,
  type EventRow,
  type NewRun,
  type OpenRunInsert,
  type RunFilter,
  type RunNotification,
  type RunRepository,
  type RunRow,
  type RunRowPatch,
  type TaskFilter,
  type TaskPolicy,
  type TaskRow,
  type TaskStatus,
} from './types';

type RunsRow = typeof runs.$inferSelect;
type StepsRow = typeof runSteps.$inferSelect;
type EventsRow = typeof runStepEvents.$inferSelect;
type ApprovalsRow = typeof approvals.$inferSelect;

/** A run's lock is a lease (`run:<id>`), renewed while its holder drives the run; a dead process's lease expires. */
const RUN_LOCK_TTL_MS = 120_000;
const RUN_LOCK_RENEW_MS = 30_000;

const toRun = (r: RunsRow): RunRow => ({
  id: r.id,
  kind: r.kind as RunRow['kind'],
  definitionKey: r.definitionKey,
  definitionVersion: r.definitionVersion,
  definitionSha256: r.definitionSha256,
  status: r.status as RunStatus,
  dryRun: r.dryRun,
  trigger: r.trigger as RunRow['trigger'],
  identity: r.identity as RunRow['identity'],
  identityName: r.identityName ?? null,
  initiatorOid: r.initiatorOid,
  initiatorUpn: r.initiatorUpn,
  sessionHash: r.sessionHash,
  scheduleId: r.scheduleId,
  parentRunId: r.parentRunId,
  inputs: (r.inputs ?? {}) as Record<string, unknown>,
  outputs: (r.outputs ?? null) as RunRow['outputs'],
  error: (r.error ?? null) as RunRow['error'],
  correlationId: r.correlationId,
  createdAt: r.createdAt,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
  updatedAt: r.updatedAt,
});

const toStep = (r: StepsRow): StepRecord => ({
  seq: r.seq,
  stepId: r.stepId,
  path: r.path,
  type: r.type,
  attempt: r.attempt,
  status: r.status as StepRecord['status'],
  actorOid: r.actorOid,
  mode: r.mode as StepRecord['mode'],
  request: r.request ?? null,
  plan: (r.plan ?? null) as StepRecord['plan'],
  output: r.output ?? null,
  error: (r.error ?? null) as StepRecord['error'],
  msRequestId: r.msRequestId,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
});

const toEvent = (r: EventsRow): EventRow => ({
  id: r.id,
  runId: r.runId,
  stepSeq: r.stepSeq,
  ts: r.ts,
  type: r.type as EventRow['type'],
  level: (r.level ?? null) as EventRow['level'],
  data: (r.data ?? {}) as Record<string, unknown>,
});

const toTask = (r: ApprovalsRow): TaskRow => ({
  id: r.id,
  subjectType: r.subjectType as TaskRow['subjectType'],
  subjectId: r.subjectId,
  stepId: r.stepId,
  policy: r.policy as TaskPolicy,
  decisions: (r.decisions ?? []) as TaskRow['decisions'],
  status: r.status as TaskStatus,
  requestedBy: r.requestedBy,
  expiresAt: r.expiresAt,
  createdAt: r.createdAt,
  decidedAt: r.decidedAt,
});

/** F-08: a person's open runs — root runs they started themselves that are queued or running. */
const openRunsOf = (initiatorOid: string | null) =>
  and(
    initiatorOid === null ? isNull(runs.initiatorOid) : eq(runs.initiatorOid, initiatorOid),
    isNull(runs.parentRunId),
    eq(runs.identity, 'delegated'),
    inArray(runs.status, [...RUN_STATUS_OPEN]),
  );

/** JSON columns can't store `undefined`; null them instead. */
const j = (v: unknown) => (v === undefined ? null : v);

export class SqliteRunRepository implements RunRepository {
  /** Called after an event is recorded (runs/module.ts: the run event bus and the browsers' event stream). */
  onNotify: ((n: RunNotification) => void) | null = null;
  private readonly leases: Leases;
  private readonly lockTtlMs: number;
  private readonly lockRenewMs: number;

  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
    /** The run lock's lease and how often its holder renews it (tests shorten both). */
    opts: { lockTtlMs?: number; lockRenewMs?: number } = {},
  ) {
    this.leases = new Leases(database.sqlite, () => this.now().getTime());
    this.lockTtlMs = opts.lockTtlMs ?? RUN_LOCK_TTL_MS;
    this.lockRenewMs = opts.lockRenewMs ?? RUN_LOCK_RENEW_MS;
  }

  private get db() {
    return this.database.db;
  }

  private values(run: NewRun) {
    return {
      id: run.id,
      kind: run.kind,
      definitionKey: run.definitionKey,
      definitionVersion: run.definitionVersion,
      definitionSha256: run.definitionSha256,
      status: run.status ?? 'queued',
      dryRun: run.dryRun,
      trigger: run.trigger,
      identity: run.identity,
      // ADR-014: the app identity a scheduled run (and its children) executes as.
      identityName: run.identityName ?? null,
      initiatorOid: run.initiatorOid,
      initiatorUpn: run.initiatorUpn,
      sessionHash: run.sessionHash,
      scheduleId: run.scheduleId,
      parentRunId: run.parentRunId,
      inputs: run.inputs,
      correlationId: run.correlationId,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
  }

  async insertRun(run: NewRun): Promise<RunRow> {
    const [row] = await this.db.insert(runs).values(this.values(run)).returning();
    return toRun(row!);
  }

  async insertRunIfAbsent(run: NewRun): Promise<RunRow> {
    const [row] = await this.db
      .insert(runs)
      .values(this.values(run))
      .onConflictDoNothing({ target: runs.id })
      .returning();
    if (row) return toRun(row);
    return (await this.getRun(run.id))!;
  }

  async insertOpenRun(run: NewRun, limit: { max: number; ifAbsent?: boolean }): Promise<OpenRunInsert> {
    // BEGIN IMMEDIATE: one start at a time (any process), so the count below stays true until the insert commits.
    return writeTx(this.db, (tx): OpenRunInsert => {
      if (limit.ifAbsent) {
        const existing = tx.select().from(runs).where(eq(runs.id, run.id)).limit(1).get();
        if (existing) return { ok: true, row: toRun(existing) };
      }
      const c = tx
        .select({ open: sql<number>`count(*)` })
        .from(runs)
        .where(openRunsOf(run.initiatorOid))
        .get();
      const open = Number(c?.open ?? 0);
      if (open >= limit.max) return { ok: false, open };
      return { ok: true, row: toRun(tx.insert(runs).values(this.values(run)).returning().get()) };
    });
  }

  async countOpenRuns(initiatorOid: string): Promise<number> {
    const [c] = await this.db
      .select({ open: sql<number>`count(*)` })
      .from(runs)
      .where(openRunsOf(initiatorOid));
    return Number(c?.open ?? 0);
  }

  async getRun(id: string): Promise<RunRow | null> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1);
    return row ? toRun(row) : null;
  }

  async updateRun(id: string, patch: RunRowPatch, expect?: readonly RunStatus[]): Promise<RunRow | null> {
    const set: Record<string, unknown> = { updatedAt: this.now() };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v;
    if ('outputs' in patch) set.outputs = j(patch.outputs);
    if ('error' in patch) set.error = j(patch.error);
    const where = expect ? and(eq(runs.id, id), inArray(runs.status, [...expect])) : eq(runs.id, id);
    const [row] = await this.db.update(runs).set(set).where(where).returning();
    return row ? toRun(row) : null;
  }

  async listRuns(f: RunFilter): Promise<RunRow[]> {
    const conds: SQL[] = [];
    if (f.initiatorOid) conds.push(eq(runs.initiatorOid, f.initiatorOid));
    if (f.statuses?.length) conds.push(inArray(runs.status, f.statuses));
    if (f.definitionKey) conds.push(eq(runs.definitionKey, f.definitionKey));
    if (f.parentRunId !== undefined) conds.push(eq(runs.parentRunId, f.parentRunId));
    if (f.topLevel ?? f.parentRunId === undefined) conds.push(isNull(runs.parentRunId));
    if (f.from) conds.push(gte(runs.createdAt, f.from));
    if (f.to) conds.push(lte(runs.createdAt, f.to));
    if (f.cursor)
      conds.push(
        or(
          lt(runs.createdAt, f.cursor.createdAt),
          and(eq(runs.createdAt, f.cursor.createdAt), lt(runs.id, f.cursor.id)),
        )!,
      );
    const rows = await this.db
      .select()
      .from(runs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(f.limit);
    return rows.map(toRun);
  }

  async runTree(rootId: string): Promise<RunRow[]> {
    const tree = this.db.all<{ id: string }>(sql`
      with recursive tree(id, depth) as (
        select id, 0 from runs where id = ${rootId}
        union all
        select r.id, t.depth + 1 from runs r join tree t on r.parent_run_id = t.id where t.depth < 10
      ) select id from tree order by depth`);
    if (!tree.length) return [];
    const ids = tree.map((r) => r.id);
    const rows = await this.db.select().from(runs).where(inArray(runs.id, ids));
    const byId = new Map(rows.map((r) => [r.id, toRun(r)]));
    return ids.map((id) => byId.get(id)!).filter(Boolean);
  }

  async staleRuns(statuses: readonly RunStatus[], before: Date, limit: number): Promise<RunRow[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(and(inArray(runs.status, [...statuses]), lt(runs.updatedAt, before)))
      .orderBy(asc(runs.updatedAt))
      .limit(limit);
    return rows.map(toRun);
  }

  async saveStep(runId: string, r: StepRecord): Promise<void> {
    const row = {
      runId,
      seq: r.seq,
      stepId: r.stepId,
      path: r.path,
      type: r.type,
      attempt: r.attempt,
      status: r.status,
      actorOid: r.actorOid,
      mode: r.mode,
      request: j(r.request),
      plan: j(r.plan),
      output: j(r.output),
      error: j(r.error),
      msRequestId: r.msRequestId,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    };
    const { runId: _r, seq: _s, ...update } = row;
    await this.db
      .insert(runSteps)
      .values(row)
      .onConflictDoUpdate({ target: [runSteps.runId, runSteps.seq], set: update });
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    const rows = await this.db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, runId))
      .orderBy(asc(runSteps.seq));
    return rows.map(toStep);
  }

  async appendEvent(runId: string, event: RunEventInput, notify: RunNotification): Promise<EventRow> {
    const [row] = await this.db
      .insert(runStepEvents)
      .values({
        runId,
        stepSeq: event.stepSeq ?? null,
        ts: this.now(),
        type: event.type,
        level: event.level ?? null,
        data: event.data,
      })
      .returning();
    this.onNotify?.({ ...notify, eventId: row!.id });
    return toEvent(row!);
  }

  async listEvents(runId: string, afterId: number, limit: number): Promise<EventRow[]> {
    const rows = await this.db
      .select()
      .from(runStepEvents)
      .where(and(eq(runStepEvents.runId, runId), gt(runStepEvents.id, afterId)))
      .orderBy(asc(runStepEvents.id))
      .limit(limit);
    return rows.map(toEvent);
  }

  async upsertTask(runId: string, task: HumanTask, policy: TaskPolicy): Promise<TaskRow> {
    // BEGIN IMMEDIATE: the lookup and the insert happen under the write lock, so one task row per (run, path).
    return writeTx(this.db, (tx) => {
      const existing = tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.subjectType, 'run'),
            eq(approvals.subjectId, runId),
            eq(approvals.stepId, task.path),
          ),
        )
        .limit(1)
        .get();
      if (existing) return toTask(existing);
      const row = tx
        .insert(approvals)
        .values({
          subjectType: 'run',
          subjectId: runId,
          stepId: task.path,
          policy,
          decisions: [],
          status: 'pending',
          requestedBy: task.requestedBy.oid ?? 'automation',
          expiresAt: task.kind === 'approval' && task.expiresAt ? new Date(task.expiresAt) : null,
          createdAt: this.now(),
        })
        .returning()
        .get();
      return toTask(row);
    });
  }

  async getTask(runId: string, path: string): Promise<TaskRow | null> {
    const [row] = await this.db
      .select()
      .from(approvals)
      .where(
        and(eq(approvals.subjectType, 'run'), eq(approvals.subjectId, runId), eq(approvals.stepId, path)),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(1);
    return row ? toTask(row) : null;
  }

  async getTaskById(id: string): Promise<TaskRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await this.db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
    return row ? toTask(row) : null;
  }

  async updateTask(
    id: string,
    patch: Partial<Pick<TaskRow, 'decisions' | 'status' | 'decidedAt'>>,
    expect?: TaskStatus,
  ): Promise<TaskRow | null> {
    const where = expect ? and(eq(approvals.id, id), eq(approvals.status, expect)) : eq(approvals.id, id);
    const [row] = await this.db.update(approvals).set(patch).where(where).returning();
    return row ? toTask(row) : null;
  }

  async listTasks(f: TaskFilter): Promise<TaskRow[]> {
    const conds: SQL[] = [eq(approvals.subjectType, 'run')];
    if (f.status) conds.push(eq(approvals.status, f.status));
    if (f.kind) conds.push(sql`${approvals.policy} ->> 'kind' = ${f.kind}`);
    if (f.runId) conds.push(eq(approvals.subjectId, f.runId));
    if (f.runIds) {
      if (!f.runIds.length) return [];
      conds.push(inArray(approvals.subjectId, f.runIds));
    }
    const rows = await this.db
      .select()
      .from(approvals)
      .where(and(...conds))
      .orderBy(asc(approvals.createdAt))
      .limit(500);
    return rows.map(toTask);
  }

  moveSessionTx(from: string, to: string, tx: Tx | null): void {
    withTx(this.db, tx, (t) => {
      // By status first (runs_status_idx): only unfinished runs act again, and the table keeps months of history.
      const unfinished = inArray(runs.status, RUN_STATUS_ACTIVE);
      t.update(runs)
        .set({ sessionHash: to })
        .where(and(unfinished, eq(runs.sessionHash, from)))
        .run();
      const tasks = t
        .select({ id: approvals.id, decisions: approvals.decisions })
        .from(approvals)
        .where(
          and(
            eq(approvals.subjectType, 'run'),
            inArray(approvals.subjectId, t.select({ id: runs.id }).from(runs).where(unfinished)),
            sql`instr(${approvals.decisions}, ${from}) > 0`,
          ),
        )
        .all();
      for (const task of tasks) {
        const decisions = (task.decisions ?? []) as TaskRow['decisions'];
        if (!decisions.some((d) => d.sessionHash === from)) continue;
        t.update(approvals)
          .set({ decisions: decisions.map((d) => (d.sessionHash === from ? { ...d, sessionHash: to } : d)) })
          .where(eq(approvals.id, task.id))
          .run();
      }
    });
  }

  async tryLock(runId: string) {
    const name = `run:${runId}`;
    const holder = `${this.database.signals.origin}:${randomUUID()}`;
    if (!this.leases.tryAcquire(name, holder, this.lockTtlMs)) return null;
    const lost = new AbortController();
    const renew = setInterval(() => {
      try {
        if (this.leases.renew(name, holder, this.lockTtlMs)) return;
        // Expired, maybe taken over (this process stalled for longer than the TTL): stop driving the run. The worker
        // interrupts it (never cancels it) and tries again shortly.
        clearInterval(renew);
        lost.abort(new Error('The run lock lapsed; another worker may have taken the run over.'));
      } catch {
        // A busy database: the next renewal (well before the TTL) tries again.
      }
    }, this.lockRenewMs);
    renew.unref();
    let released = false;
    return {
      lost: lost.signal,
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(renew);
        this.leases.release(name, holder);
      },
    };
  }
}
