/**
 * The restart harness for the D-01 suites (run-shutdown-resume-db, run-lock-lost-db): API processes on one SQLite
 * file — each `boot()` is a process with its own connection, `run_jobs` queue and in-process worker — so a test can
 * stop one (`app.close()`, what SIGTERM does) and start the next, then read what the database holds with `probe`.
 * Microsoft is faked by `HoldingOutbound`: a call to `/things/<hold>` stays in flight until released (or, unless
 * `ignoreAbort`, until the step's signal aborts).
 *
 * Sessions live in the database in production, so they outlast a restart; one in-memory store shared by every
 * process stands in for that here. Synthetic people and paths only.
 */
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { MemorySessionStore } from '@adminforge/api/src/auth/session-store';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { SqliteRunQueue, SqliteRunRepository } from '@adminforge/api/src/runs';
import { testDatabasePath } from './db';
import { Clock, mockConfig } from './helpers';
import { AVERY, StaticDefinitions } from './runs-helpers';
import { buildTestApp, sessionFor } from './support/app';

export const OPERATOR = ['Portal.Reader', 'Portal.Operator'];

export const write = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'graph',
  mode: 'write',
  describe: `Write ${id}`,
  request: { method: 'PATCH', path: `/things/${id}`, body: { value: id } },
  ...extra,
});

export const playbook = (id: string, steps: unknown[]) =>
  ({
    kind: 'playbook',
    id,
    version: '1.0.0',
    title: `Playbook ${id}`,
    owner: 'tests',
    risk: 'low',
    mode: 'write',
    steps,
  }) as never;

/** Microsoft, faked: records `METHOD path`; a call to `/things/<hold>` stays in flight (see the module comment). */
export class HoldingOutbound implements OutboundExecutor {
  readonly calls: string[] = [];
  hold: string | null = null;
  /** A stalled call that doesn't notice the abort (it answers only when released). */
  ignoreAbort = false;
  inFlight = 0;
  private releases: Array<() => void> = [];
  async execute<T>(_identity: ExecutionIdentity, call: ServiceCall, opts: { signal?: AbortSignal } = {}) {
    this.calls.push(`${call.method} ${call.path}`);
    if (this.hold && call.path === `/things/${this.hold}`) {
      this.inFlight++;
      try {
        await new Promise<void>((resolve, reject) => {
          this.releases.push(resolve);
          if (!this.ignoreAbort)
            opts.signal?.addEventListener('abort', () => reject(new Error('The request was aborted.')));
        });
      } finally {
        this.inFlight--;
      }
    }
    return {
      data: { ok: true } as T,
      status: 200,
      provenance: { service: call.service, path: call.path, ms: 1, requestId: `req-${this.calls.length}` },
    };
  }
  /** Answers every held call. */
  release() {
    for (const r of this.releases.splice(0)) r();
  }
}

export async function until(check: () => boolean | Promise<boolean>, ms = 8_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export interface BootOptions {
  /** The SQLite queue's grace before it interrupts what is still running (default 300 ms). */
  graceMs?: number;
  /** The run repository's clock (the run lock's lease follows it). */
  now?: () => Date;
  lockTtlMs?: number;
  lockRenewMs?: number;
  /** What this process has published (default: the kit's definitions). */
  definitions?: StaticDefinitions;
}

/** A database file and the processes that share it. Call `close()` in afterEach. */
export async function restartKit(definitions: () => StaticDefinitions) {
  const file = await testDatabasePath();
  const sessions = new MemorySessionStore();
  const clock = new Clock();
  const outbound = new HoldingOutbound();
  const probe: Database = createDatabase(file, { name: 'probe' });

  /** One API process on the file. */
  async function boot(o: BootOptions = {}) {
    const database = createDatabase(file);
    const repository = new SqliteRunRepository(database, o.now, {
      ...(o.lockTtlMs ? { lockTtlMs: o.lockTtlMs } : {}),
      ...(o.lockRenewMs ? { lockRenewMs: o.lockRenewMs } : {}),
    });
    const queue = new SqliteRunQueue(database, undefined, {
      pollMs: 20,
      gracefulMs: o.graceMs ?? 300,
      busyDelayMs: 20,
      retryDelayMs: 20,
    });
    const { app } = await buildTestApp(mockConfig({ DATABASE_PATH: file }), {
      clock,
      audit: new MemoryAuditWriter(clock.now),
      deps: {
        database,
        sessions,
        runs: {
          definitions: o.definitions ?? definitions(),
          outbound,
          queue,
          repository,
          inProcessWorker: true,
          sweep: false,
        },
      },
    });
    await app.ready();
    return { app, repository, database };
  }

  /** Starts `key` as Avery (armed); returns once the step `hold` is in flight. */
  async function startHeld(
    target: { app: Awaited<ReturnType<typeof boot>>['app'] },
    key: string,
    hold: string,
  ) {
    const avery = await sessionFor({ app: target.app, sessions, clock }, AVERY, OPERATOR, { armed: true });
    outbound.hold = hold;
    const res = await avery.post('/api/runs', { playbook: key, inputs: {} });
    if (res.statusCode !== 202) throw new Error(`POST /api/runs answered ${res.statusCode}: ${res.body}`);
    const { runId } = res.json() as { runId: string };
    await until(() => outbound.inFlight === 1);
    return { runId, avery };
  }

  const rows = <T>(query: string, ...params: unknown[]) => probe.sqlite.prepare(query).all(...params) as T[];
  const events = (id: string, type: string) =>
    rows<{ data: string }>(
      'select data from run_step_events where run_id = ? and type = ? order by id',
      id,
      type,
    ).map((e) => JSON.parse(e.data) as Record<string, unknown>);
  const steps = (id: string) =>
    rows<{ stepId: string; status: string; attempt: number; error: string | null }>(
      'select step_id as stepId, status, attempt, error from run_steps where run_id = ? order by seq',
      id,
    );

  return {
    file,
    sessions,
    clock,
    outbound,
    probe,
    boot,
    startHeld,
    run: (id: string) =>
      probe.sqlite.prepare('select status, error from runs where id = ?').get(id) as {
        status: string;
        error: string | null;
      },
    children: (id: string) =>
      rows<{ id: string; status: string }>('select id, status from runs where parent_run_id = ?', id),
    steps,
    /** Latest status per step id. */
    latest: (id: string) => Object.fromEntries(steps(id).map((s) => [s.stepId, s.status])),
    jobs: (id: string) => rows<{ state: string }>('select state from run_jobs where run_id = ?', id),
    /** Run statuses the run's events recorded, in order. */
    runStatuses: (id: string) =>
      events(id, 'status')
        .filter((d) => d.scope === 'run')
        .map((d) => d.status as string),
    logs: (id: string) => events(id, 'log').map((d) => String(d.message)),
    close: () => probe.close(),
  };
}
