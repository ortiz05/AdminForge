import type { RunStore } from './ports';
import type { Actor, Decision, HumanTask, RunEventInput, RunPatch, RunRecord, RunStatus, StepRecord } from './types';

export interface StoredEvent extends RunEventInput {
  id: number;
  runId: string;
  ts: Date;
}

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory RunStore for tests, `runPlaybookTests`, and DB-less dev mode. */
export class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, RunRecord>();
  readonly steps = new Map<string, Map<number, StepRecord>>();
  readonly events: StoredEvent[] = [];
  readonly tasks = new Map<string, HumanTask>();
  readonly decisions = new Map<string, Decision>();
  /** Every saveStep call with who the step ran as (assert identity handoff). */
  readonly saves: Array<{ runId: string; record: StepRecord; actor: Actor | null; dryRun: boolean }> = [];
  private eventId = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Inserts a run with sensible defaults. */
  create(run: Partial<RunRecord> & Pick<RunRecord, 'id'>): RunRecord {
    const record: RunRecord = {
      kind: 'playbook',
      definitionKey: 'test.playbook',
      definitionVersion: '1.0.0',
      definitionSha256: '0'.repeat(64),
      status: 'queued',
      dryRun: false,
      identity: 'delegated',
      trigger: 'interactive',
      initiator: { kind: 'delegated', oid: '00000000-0000-4000-8000-0000000000a1', upn: 'avery@example.com' },
      inputs: {},
      outputs: null,
      error: null,
      correlationId: `corr-${run.id}`,
      parentRunId: null,
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
      ...run,
    };
    this.runs.set(record.id, clone(record));
    return clone(record);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const r = this.runs.get(runId);
    return r ? clone(r) : null;
  }

  async updateRun(runId: string, patch: RunPatch, expect?: readonly RunStatus[]): Promise<RunRecord | null> {
    const r = this.runs.get(runId);
    if (!r) return null;
    if (expect && !expect.includes(r.status)) return null;
    const next = { ...r, ...clone(patch) };
    this.runs.set(runId, next);
    return clone(next);
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    return [...(this.steps.get(runId)?.values() ?? [])].sort((a, b) => a.seq - b.seq).map(clone);
  }

  async saveStep(runId: string, record: StepRecord, meta: { actor: Actor | null; dryRun: boolean }): Promise<void> {
    let m = this.steps.get(runId);
    if (!m) this.steps.set(runId, (m = new Map()));
    m.set(record.seq, clone(record));
    this.saves.push({ runId, record: clone(record), actor: meta.actor ? clone(meta.actor) : null, dryRun: meta.dryRun });
  }

  async appendEvent(runId: string, event: RunEventInput): Promise<void> {
    this.events.push({ ...clone(event), id: ++this.eventId, runId, ts: this.now() });
  }

  async openTask(runId: string, task: HumanTask): Promise<void> {
    const key = `${runId}|${task.path}`;
    if (!this.tasks.has(key)) this.tasks.set(key, clone(task));
  }

  async getDecision(runId: string, path: string): Promise<Decision | null> {
    const d = this.decisions.get(`${runId}|${path}`);
    return d ? clone(d) : null;
  }

  /** Records a human decision (what the API routes do). */
  decide(runId: string, path: string, decision: Decision): void {
    this.decisions.set(`${runId}|${path}`, clone(decision));
  }

  /** Latest record per path. */
  latest(runId: string): Map<string, StepRecord> {
    const out = new Map<string, StepRecord>();
    for (const r of [...(this.steps.get(runId)?.values() ?? [])].sort((a, b) => a.seq - b.seq)) out.set(r.path, clone(r));
    return out;
  }
}
