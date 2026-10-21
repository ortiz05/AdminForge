import { randomUUID } from 'node:crypto';
import type { HumanTask, RunEventInput, RunStatus, StepRecord } from '@adminforge/engine';
import {
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

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory repository for tests and DB-less mock mode. `onNotify` stands in for NOTIFY run_events. */
export class MemoryRunRepository implements RunRepository {
  readonly runs = new Map<string, RunRow>();
  readonly steps = new Map<string, Map<number, StepRecord>>();
  readonly events: EventRow[] = [];
  readonly tasks = new Map<string, TaskRow>();
  private eventId = 0;
  private readonly locks = new Set<string>();
  onNotify: (n: RunNotification) => void = () => undefined;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async insertRun(run: NewRun): Promise<RunRow> {
    if (this.runs.has(run.id)) throw new Error(`duplicate run ${run.id}`);
    return this.insertRunIfAbsent(run);
  }

  async insertRunIfAbsent(run: NewRun): Promise<RunRow> {
    return this.insertNow(run);
  }

  async insertOpenRun(run: NewRun, limit: { max: number; ifAbsent?: boolean }): Promise<OpenRunInsert> {
    // Synchronous from the count to the insert: nothing else runs in between.
    const existing = this.runs.get(run.id);
    if (existing) {
      if (limit.ifAbsent) return { ok: true, row: clone(existing) };
      throw new Error(`duplicate run ${run.id}`);
    }
    let open = 0;
    for (const r of this.runs.values())
      if (
        r.initiatorOid === run.initiatorOid &&
        r.parentRunId === null &&
        r.identity === 'delegated' &&
        RUN_STATUS_OPEN.includes(r.status)
      )
        open++;
    if (open >= limit.max) return { ok: false, open };
    return { ok: true, row: this.insertNow(run) };
  }

  private insertNow(run: NewRun): RunRow {
    const existing = this.runs.get(run.id);
    if (existing) return clone(existing);
    const now = this.now();
    const row: RunRow = {
      ...clone(run),
      status: run.status ?? 'queued',
      outputs: null,
      error: null,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      updatedAt: now,
    };
    this.runs.set(row.id, row);
    return clone(row);
  }

  async getRun(id: string): Promise<RunRow | null> {
    const r = this.runs.get(id);
    return r ? clone(r) : null;
  }

  async updateRun(id: string, patch: RunRowPatch, expect?: readonly RunStatus[]): Promise<RunRow | null> {
    const r = this.runs.get(id);
    if (!r || (expect && !expect.includes(r.status))) return null;
    const next = { ...r, ...clone(patch), updatedAt: this.now() };
    this.runs.set(id, next);
    return clone(next);
  }

  async listRuns(f: RunFilter): Promise<RunRow[]> {
    const topLevel = f.topLevel ?? f.parentRunId === undefined;
    return [...this.runs.values()]
      .filter(
        (r) =>
          (!f.initiatorOid || r.initiatorOid === f.initiatorOid) &&
          (!f.statuses?.length || f.statuses.includes(r.status)) &&
          (!f.definitionKey || r.definitionKey === f.definitionKey) &&
          (f.parentRunId === undefined || r.parentRunId === f.parentRunId) &&
          (!topLevel || r.parentRunId === null) &&
          (!f.from || r.createdAt >= f.from) &&
          (!f.to || r.createdAt <= f.to) &&
          (!f.cursor ||
            r.createdAt < f.cursor.createdAt ||
            (r.createdAt.getTime() === f.cursor.createdAt.getTime() && r.id < f.cursor.id)),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .slice(0, f.limit)
      .map(clone);
  }

  async runTree(rootId: string): Promise<RunRow[]> {
    const out: RunRow[] = [];
    const root = this.runs.get(rootId);
    if (!root) return out;
    const queue = [root];
    while (queue.length) {
      const r = queue.shift()!;
      out.push(clone(r));
      for (const c of this.runs.values()) if (c.parentRunId === r.id) queue.push(c);
    }
    return out;
  }

  async staleRuns(statuses: readonly RunStatus[], before: Date, limit: number): Promise<RunRow[]> {
    return [...this.runs.values()]
      .filter((r) => statuses.includes(r.status) && r.updatedAt < before)
      .slice(0, limit)
      .map(clone);
  }

  async saveStep(runId: string, record: StepRecord): Promise<void> {
    let m = this.steps.get(runId);
    if (!m) this.steps.set(runId, (m = new Map()));
    m.set(record.seq, clone(record));
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    return [...(this.steps.get(runId)?.values() ?? [])].sort((a, b) => a.seq - b.seq).map(clone);
  }

  async appendEvent(runId: string, event: RunEventInput, notify: RunNotification): Promise<EventRow> {
    const row: EventRow = { ...clone(event), id: ++this.eventId, runId, ts: this.now() };
    this.events.push(row);
    this.onNotify({ ...notify, eventId: row.id });
    return clone(row);
  }

  async listEvents(runId: string, afterId: number, limit: number): Promise<EventRow[]> {
    return this.events
      .filter((e) => e.runId === runId && e.id > afterId)
      .slice(0, limit)
      .map(clone);
  }

  private key = (runId: string, path: string) => `${runId}|${path}`;

  async upsertTask(runId: string, task: HumanTask, policy: TaskPolicy): Promise<TaskRow> {
    const k = this.key(runId, task.path);
    const existing = this.tasks.get(k);
    if (existing) return clone(existing);
    const row: TaskRow = {
      id: randomUUID(),
      subjectType: 'run',
      subjectId: runId,
      stepId: task.path,
      policy: clone(policy),
      decisions: [],
      status: 'pending',
      requestedBy: task.requestedBy.oid ?? 'automation',
      expiresAt: task.kind === 'approval' && task.expiresAt ? new Date(task.expiresAt) : null,
      createdAt: this.now(),
      decidedAt: null,
    };
    this.tasks.set(k, row);
    return clone(row);
  }

  async getTask(runId: string, path: string): Promise<TaskRow | null> {
    const t = this.tasks.get(this.key(runId, path));
    return t ? clone(t) : null;
  }

  async getTaskById(id: string): Promise<TaskRow | null> {
    for (const t of this.tasks.values()) if (t.id === id) return clone(t);
    return null;
  }

  async updateTask(
    id: string,
    patch: Partial<Pick<TaskRow, 'decisions' | 'status' | 'decidedAt'>>,
    expect?: TaskStatus,
  ): Promise<TaskRow | null> {
    for (const [k, t] of this.tasks) {
      if (t.id !== id) continue;
      if (expect && t.status !== expect) return null;
      const next = { ...t, ...clone(patch) };
      this.tasks.set(k, next);
      return clone(next);
    }
    return null;
  }

  async listTasks(f: TaskFilter): Promise<TaskRow[]> {
    return [...this.tasks.values()]
      .filter(
        (t) =>
          (!f.status || t.status === f.status) &&
          (!f.kind || t.policy.kind === f.kind) &&
          (!f.runId || t.subjectId === f.runId) &&
          (!f.runIds || f.runIds.includes(t.subjectId)),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }

  async tryLock(runId: string) {
    if (this.locks.has(runId)) return null;
    this.locks.add(runId);
    return { release: async () => void this.locks.delete(runId) };
  }
}
