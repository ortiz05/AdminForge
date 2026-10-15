import type { Connection } from '@adminforge/schemas';
import { ArtifactStore } from '../artifacts/store';
import type { AppContext } from '../context';
import type { ProbeDeps } from '../probes/checks';
import { ProbeViews } from '../probes/views';
import type { RunsModule } from '../runs/module';
import { ScheduleEvents } from './events';
import { createJobRunner, type JobRunner } from './jobs';
import { LeaderElector, pgAdvisoryLock, type LeaderLock, type Timers } from './leader';
import { PgScheduleStore } from './pg-store';
import { Scheduler } from './scheduler';
import { ScheduleService } from './service';
import { MemoryScheduleStore, type ScheduleStore } from './store';

declare module 'fastify' {
  interface FastifyInstance {
    schedules: SchedulesModule;
  }
}

type Log = { info?(obj: object, msg: string): void; warn(obj: object, msg: string): void; error?(obj: object, msg: string): void };

export interface SchedulesOptions {
  store?: ScheduleStore;
  /** Run the scheduler in this process. API default: SCHEDULER_IN_PROCESS, or no database outside tests. */
  inProcess?: boolean;
  /** Leader lock (default: Postgres advisory lock when a database is configured; none otherwise). */
  lock?: LeaderLock | null;
  leaderIntervalMs?: number;
  jobs?: JobRunner;
  timers?: Timers;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  probeDeps?: Partial<ProbeDeps>;
  log?: Log;
}

export interface SchedulesModule {
  store: ScheduleStore;
  events: ScheduleEvents;
  artifacts: ArtifactStore;
  service: ScheduleService;
  probes: ProbeViews;
  /** Dependencies for running probes directly (CLI one-shots). */
  probeDeps: ProbeDeps;
  jobs: JobRunner;
  /** The scheduler, when it runs in this process. */
  scheduler: Scheduler | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Wires the scheduler feature (R6): store (Postgres or memory), cross-process events, artifacts, the job runner, the
 * API service, probe views and — in the scheduler service, or the API with SCHEDULER_IN_PROCESS=true — the scheduler
 * itself behind leader election.
 */
export function createSchedulesModule(ctx: AppContext, runs: RunsModule | null, opts: SchedulesOptions = {}): SchedulesModule {
  const log = opts.log;
  const store = opts.store ?? (ctx.database ? new PgScheduleStore(ctx.database.db) : new MemoryScheduleStore(ctx.now));
  const events = new ScheduleEvents({ bus: ctx.events, database: ctx.database, listenUrl: ctx.database ? ctx.config.DATABASE_URL : null, ...(log ? { log } : {}) });
  const artifacts = new ArtifactStore(ctx.config.ADMINFORGE_ARTIFACTS_DIR);
  const probeDeps: ProbeDeps = {
    outbound: ctx.outbound,
    automation: ctx.automation,
    connection: async (key) => (await ctx.definitions.resolve('connection', key)).def as Connection,
    licences: ctx.licences,
    env: () => ({ ...ctx.contentEnv(), PUBLIC_BASE_URL: ctx.config.PUBLIC_BASE_URL }),
    now: ctx.now,
    spoTenantName: ctx.config.AF_SPO_TENANT_NAME,
    fetch: ctx.fetch,
    ...opts.probeDeps,
  };
  const jobs =
    opts.jobs ??
    createJobRunner({
      definitions: ctx.definitions,
      store,
      outbound: probeDeps.outbound,
      probes: probeDeps,
      datasources: ctx.datasources,
      artifacts,
      runs: runs ? { service: runs.service, repo: runs.repo } : null,
      automationClientId: ctx.automation?.clientId ?? null,
      exportMaxRows: ctx.config.EXPORT_MAX_ROWS,
      now: ctx.now,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      onProbe: (o) => events.publish({ type: 'probe.updated', data: { key: o.probeKey, status: o.status, metric: o.metric, ts: o.ts.toISOString() } }),
    });
  const service = new ScheduleService({ store, definitions: ctx.definitions, audit: ctx.audit, events, artifacts, now: ctx.now });
  const probes = new ProbeViews({ store, definitions: ctx.definitions, now: ctx.now });

  const inProcess = opts.inProcess ?? (ctx.config.SCHEDULER_IN_PROCESS || (!ctx.database && ctx.config.NODE_ENV !== 'test'));
  let scheduler: Scheduler | null = null;
  if (inProcess) {
    const lock = opts.lock !== undefined ? opts.lock : ctx.database && ctx.config.DATABASE_URL ? pgAdvisoryLock(ctx.config.DATABASE_URL) : null;
    const leader = lock
      ? new LeaderElector(lock, {
          intervalMs: opts.leaderIntervalMs ?? 5_000,
          ...(opts.timers ? { timers: opts.timers } : {}),
          ...(log ? { log } : {}),
          onElected: () => scheduler!.elected(),
          onDemoted: (reason) => scheduler!.demoted(reason),
        })
      : null;
    scheduler = new Scheduler({
      store,
      definitions: ctx.definitions,
      jobs,
      audit: ctx.audit,
      events,
      now: ctx.now,
      concurrency: ctx.config.SCHEDULER_CONCURRENCY,
      leader,
      ...(opts.timers ? { timers: opts.timers } : {}),
      ...(log ? { log } : {}),
    });
    events.on((e) => {
      if (e.type === 'schedule.run_requested' || e.type === 'schedules.changed') scheduler!.wake();
    });
  }

  let started = false;
  return {
    store,
    events,
    artifacts,
    service,
    probes,
    probeDeps,
    jobs,
    scheduler,
    async start() {
      if (started) return;
      started = true;
      await events.start();
      await scheduler?.start();
    },
    async stop() {
      if (!started) return;
      started = false;
      await scheduler?.stop();
      await events.stop();
    },
  };
}
