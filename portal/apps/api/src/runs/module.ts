import { randomBytes } from 'node:crypto';
import { Engine, type Clock, type Limits, type RunnerPort } from '@adminforge/engine';
import { tokenCacheKey } from '../config';
import type { AppContext } from '../context';
import type { DefinitionResolver } from '../definitions/types';
import type { OutboundExecutor } from '../execution/types';
import { RunChildRunner } from './children';
import { RunEventBus } from './events';
import { SessionIdentityResolver } from './identity';
import { MemoryRunRepository } from './memory-repository';
import { PgRunRepository } from './pg-repository';
import { createOutboundPort, createRunnerPort } from './ports';
import { InProcessRunQueue, PgBossRunQueue, type RunQueue } from './queue';
import { RunWorker } from './run-worker';
import { SecretBroker } from './secrets';
import { RunService } from './service';
import { RepositoryRunStore } from './store';
import type { RunRepository } from './types';

declare module 'fastify' {
  interface FastifyInstance {
    runs: RunsModule;
  }
}

type Log = { info?(obj: object, msg: string): void; warn(obj: object, msg: string): void; error?(obj: object, msg: string): void };

/** Overrides for tests and for the worker entry point. Everything defaults from AppContext + configuration. */
export interface RunsOptions {
  repository?: RunRepository;
  queue?: RunQueue;
  definitions?: DefinitionResolver;
  outbound?: OutboundExecutor;
  /** null disables runner steps; default: RUNNER_URL + RUNNER_SHARED_KEY from configuration. */
  runner?: RunnerPort | null;
  /** Consume jobs in this process. Default: RUN_WORKER_IN_PROCESS=true, or always with the in-memory queue. */
  inProcessWorker?: boolean;
  workerConcurrency?: number;
  /** Periodic sweep (approval expiry, lost jobs) in the in-process worker. Default true. */
  sweep?: boolean;
  /** This process serves browsers and receives show-once secrets (default true; the worker entry passes false). */
  serveSecrets?: boolean;
  /** How long an unfetched secret is held (default 5 minutes). */
  secretTtlMs?: number;
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
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Wires the runs feature (§4.3, §7.8): repository (Postgres or memory), queue (pg-boss or in-process), event bus
 * (LISTEN run_events), the engine with its ports, the worker and the service used by the routes and the scheduler.
 * Nothing touches Postgres/pg-boss until a run is created, an event stream opens, or the worker starts.
 */
export function createRunsModule(ctx: AppContext, opts: RunsOptions = {}): RunsModule {
  const log = opts.log;
  const testing = ctx.config.NODE_ENV === 'test';
  const definitions = (): DefinitionResolver => opts.definitions ?? ctx.definitions;
  const env = opts.env ?? ctx.contentEnv;
  const outbound = (): OutboundExecutor | null => opts.outbound ?? ctx.outbound ?? null;

  const repo = opts.repository ?? (ctx.database ? new PgRunRepository(ctx.database, ctx.now) : new MemoryRunRepository(ctx.now));
  const bus = new RunEventBus(ctx.database && ctx.config.DATABASE_URL && !(repo instanceof MemoryRunRepository) ? { listenUrl: ctx.config.DATABASE_URL, ...(log ? { log } : {}) } : {});
  if (repo instanceof MemoryRunRepository) {
    repo.onNotify = (n) => {
      bus.dispatch(n);
      // Without Postgres there is no NOTIFY for the platform stream to relay: publish run.updated directly.
      if (n.type === 'run' || n.type === 'step') ctx.events?.publish({ type: 'run.updated', data: n, ...(n.initiatorOid ? { userOid: n.initiatorOid } : {}) });
    };
  }
  const queue = opts.queue ?? (ctx.database && ctx.config.DATABASE_URL ? new PgBossRunQueue(ctx.config.DATABASE_URL, log) : new InProcessRunQueue(log));
  const consuming = opts.inProcessWorker ?? (queue.kind === 'memory' || (!testing && ctx.config.RUN_WORKER_IN_PROCESS));

  let runner: RunnerPort | undefined;
  if (opts.runner !== undefined) runner = opts.runner ?? undefined;
  else if (!testing && ctx.config.RUNNER_URL && ctx.config.RUNNER_SHARED_KEY) {
    try {
      runner = createRunnerPort({
        url: ctx.config.RUNNER_URL,
        key: ctx.config.RUNNER_SHARED_KEY,
        broker: ctx.broker,
        tenant: { id: ctx.config.AF_TENANT_ID, domain: ctx.config.AF_PRIMARY_DOMAIN, spoTenantName: ctx.config.AF_SPO_TENANT_NAME },
        fetch: ctx.fetch,
        now: ctx.now,
      });
    } catch (err) {
      log?.warn({ err: { message: (err as Error).message } }, 'PowerShell runner disabled');
    }
  }

  const store = new RepositoryRunStore(repo, ctx.audit);
  const pg = !!ctx.database && !!ctx.config.DATABASE_URL && !(repo instanceof MemoryRunRepository);
  const secrets = new SecretBroker({
    repo,
    audit: ctx.audit,
    // Cross-process hand-off needs the same key in API and worker (TOKEN_CACHE_KEY); a random key works in-process.
    key: tokenCacheKey(ctx.config) ?? randomBytes(32),
    database: pg ? ctx.database : null,
    listenUrl: pg ? (ctx.config.DATABASE_URL ?? null) : null,
    serve: opts.serveSecrets ?? true,
    ...(opts.secretTtlMs ? { ttlMs: opts.secretTtlMs } : {}),
    ...(log ? { log } : {}),
  });
  const identity = new SessionIdentityResolver(repo, ctx.sessions, ctx.config, ctx.now);
  const holder: { engine?: Engine } = {};
  const children = new RunChildRunner({ repo, store, identity, definitions, engine: () => holder.engine!, audit: ctx.audit, env, now: ctx.now });
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
  const worker = new RunWorker({ repo, queue, engine, store, identity, definitions, bus, now: ctx.now, ...(log ? { log } : {}) });
  const service = new RunService({ repo, queue, store, definitions, audit: ctx.audit, env, now: ctx.now });

  let started = false;
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
    async start() {
      if (started) return;
      started = true;
      await secrets.start();
      if (consuming) await worker.start(opts.workerConcurrency ?? 4, { sweep: opts.sweep ?? !testing });
    },
    async stop() {
      started = false;
      await worker.stop();
      await queue.stop();
      await bus.stop();
      await secrets.stop();
    },
  };
}
