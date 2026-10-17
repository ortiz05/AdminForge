import type { HumanTask, RunEventInput, RunStatus, StepRecord } from '@adminforge/engine';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client';
import { approvals, runs, runStepEvents, runSteps } from '../db/schema';
import {
  RUN_EVENTS_CHANNEL,
  type EventRow,
  type NewRun,
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

/** Namespace for pg_try_advisory_lock(int, int): one lock per run id. */
const RUN_LOCK_CLASS = 7412;

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

/** jsonb columns reject `undefined`; null them instead. */
const j = (v: unknown) => (v === undefined ? null : v);

export class PgRunRepository implements RunRepository {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
    const res = await this.database.pool.query<{ id: string }>(
      `with recursive tree(id, depth) as (
         select id, 0 from runs where id = $1
         union all
         select r.id, t.depth + 1 from runs r join tree t on r.parent_run_id = t.id where t.depth < 10
       ) select id from tree order by depth`,
      [rootId],
    );
    if (!res.rows.length) return [];
    const ids = res.rows.map((r) => r.id);
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
    return this.db.transaction(async (tx) => {
      const [row] = await tx
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
      const payload = JSON.stringify({ ...notify, eventId: row!.id });
      await tx.execute(sql`select pg_notify(${RUN_EVENTS_CHANNEL}, ${payload})`);
      return toEvent(row!);
    });
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
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`adminforge.task:${runId}|${task.path}`}))`,
      );
      const [existing] = await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.subjectType, 'run'),
            eq(approvals.subjectId, runId),
            eq(approvals.stepId, task.path),
          ),
        )
        .limit(1);
      if (existing) return toTask(existing);
      const [row] = await tx
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
        .returning();
      return toTask(row!);
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
    if (f.kind) conds.push(sql`${approvals.policy}->>'kind' = ${f.kind}`);
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

  async tryLock(runId: string) {
    const client = await this.database.pool.connect();
    try {
      const res = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1, hashtext($2)) as ok', [
        RUN_LOCK_CLASS,
        runId,
      ]);
      if (!res.rows[0]?.ok) {
        client.release();
        return null;
      }
    } catch (err) {
      client.release();
      throw err;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.query('select pg_advisory_unlock($1, hashtext($2))', [RUN_LOCK_CLASS, runId]);
          client.release();
        } catch (err) {
          // Destroy the connection: the lock dies with the session.
          client.release(err as Error);
        }
      },
    };
  }
}
