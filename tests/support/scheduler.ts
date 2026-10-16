/**
 * Scheduler fakes shared by the `unit` project (tests/unit/scheduler) and the `api` project (schedules, probes,
 * news, portal-schedule and emergency route tests): content and job runners whose behaviour each test controls,
 * synthetic schedule/probe definitions, and the timer-driving clock.
 *
 * - `FakeDefinitions`: a content registry over a mutable map (`set`/`remove` fire `onChange` like the fs source);
 *   pass it to the Scheduler directly, or wrap it with `registryFrom(defs as never, 'fs')` for the API.
 * - `FakeJobs`: a `JobRunner` that records every call and answers with `respond` (or, with `manual = true`, waits for
 *   `finish()` or the abort signal).
 * - `schedule(id, extra)` / `probe(id, extra)`: valid, parsed definitions with test defaults.
 * - `FakeClock`, `flush`: from tests/lib/clock.ts; `sha`: hex SHA-256 like the definition store's.
 *
 * tests/unit/scheduler/helpers.ts re-exports these next to its Scheduler `harness()`; the API tests import them from
 * here (or through tests/api/schedules-helpers.ts).
 */
import { createHash } from 'node:crypto';
import type {
  ChangeListener,
  DefinitionRecord,
  DefinitionSource,
} from '@adminforge/api/src/definitions/types';
import type { JobContext, JobResult, JobRunner } from '@adminforge/api/src/schedules/jobs';
import { Probe, Schedule, type Kind } from '@adminforge/schemas';

export { FakeClock, flush } from '../lib/clock';

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
