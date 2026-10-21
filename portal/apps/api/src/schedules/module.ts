import type { Connection } from '@adminforge/schemas';
import { loadEnv } from '@adminforge/config';
import { deliveryEnv, notifyApprovers, type DeliveryDeps } from '../delivery/notifier';
import { randomUUID } from 'node:crypto';
import { componentHealth, Heartbeat } from '../health/heartbeat';
import { ArtifactStore } from '../artifacts/store';
import type { AppContext } from '../context';
import { fixtureFetch } from '../datasources/services';
import { createNewsService, type NewsOptions } from '../news/module';
import type { NewsService } from '../news/service';
import type { ProbeDeps } from '../probes/checks';
import { createFixtureNetwork } from '../probes/fixture-network';
import { ProbeViews } from '../probes/views';
import type { RunsModule } from '../runs/module';
import { automationGraph, CreatorAccess, type CreatorAccessChecker } from './creator-access';
import { ScheduleEvents } from './events';
import {
  MemoryScheduleGrantStore,
  SqliteScheduleGrantStore,
  ScheduleIdentities,
  type ScheduleGrantStore,
} from './grants';
import { createJobRunner, type JobRunner } from './jobs';
import { LeaderElector, leaseLock, type LeaderLock, type Timers } from './leader';
import { SqliteScheduleStore } from './sqlite-store';
import { Scheduler } from './scheduler';
import { PortalSchedules } from './portal';
import { ScheduleService } from './service';
import { automationFingerprint } from '../runs/fingerprint';
import { isPaused } from '../execution/emergency';
import { MemoryScheduleStore, type ScheduleStore } from './store';

declare module 'fastify' {
  interface FastifyInstance {
    schedules: SchedulesModule;
  }
}

type Log = {
  info?(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error?(obj: object, msg: string): void;
};

export interface SchedulesOptions {
  store?: ScheduleStore;
  /** Run the scheduler in this process. Default: yes outside tests (the API is the scheduler, ADR-016). */
  inProcess?: boolean;
  /** Leader lock (default: the database's scheduler lease when there is a database; none otherwise). */
  lock?: LeaderLock | null;
  leaderIntervalMs?: number;
  jobs?: JobRunner;
  timers?: Timers;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  probeDeps?: Partial<ProbeDeps>;
  log?: Log;
  /** Tests: email/Teams delivery overrides. */
  delivery?: Partial<DeliveryDeps>;
  /** News and changes: a ready service, or options for the default one. */
  news?: NewsService | NewsOptions;
  /**
   * Portal schedules' creator check before each run (default: Graph as the automation identity when users sign in
   * with Entra; none in mock mode). Tests inject a fake.
   */
  creatorAccess?: CreatorAccessChecker | null;
  /** Creators' grants for schedules that run with their own access (default: the database, else memory). */
  grants?: ScheduleGrantStore;
}

export interface SchedulesModule {
  store: ScheduleStore;
  events: ScheduleEvents;
  artifacts: ArtifactStore;
  service: ScheduleService;
  /** Report schedules created in the portal (POST/PUT/DELETE /api/schedules, delivery options). */
  portal: PortalSchedules;
  /** Who schedules run as (ADR-014): app identities, creators' grants (consent, renewal, removal). */
  identities: ScheduleIdentities;
  probes: ProbeViews;
  /** Dependencies for running probes directly (CLI one-shots). */
  probeDeps: ProbeDeps;
  /** Email/Teams delivery as resolved here (overrides on the defaults; the fixture fetch with DATA_MODE=fixtures). */
  delivery: DeliveryDeps;
  jobs: JobRunner;
  /** The scheduler, when it runs in this process. */
  scheduler: Scheduler | null;
  /** News and changes (collection for the `news` job; reads for /api/news). */
  news: NewsService;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Wires the scheduler feature (R6): store (SQLite or memory), events, artifacts, the job runner, the API service,
 * probe views and — in the API process (ADR-016; not in tests or one-shots) — the scheduler itself behind leader
 * election.
 */
export function createSchedulesModule(
  ctx: AppContext,
  runs: RunsModule | null,
  opts: SchedulesOptions = {},
): SchedulesModule {
  const log = opts.log;
  const store =
    opts.store ??
    (ctx.database ? new SqliteScheduleStore(ctx.database.db) : new MemoryScheduleStore(ctx.now));
  const events = new ScheduleEvents({
    bus: ctx.events,
    signals: ctx.database?.signals ?? null,
    ...(log ? { log } : {}),
  });
  const artifacts = new ArtifactStore(ctx.config.ADMINFORGE_ARTIFACTS_DIR);
  const identities = new ScheduleIdentities({
    grants:
      opts.grants ??
      (ctx.database ? new SqliteScheduleGrantStore(ctx.database.db) : new MemoryScheduleGrantStore()),
    auth: ctx.auth,
    tokenCache: ctx.tokenCache,
    now: ctx.now,
  });
  // DATA_MODE=fixtures: HTTP, DNS and TLS checks answer from the fixtures directory and never touch the network.
  const offline =
    ctx.config.DATA_MODE === 'fixtures'
      ? createFixtureNetwork({
          dir: ctx.config.ADMINFORGE_FIXTURES_DIR,
          publicBaseUrl: ctx.config.PUBLIC_BASE_URL,
          now: ctx.now,
        })
      : null;
  const probeDeps: ProbeDeps = {
    outbound: ctx.outbound,
    automation: ctx.automation,
    connection: async (key) => (await ctx.definitions.resolve('connection', key)).def as Connection,
    licences: ctx.licences,
    env: () => ({ ...ctx.contentEnv(), PUBLIC_BASE_URL: ctx.config.PUBLIC_BASE_URL }),
    now: ctx.now,
    spoTenantName: ctx.config.AF_SPO_TENANT_NAME,
    fetch: offline?.fetch ?? ctx.fetch,
    ...(offline ? { lookup: offline.lookup, dns: offline.dns, tls: offline.tls } : {}),
    audit: ctx.audit,
    ...opts.probeDeps,
  };
  // Email/Teams delivery reads recipients and webhooks from configuration (never content, never expressions) — and
  // only the delivery keys of it (recipient lists, webhooks, the sender), never the rest (secrets, paths).
  const delivery: DeliveryDeps = {
    outbound: ctx.outbound,
    // DATA_MODE=fixtures: Teams webhooks get the fixture fetch too (e-mail already goes through the fixture outbound).
    fetch: offline ? fixtureFetch(ctx.config) : ctx.fetch,
    env: ctx.config.NODE_ENV === 'test' ? {} : deliveryEnv(loadEnv()),
    publicBaseUrl: ctx.config.PUBLIC_BASE_URL,
    ...opts.delivery,
  };
  const news =
    opts.news && 'refresh' in opts.news
      ? opts.news
      : createNewsService(ctx, (opts.news as NewsOptions | undefined) ?? {}, log);
  const jobs =
    opts.jobs ??
    createJobRunner({
      news,
      onNews: (counts) => events.publish({ type: 'news.updated', data: counts }),
      delivery,
      definitions: ctx.definitions,
      store,
      outbound: probeDeps.outbound,
      probes: probeDeps,
      datasources: ctx.datasources,
      artifacts,
      runs: runs ? { service: runs.service, repo: runs.repo } : null,
      automationClientId: ctx.automation?.clientId ?? null,
      identityClientIds: Object.fromEntries(
        (ctx.config.SCHEDULE_IDENTITIES ?? []).map((i) => [i.name, i.clientId]),
      ),
      exportMaxRows: ctx.config.EXPORT_MAX_ROWS,
      now: ctx.now,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(log ? { log } : {}),
      onProbe: (o) =>
        events.publish({
          type: 'probe.updated',
          data: { key: o.probeKey, status: o.status, metric: o.metric, ts: o.ts.toISOString() },
        }),
    });
  const inProcess = opts.inProcess ?? ctx.config.NODE_ENV !== 'test';
  // The scheduler's heartbeat for /readyz and the Schedules list: written from its ticks, not a timer (D-09).
  const heartbeatDb = inProcess && ctx.config.NODE_ENV !== 'test' ? (ctx.database?.db ?? null) : null;
  const heartbeat = heartbeatDb
    ? new Heartbeat(heartbeatDb, 'scheduler', ctx.now, (err) =>
        log?.warn({ err }, 'scheduler heartbeat failed'),
      )
    : null;
  const service = new ScheduleService({
    store,
    grants: identities.grants,
    automationPaused: () => isPaused(ctx.settings, 'automation'),
    definitions: ctx.definitions,
    audit: ctx.audit,
    events,
    artifacts,
    now: ctx.now,
    ...(heartbeatDb
      ? { schedulerHealth: async () => (await componentHealth(heartbeatDb, ctx.now())).scheduler }
      : {}),
    notifyApprovers: async (r) => {
      await notifyApprovers(
        delivery,
        { title: r.title, requestedBy: r.requestedBy, path: '/approvals' },
        randomUUID(),
      );
    },
    // The same fingerprint scheduled runs check (playbooks, children and the connections they call).
    fingerprint: (ref) =>
      runs
        ? runs.service.fingerprint(ref)
        : automationFingerprint(
            (r, v) => ctx.definitions.resolveAny(['playbook', 'runbook'], r, v),
            ref,
            async (key) => ctx.definitions.resolve('connection', key),
          ),
  });
  const portal = new PortalSchedules({
    service,
    store,
    definitions: ctx.definitions,
    datasources: ctx.datasources,
    audit: ctx.audit,
    // Only key names are checked against it (configured or not); values are never returned.
    deliveryEnv: () => delivery.env,
    now: ctx.now,
    identities: {
      // The configured names (their credentials are checked when a run needs a token).
      apps: () => (ctx.config.SCHEDULE_IDENTITIES ?? []).map((i) => i.name),
      // A creator's own access needs Entra sign-in (the consent round trip and token refresh).
      user: ctx.auth !== null && ctx.config.AUTH_MODE === 'entra',
      removeGrant: (id) => identities.remove(id),
    },
  });
  // Run views of scheduled runs follow the schedule's `requires.portalRoles` (default Portal.Operator).
  runs?.service.useSchedules(
    async (id) => (await store.getScheduleById(id))?.definition.requires?.portalRoles ?? null,
  );
  const probes = new ProbeViews({ store, definitions: ctx.definitions, now: ctx.now });

  let scheduler: Scheduler | null = null;
  if (inProcess) {
    const lock = opts.lock !== undefined ? opts.lock : ctx.database ? leaseLock(ctx.database) : null;
    const leader = lock
      ? new LeaderElector(lock, {
          intervalMs: opts.leaderIntervalMs ?? 5_000,
          ...(opts.timers ? { timers: opts.timers } : {}),
          ...(log ? { log } : {}),
          onElected: () => scheduler!.elected(),
          onDemoted: (reason) => scheduler!.demoted(reason),
        })
      : null;
    // Like the sessions' role re-check: only with Entra sign-in (mock mode has no directory to ask).
    const creatorAccess =
      opts.creatorAccess !== undefined
        ? opts.creatorAccess
        : ctx.auth
          ? new CreatorAccess({
              graph: automationGraph(ctx.outbound),
              readClientId: ctx.config.AF_READ_CLIENT_ID,
              now: ctx.now,
            })
          : null;
    scheduler = new Scheduler({
      store,
      creatorAccess,
      identities,
      definitions: ctx.definitions,
      jobs,
      audit: ctx.audit,
      events,
      now: ctx.now,
      concurrency: ctx.config.SCHEDULER_CONCURRENCY,
      leader,
      delivery,
      // Emergency stop (Admin → Settings): no schedule fires while automation is paused.
      automationPaused: () => isPaused(ctx.settings, 'automation'),
      ...(heartbeat ? { onProgress: () => heartbeat.progress() } : {}),
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
    portal,
    identities,
    probes,
    probeDeps,
    delivery,
    jobs,
    scheduler,
    news,
    async start() {
      if (started) return;
      started = true;
      await events.start();
      await scheduler?.start();
      // Mock mode and e2e (fixtures): collect once at start so News and changes has items before the first hourly run.
      if (ctx.config.DATA_MODE === 'fixtures' && ctx.config.NODE_ENV !== 'test')
        void news
          .seedIfEmpty()
          .catch((err: unknown) =>
            log?.warn({ err: { message: (err as Error).message } }, 'news seed failed'),
          );
    },
    async stop() {
      if (!started) return;
      started = false;
      await scheduler?.stop();
      await events.stop();
    },
  };
}
