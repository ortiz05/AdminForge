import { loadEnv } from '@adminforge/config';
import { notifyApprovers, type DeliveryDeps } from '../delivery/notifier';
import { RoleCheck } from '../auth/session-plugin';
import { isArmed } from '../auth/session-store';
import { Heartbeat } from '../health/heartbeat';
import { Engine, type Clock, type Limits, type RunnerPort } from '@adminforge/engine';
import type { AppContext } from '../context';
import type { DefinitionResolver } from '../definitions/types';
import type { OutboundExecutor } from '../execution/types';
import { RunChildRunner } from './children';
import { RunEventBus } from './events';
import { SessionIdentityResolver } from './identity';
import { MemoryRunRepository } from './memory-repository';
import { SqliteRunRepository } from './sqlite-repository';
import { createOutboundPort, createRunnerPort } from './ports';
import { InProcessRunQueue, SqliteRunQueue, type RunQueue } from './queue';
import { RunWorker } from './run-worker';
import { SecretBroker } from './secrets';
import { RunService } from './service';
import { RUN_STREAM_POLL_MS, sessionLive } from './sse';
import { RepositoryRunStore } from './store';
import type { RunNotification, RunRepository } from './types';

declare module 'fastify' {
  interface FastifyInstance {
    runs: RunsModule;
  }
}

type Log = {
  info?(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error?(obj: object, msg: string): void;
};

/** Overrides for tests and the scheduler one-shots. Everything defaults from AppContext + configuration. */
export interface RunsOptions {
  repository?: RunRepository;
  queue?: RunQueue;
  definitions?: DefinitionResolver;
  outbound?: OutboundExecutor;
  /** null disables runner steps; default: RUNNER_URL + RUNNER_SHARED_KEY from configuration. */
  runner?: RunnerPort | null;
  /** Consume jobs in this process. Default: yes outside tests (the API is the worker, ADR-016), and always in memory. */
  inProcessWorker?: boolean;
  /** Tests: replaces the post-run token refresh (playbooks with `refreshTokens: true`). */
  refreshTokens?: (sessionHash: string) => Promise<void>;
  /** Run jobs worked on at once (default RUN_WORKER_CONCURRENCY). */
  workerConcurrency?: number;
  /** Periodic sweep (approval expiry, lost jobs) in the in-process worker. Default true. */
  sweep?: boolean;
  /** How long an unfetched secret is held (default 5 minutes). */
  secretTtlMs?: number;
  /** How often an open run stream re-checks its session and access (default 10 s; tests shorten it). */
  streamPollMs?: number;
  clock?: Clock;
  env?: () => Record<string, unknown>;
  limits?: Partial<Limits>;
  log?: Log;
}

export interface RunsModule {
  service: RunService;
  repo: RunRepository;
  queue: RunQueue;
  bus: RunEventBus;
  engine: Engine;
  store: RepositoryRunStore;
  identity: SessionIdentityResolver;
  worker: RunWorker;
  secrets: SecretBroker;
  /** Whether this process consumes run jobs. */
  readonly consuming: boolean;
  /** How often an open run stream re-checks its session and access (ms). */
  readonly streamPollMs: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Wires the runs feature (§4.3, §7.8): repository (SQLite or memory), queue (the `run_jobs` table or in-process), the
 * run event bus, the engine with its ports, the worker and the service used by the routes and the scheduler. The API
 * process is the worker (ADR-016): run notifications and show-once secrets stay in this process.
 */
export function createRunsModule(ctx: AppContext, opts: RunsOptions = {}): RunsModule {
  const log = opts.log;
  const testing = ctx.config.NODE_ENV === 'test';
  const definitions = (): DefinitionResolver => opts.definitions ?? ctx.definitions;
  const env = opts.env ?? ctx.contentEnv;
  const outbound = (): OutboundExecutor | null => opts.outbound ?? ctx.outbound ?? null;

  const repo =
    opts.repository ??
    (ctx.database ? new SqliteRunRepository(ctx.database, ctx.now) : new MemoryRunRepository(ctx.now));
  const bus = new RunEventBus();
  if (repo instanceof MemoryRunRepository || repo instanceof SqliteRunRepository) {
    repo.onNotify = (n: RunNotification) => {
      bus.dispatch(n);
      ctx.events?.relayRun(n);
    };
  }
  const queue =
    opts.queue ?? (ctx.database ? new SqliteRunQueue(ctx.database, log) : new InProcessRunQueue(log));
  const consuming = opts.inProcessWorker ?? (queue.kind === 'memory' || !testing);

  let runner: RunnerPort | undefined;
  if (opts.runner !== undefined) runner = opts.runner ?? undefined;
  else if (!testing && ctx.config.RUNNER_URL && ctx.config.RUNNER_SHARED_KEY) {
    try {
      runner = createRunnerPort({
        url: ctx.config.RUNNER_URL,
        key: ctx.config.RUNNER_SHARED_KEY,
        broker: ctx.broker,
        tenant: {
          id: ctx.config.AF_TENANT_ID,
          domain: ctx.config.AF_PRIMARY_DOMAIN,
          spoTenantName: ctx.config.AF_SPO_TENANT_NAME,
        },
        fetch: ctx.fetch,
        now: ctx.now,
        outbound: outbound(),
      });
    } catch (err) {
      log?.warn({ err: { message: (err as Error).message } }, 'PowerShell runner disabled');
    }
  }

  const approvalsDelivery: DeliveryDeps = {
    outbound: ctx.outbound,
    fetch: ctx.fetch,
    env: testing ? {} : loadEnv(),
    publicBaseUrl: ctx.config.PUBLIC_BASE_URL,
  };
  const store = new RepositoryRunStore(repo, ctx.audit, async (r) => {
    const results = await notifyApprovers(
      approvalsDelivery,
      { title: r.title, requestedBy: r.requestedBy, path: `/runs/${r.runId}` },
      r.correlationId,
    );
    if (results.some((x) => x.status !== 'sent'))
      opts.log?.warn(
        { results: results.map((x) => ({ type: x.type, status: x.status })) },
        'approver notification incomplete',
      );
  });
  const secrets = new SecretBroker({
    repo,
    audit: ctx.audit,
    ...(opts.secretTtlMs ? { ttlMs: opts.secretTtlMs } : {}),
    ...(log ? { log } : {}),
    sessionLive: async (hash) =>
      sessionLive(await ctx.sessions.get(hash), ctx.now(), ctx.config.SESSION_IDLE_MINUTES),
  });
  // Delegated steps re-confirm the session's roles with Entra like browser requests do (RoleCheck).
  const identity = new SessionIdentityResolver(repo, ctx.sessions, ctx.config, ctx.now, {
    roleCheck: new RoleCheck(ctx),
    ...(log ? { log } : {}),
  });
  const holder: { engine?: Engine; worker?: RunWorker } = {};
  const children = new RunChildRunner({
    repo,
    store,
    identity,
    definitions,
    engine: () => holder.engine!,
    audit: ctx.audit,
    env,
    now: ctx.now,
    interrupt: () => holder.worker?.interrupt,
  });
  const engine = (holder.engine = new Engine({
    store,
    identity,
    outbound: createOutboundPort(outbound),
    ...(runner ? { runner } : {}),
    children,
    secrets: secrets.sink(),
    env: env(),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
    rolesOf: (actor) => (actor.oid ? (identity.roles.get(actor.oid) ?? []) : []),
  }));
  const worker = (holder.worker = new RunWorker({
    repo,
    queue,
    engine,
    store,
    identity,
    definitions,
    bus,
    now: ctx.now,
    audit: ctx.audit,
    ...(log ? { log } : {}),
    // New Entra roles (PIM activation) only reach Microsoft in fresh tokens: refresh Graph and ARM for that session.
    refreshTokens:
      opts.refreshTokens ??
      (async (hash) => {
        const session = await ctx.sessions.get(hash);
        if (!session || !ctx.broker) return;
        const modes = isArmed(session, ctx.now()) ? (['read', 'write'] as const) : (['read'] as const);
        for (const mode of modes)
          for (const service of ['graph', 'arm'] as const)
            await ctx.broker.get(session, service, mode, { forceRefresh: true });
      }),
  }));
  const service = new RunService({ repo, queue, store, definitions, audit: ctx.audit, env, now: ctx.now });

  let started = false;
  // Tells /readyz the run worker is alive (only where this process consumes the queue, with a database).
  const heartbeat =
    consuming && ctx.database && !testing
      ? new Heartbeat(ctx.database.db, 'worker', ctx.now, (err) =>
          opts.log?.warn({ err }, 'worker heartbeat failed'),
        )
      : null;
  return {
    service,
    repo,
    queue,
    bus,
    engine,
    store,
    identity,
    worker,
    secrets,
    consuming,
    streamPollMs: opts.streamPollMs ?? RUN_STREAM_POLL_MS,
    async start() {
      if (started) return;
      started = true;
      await secrets.start();
      if (consuming) {
        await worker.start(opts.workerConcurrency ?? ctx.config.RUN_WORKER_CONCURRENCY, {
          sweep: opts.sweep ?? !testing,
        });
        heartbeat?.start();
      }
    },
    async stop() {
      started = false;
      heartbeat?.stop();
      // Interrupts, never cancels (D-01): runs stop at a checkpoint and their jobs are queued again (stops the queue).
      await worker.stop();
      await bus.stop();
      await secrets.stop();
    },
  };
}
