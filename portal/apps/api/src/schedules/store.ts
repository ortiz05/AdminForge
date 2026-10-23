import { randomUUID } from 'node:crypto';
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

/**
 * Persistence for the scheduler and the schedules/probes API. Postgres in every real install (`SqliteScheduleStore`);
 * the in-memory store backs tests and DB-less mock mode. Conditional updates (`expect`) make every transition safe
 * across processes (two schedulers during a hand-over, the API and the scheduler).
 */
export interface ScheduleStore {
  listSchedules(): Promise<ScheduleRow[]>;
  getSchedule(key: string): Promise<ScheduleRow | null>;
  getScheduleById(id: string): Promise<ScheduleRow | null>;
  /** null when the key already exists. */
  insertSchedule(row: NewSchedule): Promise<ScheduleRow | null>;
  /**
   * Inserts a portal schedule unless one of the caps is reached — counted and inserted atomically (Postgres: one
   * transaction under an advisory lock), so simultaneous requests can't pass a cap.
   */
  insertPortalSchedule(
    row: NewSchedule & { createdBy: string },
    caps: PortalScheduleCaps,
  ): Promise<PortalInsertResult>;
  /** Applies the patch when the row still matches `expect` (sha256 / nextRunAt); null otherwise. */
  updateSchedule(
    id: string,
    patch: SchedulePatch,
    expect?: { sha256?: string; nextRunAt?: Date | null },
  ): Promise<ScheduleRow | null>;

  insertRun(row: NewScheduleRun): Promise<ScheduleRunRow>;
  /** Applies the patch when the row is still in `expectStatus` (if given); null otherwise. */
  updateRun(
    id: string,
    patch: ScheduleRunPatch,
    expectStatus?: ScheduleRunStatus,
  ): Promise<ScheduleRunRow | null>;
  getRun(id: string): Promise<ScheduleRunRow | null>;
  /** Newest first; `before` = keyset cursor. */
  listRuns(scheduleId: string, opts: { limit: number; before?: RunCursor }): Promise<ScheduleRunRow[]>;
  /** Rows in one of `statuses` (all schedules), oldest first. */
  runsInStatus(statuses: ScheduleRunStatus[]): Promise<ScheduleRunRow[]>;

  insertProbeResult(row: NewProbeResult): Promise<void>;
  /** Latest result per probe key. */
  latestProbeResults(): Promise<ProbeResultRow[]>;
  /** Results since `since` for every probe, newest first, at most `perProbe` per key (no details). */
  probeSeries(since: Date, perProbe: number): Promise<ProbeResultRow[]>;
  /** One probe's results since `since`, newest first (with details). */
  probeResults(key: string, since: Date, limit: number): Promise<ProbeResultRow[]>;

  insertApproval(row: NewScheduleApproval): Promise<ScheduleApprovalRow>;
  getApproval(id: string): Promise<ScheduleApprovalRow | null>;
  listApprovals(filter: { status?: ApprovalStatus; subjectId?: string }): Promise<ScheduleApprovalRow[]>;
  updateApproval(
    id: string,
    patch: ScheduleApprovalPatch,
    expectStatus?: ApprovalStatus,
  ): Promise<ScheduleApprovalRow | null>;
}

const clone = <T>(v: T): T => structuredClone(v);
const newer = (a: { startedAt: Date; id: string }, b: { startedAt: Date; id: string }) =>
  b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** In-memory store (tests, DB-less mock mode). */
export class MemoryScheduleStore implements ScheduleStore {
  readonly schedules = new Map<string, ScheduleRow>();
  readonly runs = new Map<string, ScheduleRunRow>();
  readonly probes: ProbeResultRow[] = [];
  readonly approvals = new Map<string, ScheduleApprovalRow>();
  private probeSeq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async listSchedules() {
    return [...this.schedules.values()].sort((a, b) => a.key.localeCompare(b.key)).map(clone);
  }
  async getSchedule(key: string) {
    const r = [...this.schedules.values()].find((s) => s.key === key);
    return r ? clone(r) : null;
  }
  async getScheduleById(id: string) {
    const r = this.schedules.get(id);
    return r ? clone(r) : null;
  }
  async insertSchedule(row: NewSchedule) {
    if ([...this.schedules.values()].some((s) => s.key === row.key)) return null;
    const now = this.now();
    const full: ScheduleRow = {
      id: randomUUID(),
      createdBy: null,
      approvedBy: null,
      approvedTarget: null,
      lastRunAt: null,
      lastStatus: null,
      runAs: null,
      runAsSetBy: null,
      runAsSetAt: null,
      createdAt: now,
      updatedAt: now,
      ...clone(row),
    };
    this.schedules.set(full.id, full);
    return clone(full);
  }
  async insertPortalSchedule(
    row: NewSchedule & { createdBy: string },
    caps: PortalScheduleCaps,
  ): Promise<PortalInsertResult> {
    // No await between counting and inserting: atomic in this process.
    const portal = [...this.schedules.values()].filter((s) => s.source === 'portal');
    const active = portal.filter((s) => s.definition.status !== 'retired');
    if (active.length >= caps.total) return { ok: false, reason: 'total' };
    if (active.filter((s) => s.createdBy === row.createdBy).length >= caps.perCreator)
      return { ok: false, reason: 'perCreator' };
    if (
      portal.filter((s) => s.createdBy === row.createdBy && s.createdAt.getTime() >= caps.since.getTime())
        .length >= caps.recent
    )
      return { ok: false, reason: 'recent' };
    const inserted = await this.insertSchedule(row);
    return inserted ? { ok: true, row: inserted } : { ok: false, reason: 'exists' };
  }
  async updateSchedule(
    id: string,
    patch: SchedulePatch,
    expect: { sha256?: string; nextRunAt?: Date | null } = {},
  ) {
    const r = this.schedules.get(id);
    if (!r) return null;
    if (expect.sha256 !== undefined && r.sha256 !== expect.sha256) return null;
    if (
      expect.nextRunAt !== undefined &&
      (r.nextRunAt?.getTime() ?? null) !== (expect.nextRunAt?.getTime() ?? null)
    )
      return null;
    Object.assign(r, clone(patch), { updatedAt: this.now() });
    return clone(r);
  }

  async insertRun(row: NewScheduleRun) {
    const full: ScheduleRunRow = {
      id: row.id ?? randomUUID(),
      runId: null,
      result: null,
      error: null,
      artifactPath: null,
      startedAt: this.now(),
      endedAt: null,
      ...clone(row),
    };
    this.runs.set(full.id, full);
    return clone(full);
  }
  async updateRun(id: string, patch: ScheduleRunPatch, expectStatus?: ScheduleRunStatus) {
    const r = this.runs.get(id);
    if (!r || (expectStatus && r.status !== expectStatus)) return null;
    Object.assign(r, clone(patch));
    return clone(r);
  }
  async getRun(id: string) {
    const r = this.runs.get(id);
    return r ? clone(r) : null;
  }
  async listRuns(scheduleId: string, opts: { limit: number; before?: RunCursor }) {
    return [...this.runs.values()]
      .filter((r) => r.scheduleId === scheduleId && (!opts.before || newer(r, opts.before) > 0))
      .sort(newer)
      .slice(0, opts.limit)
      .map(clone);
  }
  async runsInStatus(statuses: ScheduleRunStatus[]) {
    return [...this.runs.values()]
      .filter((r) => statuses.includes(r.status))
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .map(clone);
  }

  async insertProbeResult(row: NewProbeResult) {
    this.probes.push({ id: ++this.probeSeq, ...clone(row) });
  }
  async latestProbeResults() {
    const latest = new Map<string, ProbeResultRow>();
    for (const p of this.probes) {
      const cur = latest.get(p.probeKey);
      if (!cur || p.ts >= cur.ts) latest.set(p.probeKey, p);
    }
    return [...latest.values()].map(clone);
  }
  async probeSeries(since: Date, perProbe: number) {
    const byKey = new Map<string, ProbeResultRow[]>();
    for (const p of [...this.probes].sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id)) {
      if (p.ts < since) continue;
      const list = byKey.get(p.probeKey) ?? [];
      if (list.length < perProbe) list.push({ ...p, details: null });
      byKey.set(p.probeKey, list);
    }
    return [...byKey.values()].flat().map(clone);
  }
  async probeResults(key: string, since: Date, limit: number) {
    return this.probes
      .filter((p) => p.probeKey === key && p.ts >= since)
      .sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id)
      .slice(0, limit)
      .map(clone);
  }

  async insertApproval(row: NewScheduleApproval) {
    const full: ScheduleApprovalRow = {
      id: randomUUID(),
      subjectType: 'schedule',
      decisions: [],
      status: 'pending',
      createdAt: this.now(),
      decidedAt: null,
      ...clone(row),
    };
    this.approvals.set(full.id, full);
    return clone(full);
  }
  async getApproval(id: string) {
    const r = this.approvals.get(id);
    return r ? clone(r) : null;
  }
  async listApprovals(filter: { status?: ApprovalStatus; subjectId?: string }) {
    return [...this.approvals.values()]
      .filter(
        (a) =>
          (!filter.status || a.status === filter.status) &&
          (!filter.subjectId || a.subjectId === filter.subjectId),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(clone);
  }
  async updateApproval(id: string, patch: ScheduleApprovalPatch, expectStatus?: ApprovalStatus) {
    const r = this.approvals.get(id);
    if (!r || (expectStatus && r.status !== expectStatus)) return null;
    Object.assign(r, clone(patch));
    return clone(r);
  }
}
