import type { Schedule } from '@adminforge/schemas';
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { writeTx, type Db } from '../db/client';
import { approvals, probeResults, scheduleRuns, schedules } from '../db/schema';
import type { ScheduleStore } from './store';
import type {
  ApprovalStatus,
  NewProbeResult,
  NewSchedule,
  NewScheduleApproval,
  NewScheduleRun,
  PortalInsertResult,
  PortalScheduleCaps,
  ProbeResultRow,
  RunCursor,
  ScheduleApprovalPatch,
  ScheduleApprovalRow,
  SchedulePatch,
  ScheduleRow,
  ScheduleRunPatch,
  ScheduleRunRow,
  ScheduleRunStatus,
} from './types';

type SchedulesRow = typeof schedules.$inferSelect;
type RunsRow = typeof scheduleRuns.$inferSelect;
type ProbeRow = typeof probeResults.$inferSelect;
type ApprovalsRow = typeof approvals.$inferSelect;

const toSchedule = (r: SchedulesRow): ScheduleRow => ({
  id: r.id,
  key: r.key,
  source: r.source as ScheduleRow['source'],
  definition: r.definition as Schedule,
  sha256: r.sha256,
  enabled: r.enabled,
  createdBy: r.createdBy,
  approvedBy: r.approvedBy,
  approvedTarget: r.approvedTarget,
  nextRunAt: r.nextRunAt,
  lastRunAt: r.lastRunAt,
  lastStatus: r.lastStatus,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toRun = (r: RunsRow): ScheduleRunRow => ({
  id: r.id,
  scheduleId: r.scheduleId,
  scheduleKey: r.scheduleKey,
  trigger: r.trigger as ScheduleRunRow['trigger'],
  status: r.status as ScheduleRunStatus,
  runId: r.runId,
  result: (r.result ?? null) as ScheduleRunRow['result'],
  error: (r.error ?? null) as ScheduleRunRow['error'],
  artifactPath: r.artifactPath,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
});

const toProbe = (
  r: Pick<
    ProbeRow,
    'id' | 'probeKey' | 'ts' | 'status' | 'metric' | 'durationMs' | 'message' | 'scheduleRunId'
  > & { details?: unknown },
): ProbeResultRow => ({
  id: r.id,
  probeKey: r.probeKey,
  ts: r.ts,
  status: r.status as ProbeResultRow['status'],
  metric: r.metric,
  durationMs: r.durationMs,
  message: r.message,
  details: r.details ?? null,
  scheduleRunId: r.scheduleRunId,
});

const toApproval = (r: ApprovalsRow): ScheduleApprovalRow => ({
  id: r.id,
  subjectType: 'schedule',
  subjectId: r.subjectId,
  policy: r.policy as ScheduleApprovalRow['policy'],
  decisions: (r.decisions ?? []) as ScheduleApprovalRow['decisions'],
  status: r.status as ApprovalStatus,
  requestedBy: r.requestedBy,
  expiresAt: r.expiresAt,
  createdAt: r.createdAt,
  decidedAt: r.decidedAt,
});

/** SQLite store over `schedules`, `schedule_runs`, `probe_results` and `approvals` (subject_type = 'schedule'). */
export class SqliteScheduleStore implements ScheduleStore {
  constructor(private readonly db: Db) {}

  async listSchedules() {
    return (await this.db.select().from(schedules).orderBy(asc(schedules.key))).map(toSchedule);
  }
  async getSchedule(key: string) {
    const [r] = await this.db.select().from(schedules).where(eq(schedules.key, key)).limit(1);
    return r ? toSchedule(r) : null;
  }
  async getScheduleById(id: string) {
    const [r] = await this.db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
    return r ? toSchedule(r) : null;
  }
  async insertSchedule(row: NewSchedule) {
    const [r] = await this.db
      .insert(schedules)
      .values({
        ...row,
        createdBy: row.createdBy ?? null,
        approvedBy: row.approvedBy ?? null,
        approvedTarget: row.approvedTarget ?? null,
      })
      .onConflictDoNothing({ target: schedules.key })
      .returning();
    return r ? toSchedule(r) : null;
  }
  async insertPortalSchedule(
    row: NewSchedule & { createdBy: string },
    caps: PortalScheduleCaps,
  ): Promise<PortalInsertResult> {
    // BEGIN IMMEDIATE: one creator at a time (any process), so the counts below stay true until the insert commits.
    return writeTx(this.db, (tx) => {
      const active = sql`coalesce(${schedules.definition} ->> 'status', 'active') <> 'retired'`;
      const c = tx
        .select({
          total: sql<number>`count(*) filter (where ${active})`,
          mine: sql<number>`count(*) filter (where ${active} and ${schedules.createdBy} = ${row.createdBy})`,
          recent: sql<number>`count(*) filter (where ${schedules.createdBy} = ${row.createdBy} and ${schedules.createdAt} >= ${caps.since.getTime()})`,
        })
        .from(schedules)
        .where(eq(schedules.source, 'portal'))
        .get();
      if (Number(c?.total ?? 0) >= caps.total) return { ok: false, reason: 'total' } as const;
      if (Number(c?.mine ?? 0) >= caps.perCreator) return { ok: false, reason: 'perCreator' } as const;
      if (Number(c?.recent ?? 0) >= caps.recent) return { ok: false, reason: 'recent' } as const;
      const r = tx
        .insert(schedules)
        .values({ ...row, approvedBy: row.approvedBy ?? null, approvedTarget: row.approvedTarget ?? null })
        .onConflictDoNothing({ target: schedules.key })
        .returning()
        .get();
      return r ? ({ ok: true, row: toSchedule(r) } as const) : ({ ok: false, reason: 'exists' } as const);
    });
  }
  async updateSchedule(
    id: string,
    patch: SchedulePatch,
    expect: { sha256?: string; nextRunAt?: Date | null } = {},
  ) {
    const conds: SQL[] = [eq(schedules.id, id)];
    if (expect.sha256 !== undefined) conds.push(eq(schedules.sha256, expect.sha256));
    if (expect.nextRunAt !== undefined)
      conds.push(
        expect.nextRunAt === null ? isNull(schedules.nextRunAt) : eq(schedules.nextRunAt, expect.nextRunAt),
      );
    const [r] = await this.db
      .update(schedules)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(...conds))
      .returning();
    return r ? toSchedule(r) : null;
  }

  async insertRun(row: NewScheduleRun) {
    const [r] = await this.db.insert(scheduleRuns).values(row).returning();
    return toRun(r!);
  }
  async updateRun(id: string, patch: ScheduleRunPatch, expectStatus?: ScheduleRunStatus) {
    const where = expectStatus
      ? and(eq(scheduleRuns.id, id), eq(scheduleRuns.status, expectStatus))
      : eq(scheduleRuns.id, id);
    const [r] = await this.db.update(scheduleRuns).set(patch).where(where).returning();
    return r ? toRun(r) : null;
  }
  async getRun(id: string) {
    const [r] = await this.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)).limit(1);
    return r ? toRun(r) : null;
  }
  async listRuns(scheduleId: string, opts: { limit: number; before?: RunCursor }) {
    const conds: SQL[] = [eq(scheduleRuns.scheduleId, scheduleId)];
    if (opts.before)
      conds.push(
        or(
          lt(scheduleRuns.startedAt, opts.before.startedAt),
          and(eq(scheduleRuns.startedAt, opts.before.startedAt), lt(scheduleRuns.id, opts.before.id)),
        )!,
      );
    const rows = await this.db
      .select()
      .from(scheduleRuns)
      .where(and(...conds))
      .orderBy(desc(scheduleRuns.startedAt), desc(scheduleRuns.id))
      .limit(opts.limit);
    return rows.map(toRun);
  }
  async runsInStatus(statuses: ScheduleRunStatus[]) {
    const rows = await this.db
      .select()
      .from(scheduleRuns)
      .where(inArray(scheduleRuns.status, statuses))
      .orderBy(asc(scheduleRuns.startedAt));
    return rows.map(toRun);
  }

  async insertProbeResult(row: NewProbeResult) {
    await this.db.insert(probeResults).values({ ...row, details: (row.details ?? null) as never });
  }
  async latestProbeResults() {
    // The newest result of each probe (Postgres used DISTINCT ON): one index lookup per probe key.
    const latest = this.db.all<{ id: number }>(sql`
      select (select q.id from ${probeResults} q where q.probe_key = k.probe_key order by q.ts desc, q.id desc limit 1) as id
        from (select distinct probe_key from ${probeResults}) k`);
    if (!latest.length) return [];
    const rows = await this.db
      .select()
      .from(probeResults)
      .where(
        inArray(
          probeResults.id,
          latest.map((r) => r.id),
        ),
      )
      .orderBy(asc(probeResults.probeKey));
    return rows.map(toProbe);
  }
  async probeSeries(since: Date, perProbe: number) {
    const ranked = this.db
      .select({
        id: probeResults.id,
        probeKey: probeResults.probeKey,
        ts: probeResults.ts,
        status: probeResults.status,
        metric: probeResults.metric,
        durationMs: probeResults.durationMs,
        message: probeResults.message,
        scheduleRunId: probeResults.scheduleRunId,
        rank: sql<number>`row_number() over (partition by ${probeResults.probeKey} order by ${probeResults.ts} desc, ${probeResults.id} desc)`.as(
          'rank',
        ),
      })
      .from(probeResults)
      .where(gte(probeResults.ts, since))
      .as('ranked');
    const rows = await this.db
      .select()
      .from(ranked)
      .where(sql`${ranked.rank} <= ${perProbe}`)
      .orderBy(ranked.probeKey, desc(ranked.ts));
    return rows.map((r) => toProbe(r));
  }
  async probeResults(key: string, since: Date, limit: number) {
    const rows = await this.db
      .select()
      .from(probeResults)
      .where(and(eq(probeResults.probeKey, key), gte(probeResults.ts, since)))
      .orderBy(desc(probeResults.ts), desc(probeResults.id))
      .limit(limit);
    return rows.map(toProbe);
  }

  async insertApproval(row: NewScheduleApproval) {
    const [r] = await this.db
      .insert(approvals)
      .values({
        subjectType: 'schedule',
        subjectId: row.subjectId,
        policy: row.policy,
        requestedBy: row.requestedBy,
        expiresAt: row.expiresAt,
        decisions: [],
        status: 'pending',
      })
      .returning();
    return toApproval(r!);
  }
  async getApproval(id: string) {
    const [r] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.subjectType, 'schedule')))
      .limit(1);
    return r ? toApproval(r) : null;
  }
  async listApprovals(filter: { status?: ApprovalStatus; subjectId?: string }) {
    const conds: SQL[] = [eq(approvals.subjectType, 'schedule')];
    if (filter.status) conds.push(eq(approvals.status, filter.status));
    if (filter.subjectId) conds.push(eq(approvals.subjectId, filter.subjectId));
    const rows = await this.db
      .select()
      .from(approvals)
      .where(and(...conds))
      .orderBy(desc(approvals.createdAt));
    return rows.map(toApproval);
  }
  async updateApproval(id: string, patch: ScheduleApprovalPatch, expectStatus?: ApprovalStatus) {
    const conds: SQL[] = [eq(approvals.id, id), eq(approvals.subjectType, 'schedule')];
    if (expectStatus) conds.push(eq(approvals.status, expectStatus));
    const [r] = await this.db
      .update(approvals)
      .set(patch)
      .where(and(...conds))
      .returning();
    return r ? toApproval(r) : null;
  }
}
