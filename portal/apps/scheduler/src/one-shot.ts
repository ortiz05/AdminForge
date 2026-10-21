import { randomUUID } from 'node:crypto';
import {
  createContext,
  type AppContext,
  type AuditInput,
  type Config,
  type DeliveryDeps,
} from '@adminforge/api/tooling';
import {
  AppError,
  createRunsModule,
  createSchedulesModule,
  isPaused,
  runProbe,
  Scheduler,
  type ProbeOutcome,
  type RunsModule,
  type ScheduleRunRow,
  type SchedulerOptions,
  type SchedulesModule,
} from '@adminforge/api/tooling/scheduler';
import { PROBE_METRICS, TRANSACTION_KINDS, type Probe, type Schedule } from '@adminforge/schemas';

/**
 * One-shot runs as the automation identity: one schedule now, or probes now, without the leader lock — and the
 * status lines they print. Shared by the scheduler's one-shot flags (`main.ts --schedule/--probe/--once`) and
 * the live script `tests/live/scripts/run-schedule-once.ts`, which adds its own safety guards (dev database only, no
 * playbook schedules) and a delivery override so no real recipient gets mail.
 *
 * - `openOneShot(config, opts)` wires the process (context, runs module without a worker, schedules module without
 *   the in-process scheduler) and returns `runSchedule`, `runProbes` and `close`.
 * - `runScheduleOnce` / `runProbesOnce` take only the pieces they use, so tests drive them with fakes.
 * - `scheduleRunLines` / `probeLine` / `probeSummary` are pure formatters. They print keys, statuses, reason codes and
 *   counts only — never messages, details, recipients or item contents, which can hold tenant data.
 *
 * Synthetic transactions (ADR-015) are the one-shots' only writes. They follow the emergency stop: none runs while
 * automation is paused, and changes paused refuses their writes (the outbound executor). One that acted is audited as a
 * write, as the scheduler audits a run with them, and a schedule turned off doesn't run them. Without the database a
 * one-shot can read neither switch nor keep an audit record, so every declared write its probes and jobs would send is
 * refused, and a schedule runs only on fixture data (`database_required`, security review L1).
 */

/** The log the one-shot reports through (the service's JSON log, or the live script's masked stderr). */
export interface OneShotLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface OneShotOptions {
  log: OneShotLog;
  /**
   * No database: probe results are not stored and no change is made (without the database the emergency stop can't be
   * read nor an audit record kept); a schedule runs only on fixture data (in-memory state, nothing delivered for real).
   */
  noStore?: boolean;
  /**
   * Email/Teams delivery override for this process: report delivery (the jobs) and `notify.onFailure`/`onSuccess`
   * (the scheduler). `env` — what `${ env.X }` recipient lists, webhooks and the sender resolve to — is the point of
   * an override; `outbound`, `fetch` and `publicBaseUrl` default to the schedules module's (the fixture fetch with
   * DATA_MODE=fixtures). Absent, jobs deliver from the installation's configuration and a one-shot schedule run sends
   * no notifications (audit log and portal event only) — the service's behaviour.
   */
  delivery?: Pick<DeliveryDeps, 'env'> & Partial<DeliveryDeps>;
}

export interface OneShot {
  ctx: AppContext;
  runs: RunsModule;
  schedules: SchedulesModule;
  /** Runs one schedule now as a manual, audited run; `requestedBy` is recorded on it (`cli:<user>`, …). */
  runSchedule(key: string, requestedBy: string): Promise<ScheduleRunRow>;
  /**
   * Runs every probe, or the named ones, now; results are stored unless `noStore` or there is no database. A synthetic
   * transaction that acted is audited for `requestedBy` (`cli:<user>`, …).
   */
  runProbes(keys?: readonly string[], requestedBy?: string): Promise<ProbesOnceResult>;
  /** Stops the modules and closes the event bus, definition source and database (errors ignored: shutting down). */
  close(): Promise<void>;
}

/** Wires a one-shot process from the configuration (see the module comment). */
export function openOneShot(config: Config, opts: OneShotOptions): OneShot {
  const { log } = opts;
  // `info` as well as `warn`: the outbound executor logs one `microsoft call` line per call at info (D-03a), so a
  // one-shot's calls can be traced by Reference like the API's.
  // The API alone moves the audit chain to a new key (S-10); a one-shot appends with the key of its newest part.
  const ctx = createContext(
    config,
    { ...(opts.noStore ? { database: null } : {}), prepareAuditChain: false },
    {
      warn: (obj, msg) => log.warn(obj, msg),
      info: (obj, msg) => log.info(obj, msg),
    },
  );
  // Scheduled playbook runs are queued for the run worker (the API process); a one-shot never executes them itself.
  const runs = createRunsModule(ctx, { inProcessWorker: false, log });
  const schedules = createSchedulesModule(ctx, runs, {
    inProcess: false,
    log,
    // Probes and jobs (synthetic transactions) make no change without the database: see the module comment.
    ...(ctx.database ? {} : { probeDeps: { outbound: refusingWrites(ctx.outbound) } }),
    ...(opts.delivery ? { delivery: opts.delivery } : {}),
  });
  // The override on the module's defaults — not the platform fetch, which would take mock mode onto the internet.
  const delivery: DeliveryDeps | undefined = opts.delivery && schedules.delivery;
  const automationPaused = () => isPaused(ctx.settings, 'automation');
  return {
    ctx,
    runs,
    schedules,
    runSchedule: async (key, requestedBy) => {
      // Without the database a run, its audit record and the emergency stop exist in this process only: with live data
      // it would deliver tenant data unrecorded. Fixture data (development, tests) stays offline.
      if (!ctx.database && ctx.config.DATA_MODE === 'live')
        throw new AppError(
          409,
          'database_required',
          'A schedule runs with the database: without it this one-shot can’t read the emergency stop or record the run.',
          { hint: 'Run it without --no-store (it needs DATABASE_PATH).' },
        );
      return runScheduleOnce(
        { ctx, schedules, log, automationPaused, ...(delivery ? { delivery } : {}) },
        key,
        requestedBy,
      );
    },
    runProbes: (keys, requestedBy) =>
      runProbesOnce(
        {
          definitions: ctx.definitions,
          probeDeps: schedules.probeDeps,
          store: !opts.noStore && ctx.database ? schedules.store : null,
          log,
          audit: ctx.audit,
          automationPaused,
          ...(requestedBy ? { requestedBy } : {}),
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
  /** "Automation paused" (Admin → Settings): the run is recorded as skipped, as the scheduler records one. */
  automationPaused?: () => Promise<boolean>;
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
  await refuseTurnedOffTransactions(deps, key);
  const scheduler = new Scheduler({
    store: deps.schedules.store,
    definitions: deps.ctx.definitions,
    jobs: deps.schedules.jobs,
    audit: deps.ctx.audit,
    events: deps.schedules.events,
    now: deps.ctx.now,
    log: deps.log,
    ...(deps.delivery ? { delivery: deps.delivery } : {}),
    ...(deps.automationPaused ? { automationPaused: deps.automationPaused } : {}),
  });
  return scheduler.runOnce(key, requestedBy);
}

/**
 * A schedule turned off doesn't run its synthetic transactions on demand (ADR-015), as **Run now** refuses it: turning
 * it off — say, because a test mailbox turned out to be in use — means it. A schedule not yet in the store counts as
 * off unless its content says `enabled: true`. `--probe` still runs them, to check them before turning one on.
 */
async function refuseTurnedOffTransactions(deps: ScheduleOnceDeps, key: string): Promise<void> {
  const row = await deps.schedules.store.getSchedule(key);
  const def =
    row?.definition ??
    ((await deps.ctx.definitions.list('schedule')).find((r) => r.key === key)?.def as Schedule | undefined);
  const enabled = row ? row.enabled : def?.enabled === true;
  if (!def || enabled || def.job.kind !== 'probe') return;
  const job = def.job;
  const probes = (await deps.ctx.definitions.list('probe')).filter((r) =>
    job.ref
      ? r.key === job.ref
      : job.refs
        ? job.refs.includes(r.key)
        : (job.select?.tags ?? []).every((t) => (r.def as Probe).tags?.includes(t)),
  );
  if (probes.some((r) => isTransaction(r.def as Probe)))
    throw new AppError(
      409,
      'schedule_disabled',
      'This schedule runs synthetic transactions, which send, upload or create on test objects, and it is turned off, so it can’t run now.',
      {
        hint: 'Turn it on first, once its test objects are set up (docs/operations.md › Synthetic transactions).',
      },
    );
}

export interface ProbesOnceDeps {
  definitions: Pick<AppContext['definitions'], 'list'>;
  probeDeps: SchedulesModule['probeDeps'];
  /** Where results are stored; null = not stored. */
  store: Pick<SchedulesModule['store'], 'insertProbeResult'> | null;
  log: Pick<OneShotLog, 'warn'>;
  /** Tests: the probe runner (default: the API's `runProbe`). */
  run?: typeof runProbe;
  /** Where a synthetic transaction that acted is recorded as a write (as the scheduler records a run with one). */
  audit?: { append(event: AuditInput): Promise<unknown> };
  /** "Automation paused" (Admin → Settings): synthetic transactions don't run while it is on. */
  automationPaused?: () => Promise<boolean>;
  /** Who asked (`cli:<user>`), for the audit record. */
  requestedBy?: string;
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
    const transaction = isTransaction(probe);
    const correlationId = randomUUID();
    const outcome =
      transaction && (await deps.automationPaused?.()) === true
        ? automationPausedOutcome(rec.key, probe)
        : await run(rec.key, probe, deps.probeDeps, { correlationId });
    if (transaction && !NO_CALL_CODES.has(outcome.code))
      await auditTransaction(deps, rec.key, probe, outcome, correlationId);
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

const isTransaction = (probe: Probe) => (TRANSACTION_KINDS as readonly string[]).includes(probe.check.kind);

/** Outcome codes of a synthetic transaction that made no change (schedules/jobs.ts, plus the two of one-shots). */
const NO_CALL_CODES = new Set([
  'not_configured',
  'content_error',
  'licence_required',
  'writes_paused',
  'automation_paused',
  'database_required',
]);

/** A synthetic transaction not run because automation is paused. */
function automationPausedOutcome(key: string, probe: Probe): ProbeOutcome {
  return {
    probeKey: key,
    ts: new Date(),
    status: 'error',
    metric: null,
    unit: PROBE_METRICS[probe.check.kind].unit,
    durationMs: 0,
    code: 'automation_paused',
    message:
      'Not run: an administrator has paused automation, and this synthetic transaction changes test objects. A Portal Admin can resume automation under Admin → Settings.',
    details: null,
  };
}

/** A synthetic transaction that acted, recorded as a write by the automation identity (ADR-015). */
async function auditTransaction(
  deps: ProbesOnceDeps,
  key: string,
  probe: Probe,
  outcome: ProbeOutcome,
  correlationId: string,
): Promise<void> {
  if (!deps.audit) return;
  const by = deps.requestedBy ?? 'a one-shot';
  await deps.audit
    .append({
      actorOid: 'automation',
      actorUpn: 'automation identity',
      mode: 'write',
      action: 'probe.run',
      targetType: 'probe',
      targetId: key,
      result: outcome.status === 'ok' || outcome.status === 'warn' ? 'success' : 'failure',
      correlationId,
      details: {
        summary: `Run once by ${by}, executed as automation identity.`,
        trigger: 'one-shot',
        requestedBy: deps.requestedBy ?? null,
        check: probe.check.kind,
        status: outcome.status,
        code: outcome.code,
      },
    })
    .catch((err: unknown) =>
      deps.log.warn(
        { err: { message: (err as Error).message } },
        'could not audit the synthetic transaction',
      ),
    );
}

/** The outbound executor of a one-shot without the database: every declared write is refused (module comment). */
function refusingWrites(outbound: AppContext['outbound']): AppContext['outbound'] {
  const refusal = () =>
    new AppError(
      409,
      'database_required',
      'This one-shot runs without the database, so it can’t read the emergency stop or keep an audit record: it makes no changes.',
      { hint: 'Run it without --no-store (it needs DATABASE_PATH).' },
    );
  return {
    execute: async (identity, call, opts) => {
      if (call.declaredWrite === true) throw refusal();
      return outbound.execute(identity, call, opts);
    },
    assertWritable: async () => {
      throw refusal();
    },
    ...(outbound.gate ? { gate: outbound.gate.bind(outbound) } : {}),
  };
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
