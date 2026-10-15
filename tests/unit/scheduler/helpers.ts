import { createHash } from 'node:crypto';
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import type {
  ChangeListener,
  DefinitionRecord,
  DefinitionSource,
} from '@adminforge/api/src/definitions/types';
import { ScheduleEvents, type ScheduleEvent } from '@adminforge/api/src/schedules/events';
import type { JobContext, JobResult, JobRunner } from '@adminforge/api/src/schedules/jobs';
import type { Timers } from '@adminforge/api/src/schedules/leader';
import { Scheduler, type SchedulerOptions } from '@adminforge/api/src/schedules/scheduler';
import { MemoryScheduleStore } from '@adminforge/api/src/schedules/store';
import { Probe, Schedule, type Kind } from '@adminforge/schemas';

/** A controllable clock plus timers driven by it (setTimeout callbacks fire as the clock advances). */
export class FakeClock implements Timers {
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  constructor(public t = Date.parse('2026-10-15T12:00:00.000Z')) {}
  now = () => new Date(this.t);
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { at: this.t + Math.max(ms, 0), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Moves the clock forward, firing due timers in order (awaiting microtasks between them). */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, p]) => p.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
  get timers(): number {
    return this.pending.size;
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function schedule(id: string, extra: Record<string, unknown> = {}): Schedule {
  return Schedule.parse({
    kind: 'schedule',
    id,
    version: '1.0.0',
    title: `Schedule ${id}`,
    owner: 'test-team',
    cron: '*/15 * * * *',
    job: { kind: 'probe', ref: 'probes.example' },
    ...extra,
  });
}

export function probe(id: string, extra: Record<string, unknown> = {}): Probe {
  return Probe.parse({
    kind: 'probe',
    id,
    version: '1.0.0',
    title: `Probe ${id}`,
    owner: 'test-team',
    check: { kind: 'graph', path: '/organization' },
    ...extra,
  });
}

/** Content registry over a mutable list (fires onChange on `set`). */
export class FakeDefinitions implements Pick<DefinitionSource, 'list' | 'get' | 'onChange' | 'problems'> {
  readonly records = new Map<string, DefinitionRecord>();
  private readonly listeners = new Set<ChangeListener>();
  set(def: { kind: Kind; id: string; version: string }, status: 'published' | 'retired' = 'published') {
    this.records.set(`${def.kind}:${def.id}`, {
      kind: def.kind,
      key: def.id,
      version: def.version,
      sha256: sha(JSON.stringify(def)),
      def: def as never,
      status,
      source: 'fs',
      file: `${def.kind}s/${def.id}.${def.kind}.yaml`,
    });
    for (const l of this.listeners) l({ keys: [`${def.kind}:${def.id}`] });
    return this;
  }
  remove(kind: Kind, id: string) {
    this.records.delete(`${kind}:${id}`);
    for (const l of this.listeners) l({ keys: [`${kind}:${id}`] });
  }
  async list(kind?: Kind) {
    return [...this.records.values()].filter((r) => r.status !== 'retired' && (!kind || r.kind === kind));
  }
  async get(kind: Kind, key: string) {
    return this.records.get(`${kind}:${key}`) ?? null;
  }
  async resolve(kind: Kind, key: string) {
    const r = this.records.get(`${kind}:${key}`);
    if (!r)
      throw Object.assign(new Error(`No published ${kind} "${key}".`), { code: 'definition_not_found' });
    return { def: r.def, version: r.version, sha256: r.sha256 } as never;
  }
  onChange(l: ChangeListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  problems() {
    return [];
  }
  async close() {}
}

/** Job runner whose result each test controls; records every call. */
export class FakeJobs implements JobRunner {
  readonly calls: JobContext[] = [];
  /** Pending runs resolve when the test calls `finish` (or when aborted). */
  manual = false;
  private readonly waiting: Array<{
    ctx: JobContext;
    resolve: (r: JobResult) => void;
    reject: (e: unknown) => void;
  }> = [];
  constructor(
    public respond: (ctx: JobContext) => JobResult | Promise<JobResult> = () => ({ result: { ok: true } }),
  ) {}
  run(ctx: JobContext): Promise<JobResult> {
    this.calls.push(ctx);
    if (!this.manual) return Promise.resolve(this.respond(ctx));
    return new Promise((resolve, reject) => {
      this.waiting.push({ ctx, resolve, reject });
      ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
    });
  }
  finish(result: JobResult = { result: { ok: true } }) {
    this.waiting.shift()?.resolve(result);
  }
  get pending() {
    return this.waiting.length;
  }
}

export function harness(
  opts: Partial<SchedulerOptions> & { defs?: FakeDefinitions; jobs?: FakeJobs; clock?: FakeClock } = {},
) {
  const clock = opts.clock ?? new FakeClock();
  const store = new MemoryScheduleStore(clock.now);
  const defs = opts.defs ?? new FakeDefinitions();
  const jobs = opts.jobs ?? new FakeJobs();
  const audit = new MemoryAuditWriter(clock.now);
  const events = new ScheduleEvents();
  const published: ScheduleEvent[] = [];
  events.on((e) => published.push(e));
  const scheduler = new Scheduler({
    store,
    definitions: defs,
    jobs,
    audit,
    events,
    now: clock.now,
    timers: clock,
    concurrency: 4,
    ...opts,
  });
  return { clock, store, defs, jobs, audit, events, published, scheduler };
}
