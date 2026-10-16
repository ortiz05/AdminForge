import { createContext, type Config, type DeliveryDeps, type AppContext } from '@adminforge/api/tooling';
import {
  createRunsModule,
  createSchedulesModule,
  runProbe,
  Scheduler,
  type ProbeOutcome,
  type RunsModule,
  type ScheduleRunRow,
  type SchedulerOptions,
  type SchedulesModule,
} from '@adminforge/api/tooling/scheduler';
import type { Probe } from '@adminforge/schemas';

/**
 * One-shot runs as the automation identity: one schedule now, or probes now, without the leader lock — and the
 * status lines they print. Shared by the scheduler service's one-shot flags (`main.ts --schedule/--probe/--once`) and
 * the live script `tests/live/scripts/run-schedule-once.ts`, which adds its own safety guards (dev database only, no
 * playbook schedules) and a delivery override so no real recipient gets mail.
 *
 * - `openOneShot(config, opts)` wires the process (context, runs module without a worker, schedules module without
 *   the in-process scheduler) and returns `runSchedule`, `runProbes` and `close`.
 * - `runScheduleOnce` / `runProbesOnce` take only the pieces they use, so tests drive them with fakes.
 * - `scheduleRunLines` / `probeLine` / `probeSummary` are pure formatters. They print keys, statuses, reason codes and
 *   counts only — never messages, details, recipients or item contents, which can hold tenant data.
 */

/** The log the one-shot reports through (the service's JSON log, or the live script's masked stderr). */
export interface OneShotLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface OneShotOptions {
  log: OneShotLog;
  /** No database: probe results are not stored, and schedules can't run (their state lives in Postgres). */
  noStore?: boolean;
  /**
   * Email/Teams delivery override for this process: report delivery (the jobs) and `notify.onFailure`/`onSuccess`
   * (the scheduler). `env` — what `${ env.X }` recipient lists, webhooks and the sender resolve to — is the point of
   * an override; `outbound`, `fetch` and `publicBaseUrl` default to the process's own. Absent, jobs deliver from the
   * installation's configuration and a one-shot schedule run sends no notifications (audit log and portal event
   * only) — the service's behaviour.
   */
  delivery?: Pick<DeliveryDeps, 'env'> & Partial<DeliveryDeps>;
}

export interface OneShot {
  ctx: AppContext;
  runs: RunsModule;
  schedules: SchedulesModule;
  /** Runs one schedule now as a manual, audited run; `requestedBy` is recorded on it (`cli:<user>`, …). */
  runSchedule(key: string, requestedBy: string): Promise<ScheduleRunRow>;
  /** Runs every probe, or the named ones, now; results are stored unless `noStore` or there is no database. */
  runProbes(keys?: readonly string[]): Promise<ProbesOnceResult>;
  /** Stops the modules and closes the event bus, definition source and database (errors ignored: shutting down). */
  close(): Promise<void>;
}

/** Wires a one-shot process from the configuration (see the module comment). */
export function openOneShot(config: Config, opts: OneShotOptions): OneShot {
  const { log } = opts;
  const ctx = createContext(config, opts.noStore ? { database: null } : {}, { warn: log.warn });
  const delivery: DeliveryDeps | undefined = opts.delivery && {
    outbound: ctx.outbound,
    fetch: ctx.fetch,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    ...opts.delivery,
  };
  // Scheduled playbook runs are enqueued for the run worker (ROLE=worker); a one-shot never executes them itself.
  const runs = createRunsModule(ctx, { inProcessWorker: false, log });
  const schedules = createSchedulesModule(ctx, runs, {
    inProcess: false,
    log,
    ...(delivery ? { delivery } : {}),
  });
  return {
    ctx,
    runs,
    schedules,
    runSchedule: (key, requestedBy) =>
      runScheduleOnce({ ctx, schedules, log, ...(delivery ? { delivery } : {}) }, key, requestedBy),
    runProbes: (keys) =>
      runProbesOnce(
        {
          definitions: ctx.definitions,
          probeDeps: schedules.probeDeps,
          store: !opts.noStore && ctx.database ? schedules.store : null,
          log,
        },
        keys,
      ),
    close: async () => {
      await schedules.stop().catch(() => undefined);
      await runs.stop().catch(() => undefined);
      await ctx.events.close().catch(() => undefined);
      await ctx.definitions.close().catch(() => undefined);
      await ctx.database?.close().catch(() => undefined);
    },
  };
}

export interface ScheduleOnceDeps {
  ctx: { definitions: SchedulerOptions['definitions']; audit: SchedulerOptions['audit']; now: () => Date };
  schedules: Pick<SchedulesModule, 'store' | 'jobs' | 'events'>;
  log: OneShotLog;
  /** Delivery for notify.onFailure/onSuccess (see OneShotOptions.delivery). */
  delivery?: DeliveryDeps;
}

/**
 * One schedule now: a scheduler object built on the module's pieces (a one-shot needs no leadership), then
 * `Scheduler.runOnce` — the same path as "Run now" in the portal, audited as a manual run.
 */
export async function runScheduleOnce(
  deps: ScheduleOnceDeps,
  key: string,
  requestedBy: string,
): Promise<ScheduleRunRow> {
  const scheduler = new Scheduler({
    store: deps.schedules.store,
    definitions: deps.ctx.definitions,
    jobs: deps.schedules.jobs,
    audit: deps.ctx.audit,
    events: deps.schedules.events,
    now: deps.ctx.now,
    log: deps.log,
    ...(deps.delivery ? { delivery: deps.delivery } : {}),
  });
  return scheduler.runOnce(key, requestedBy);
}

export interface ProbesOnceDeps {
  definitions: Pick<AppContext['definitions'], 'list'>;
  probeDeps: SchedulesModule['probeDeps'];
  /** Where results are stored; null = not stored. */
  store: Pick<SchedulesModule['store'], 'insertProbeResult'> | null;
  log: Pick<OneShotLog, 'warn'>;
  /** Tests: the probe runner (default: the API's `runProbe`). */
  run?: typeof runProbe;
}

export interface ProbeRun {
  key: string;
  /** The check kind (`graph`, `kql`, `http`, …), for the status line. */
  kind: string;
  outcome: ProbeOutcome;
}

export interface ProbesOnceResult {
  /** One entry per probe run, sorted by key. */
  results: ProbeRun[];
  /** Requested keys that name no published probe. */
  missing: string[];
  /** Outcomes per status (ok, warn, crit, error are always present). */
  counts: Record<string, number>;
}

/**
 * Probes now: every published probe, or only `keys` (unknown keys are returned in `missing`, not run). A result that
 * can't be stored is logged and the run goes on — the outcome is still printed.
 */
export async function runProbesOnce(
  deps: ProbesOnceDeps,
  keys?: readonly string[],
): Promise<ProbesOnceResult> {
  const run = deps.run ?? runProbe;
  const all = await deps.definitions.list('probe');
  const wanted = keys?.length ? all.filter((r) => keys.includes(r.key)) : all;
  const missing = [...new Set(keys ?? [])].filter((k) => !all.some((r) => r.key === k));
  const counts: Record<string, number> = { ok: 0, warn: 0, crit: 0, error: 0 };
  const results: ProbeRun[] = [];
  for (const rec of [...wanted].sort((a, b) => a.key.localeCompare(b.key))) {
    const probe = rec.def as Probe;
    const outcome = await run(rec.key, probe, deps.probeDeps, {});
    counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
    results.push({ key: rec.key, kind: probe.check.kind, outcome });
    if (deps.store)
      await deps.store
        .insertProbeResult({
          probeKey: rec.key,
          ts: outcome.ts,
          status: outcome.status,
          metric: outcome.metric,
          durationMs: outcome.durationMs,
          message: outcome.message.slice(0, 2000),
          details: outcome.details,
          scheduleRunId: null,
        })
        .catch((err: unknown) =>
          deps.log.warn({ err: { message: (err as Error).message } }, 'could not store the probe result'),
        );
  }
  return { results, missing, counts };
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/** Result fields printed as `name=count` on a schedule run's first line, in this order. */
const COUNT_FIELDS = [
  'probes',
  'feeds',
  'ok',
  'warn',
  'crit',
  'error',
  'failed',
  'skipped',
  'new',
  'updated',
];

const list = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '?');

/**
 * Status lines for a schedule run: `<key>: <status> (counts) — <error code>`, then per report file its format and row
 * count, per delivery its type and status, per probe or feed its key, status, reason code (and feed item counts), and
 * a playbook schedule's run status.
 */
export function scheduleRunLines(
  key: string,
  run: Pick<ScheduleRunRow, 'status' | 'result' | 'error'>,
): string[] {
  const r = run.result ?? {};
  const counts = COUNT_FIELDS.filter((k) => typeof r[k] === 'number').map((k) => `${k}=${r[k] as number}`);
  const lines = [
    `${key}: ${run.status}${counts.length ? ` (${counts.join(' ')})` : ''}${run.error ? ` — ${run.error.code}` : ''}`,
  ];
  for (const a of list(r.artifacts))
    lines.push(
      `  file ${text(a.format)}: ${text(a.rows)} row(s)${a.truncated === true ? ' (truncated)' : ''}`,
    );
  for (const d of list(r.delivery)) lines.push(`  delivery ${text(d.type)}: ${text(d.status)}`);
  for (const p of list(r.results))
    lines.push(
      `  ${pad(text(p.key), 48)} ${pad(text(p.status), 8)} ${pad(text(p.code), 20)}${
        typeof p.new === 'number'
          ? ` new=${p.new} updated=${typeof p.updated === 'number' ? p.updated : 0}`
          : ''
      }`,
    );
  if (typeof r.runStatus === 'string')
    lines.push(`  playbook run (run worker): ${r.runStatus}${r.dryRun === true ? ' (dry run)' : ''}`);
  return lines;
}

/** Column headings for `probeLine`. */
export const PROBE_HEADER = `${pad('probe', 48)} ${pad('kind', 20)} ${pad('status', 6)} ${pad('code', 20)} ${pad('metric', 16)} duration`;

/** One line per probe: key, check kind, status, reason code, metric and duration. */
export function probeLine({ kind, outcome: o }: Pick<ProbeRun, 'kind' | 'outcome'>): string {
  const metric = o.metric === null ? '-' : `${Math.round(o.metric * 10) / 10} ${o.unit}`;
  return `${pad(o.probeKey, 48)} ${pad(kind, 20)} ${pad(o.status, 6)} ${pad(o.code, 20)} ${pad(metric, 16)} ${o.durationMs} ms`;
}

/** `<n> probes: ok=… warn=… crit=… error=…`. */
export function probeSummary({ results, counts }: Pick<ProbesOnceResult, 'results' | 'counts'>): string {
  return `${results.length} probes: ${Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')}`;
}

/** True when a probe run should fail a one-shot command (`crit` or `error`). */
export const probeFailed = (o: Pick<ProbeOutcome, 'status'>) => o.status === 'crit' || o.status === 'error';
