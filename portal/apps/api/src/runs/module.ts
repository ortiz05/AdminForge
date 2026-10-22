import { loadEnv } from '@adminforge/config';
import { deliveryEnv, notifyApprovers, type DeliveryDeps } from '../delivery/notifier';
import { RoleCheck } from '../auth/session-plugin';
import { isArmed } from '../auth/session-store';
import { Heartbeat } from '../health/heartbeat';
import { Engine, type Clock, type Limits, type RunnerPort } from '@adminforge/engine';
import type { AppContext } from '../context';
import { fixtureFetch } from '../datasources/services';
import type { DefinitionResolver } from '../definitions/types';
import type { OutboundExecutor } from '../execution/types';
import { RunChildRunner } from './children';
import { RunEventBus } from './events';
import { SessionIdentityResolver } from './identity';
import { createFixtureRunnerPort } from './fixture-runner';
import { MemoryRunRepository } from './memory-repository';
import { SqliteRunRepository } from './sqlite-repository';
import { createOutboundPort, createRunnerPort, perPersonRunnerPort } from './ports';
import { InProcessRunQueue, SqliteRunQueue, type RunQueue } from './queue';
import { RunWorker } from './run-worker';
import { SecretBroker } from './secrets';
import { RunService } from './service';
import { RUN_STREAM_POLL_MS, sessionLive } from './sse';
import { RepositoryRunStore } from './store';
import { sessionBinding, type RunNotification, type RunRepository } from './types';

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
  /** null disables runner steps; default: the fixtures (DATA_MODE=fixtures), else RUNNER_URL + RUNNER_SHARED_KEY. */
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
  /** Tests: overrides for the approvers' email/Teams delivery (the configuration `env` it reads, …). */
  delivery?: Partial<DeliveryDeps>;
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
  // Tells /readyz the run worker is working: it beats when a poll of the queue went through (D-09), so it exists only
  // where this process consumes the queue, with a database (set below, once `consuming` is known).
  let heartbeat: Heartbeat | null = null;
  const queue =
    opts.queue ??
    (ctx.database
      ? new SqliteRunQueue(ctx.database, log, { onPoll: () => heartbeat?.progress() })
      : new InProcessRunQueue(log));
  const consuming = opts.inProcessWorker ?? (queue.kind === 'memory' || !testing);

  let runner: RunnerPort | undefined;
  if (opts.runner !== undefined) runner = opts.runner ?? undefined;
  // DATA_MODE=fixtures: PowerShell steps answer from the runner fixtures, as PowerShell datasources do — never the real
  // runner, whose tokens would change the tenant while every other step reads fixtures (M2).
  else if (ctx.config.DATA_MODE === 'fixtures')
    runner = createFixtureRunnerPort({
      dir: ctx.config.ADMINFORGE_FIXTURES_DIR,
      acceptUnfixturedWrites: ctx.config.AUTH_MODE === 'mock',
      outbound: outbound(),
    });
  else if (!testing && ctx.config.RUNNER_URL && ctx.config.RUNNER_SHARED_KEY) {
    try {
      runner = perPersonRunnerPort(
        createRunnerPort({
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
        }),
        ctx.config.RUNNER_JOBS_PER_PERSON,
      );
    } catch (err) {
      log?.warn({ err: { message: (err as Error).message } }, 'PowerShell runner disabled');
    }
  }

  const approvalsDelivery: DeliveryDeps = {
    outbound: ctx.outbound,
    // DATA_MODE=fixtures: the approvers' Teams webhook gets the fixture fetch, like schedules' delivery (e-mail already
    // goes through the fixture outbound), so mock mode never reaches the internet.
    fetch: ctx.config.DATA_MODE === 'fixtures' ? fixtureFetch(ctx.config) : ctx.fetch,
    // Only the delivery keys of the configuration (sender, recipient lists, webhooks), like schedules' delivery.
    env: testing ? {} : deliveryEnv(loadEnv()),
    publicBaseUrl: ctx.config.PUBLIC_BASE_URL,
    ...opts.delivery,
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
  // S-08: a session whose id is rotated (arming) takes its unfinished runs, approval decisions and held secrets along.
  ctx.sessions.onRotate(repo);
  ctx.sessions.onRotate(secrets);
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
      (async (binding) => {
        const { hash } = sessionBinding(binding);
        const session = hash ? await ctx.sessions.get(hash) : null;
        if (!session || !ctx.broker) return;
        const modes = isArmed(session, ctx.now()) ? (['read', 'write'] as const) : (['read'] as const);
        for (const mode of modes)
          for (const service of ['graph', 'arm'] as const)
            await ctx.broker.get(session, service, mode, { forceRefresh: true });
      }),
  }));
  const service = new RunService({
    repo,
    queue,
    store,
    definitions,
    audit: ctx.audit,
    env,
    now: ctx.now,
    maxOpenRuns: ctx.config.RUN_MAX_OPEN_PER_USER,
  });

  let started = false;
  if (consuming && ctx.database && !testing)
    heartbeat = new Heartbeat(ctx.database.db, 'worker', ctx.now, (err) =>
      opts.log?.warn({ err }, 'worker heartbeat failed'),
    );
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
      }
    },
    async stop() {
      started = false;
      // Interrupts, never cancels (D-01): runs stop at a checkpoint and their jobs are queued again (stops the queue).
      await worker.stop();
      await bus.stop();
      await secrets.stop();
    },
  };
}
