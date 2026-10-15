import { bulkDefinition, isTerminal, type AutomationDefinition, type Engine } from '@adminforge/engine';
import type { Playbook } from '@adminforge/schemas';
import type { DefinitionResolver } from '../definitions/types';
import type { RunEventBus } from './events';
import type { SessionIdentityResolver } from './identity';
import { RetryLater, type RunQueue } from './queue';
import type { RepositoryRunStore } from './store';
import type { RunRepository, RunRow } from './types';

type Log = {
  info?(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error?(obj: object, msg: string): void;
};

const SWEEP_MS = 60_000;
const STALE_MS = 10 * 60_000;

/** Resolves the root of a run tree (children are always driven by their root). */
export async function rootOf(repo: RunRepository, row: RunRow): Promise<RunRow> {
  let cur = row;
  for (let i = 0; i < 10 && cur.parentRunId; i++) {
    const p = await repo.getRun(cur.parentRunId);
    if (!p) break;
    cur = p;
  }
  return cur;
}

/** The pinned definition of a run: exact version, sha256 verified; bulk runs get their synthesised wrapper. */
export async function pinnedDefinition(
  definitions: DefinitionResolver,
  row: RunRow,
): Promise<AutomationDefinition> {
  const resolved = await definitions.resolve(row.kind, row.definitionKey, row.definitionVersion);
  if (resolved.sha256 !== row.definitionSha256) {
    throw Object.assign(
      new Error(
        `${row.definitionKey}@${row.definitionVersion} changed after this run was created (sha256 differs).`,
      ),
      { code: 'definition_changed' },
    );
  }
  if (row.trigger === 'bulk') {
    const opts = row.inputs as { concurrency?: number; stopOnError?: boolean };
    return bulkDefinition(resolved.def as Playbook, {
      ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
      ...(opts.stopOnError ? { stopOnError: true } : {}),
    });
  }
  return resolved.def as AutomationDefinition;
}

/**
 * Consumes run jobs: lock the run (one executor per run), load its pinned definition, let the engine drive it from
 * its checkpoint, and re-enqueue `wait` wake-ups. Cancellation arrives as a `run_events` notification and aborts the
 * in-flight step. A periodic sweep expires approvals and re-enqueues runs whose job was lost.
 */
export class RunWorker {
  private readonly active = new Map<string, AbortController>();
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      repo: RunRepository;
      queue: RunQueue;
      engine: Engine;
      store: RepositoryRunStore;
      identity: SessionIdentityResolver;
      definitions: () => DefinitionResolver;
      bus: RunEventBus;
      now: () => Date;
      log?: Log;
      /** Refreshes a session's delegated tokens (playbooks with `refreshTokens: true`). */
      refreshTokens?: (sessionHash: string) => Promise<void>;
    },
  ) {}

  async start(concurrency: number, opts: { sweep?: boolean } = {}): Promise<void> {
    this.unsubscribe = this.deps.bus.subscribe('*', (n) => {
      if (n.type === 'run' && n.status === 'cancelled') this.active.get(n.runId)?.abort();
    });
    await this.deps.bus.start();
    await this.deps.queue.work((runId, signal) => this.process(runId, signal), { concurrency });
    if (opts.sweep !== false) {
      this.timer = setInterval(
        () =>
          void this.sweep().catch((err) =>
            this.deps.log?.warn({ err: { message: (err as Error).message } }, 'run sweep failed'),
          ),
        SWEEP_MS,
      );
      this.timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    for (const ac of this.active.values()) ac.abort();
  }

  /** One job: drive `runId` (or its root) until it finishes or parks. */
  async process(runId: string, signal?: AbortSignal): Promise<void> {
    const { repo } = this.deps;
    let row = await repo.getRun(runId);
    if (!row) return;
    if (row.parentRunId) {
      const root = await rootOf(repo, row);
      if (root.id !== row.id) {
        if (!isTerminal(root.status)) await this.deps.queue.enqueue(root.id);
        return;
      }
    }
    if (isTerminal(row.status)) return;
    const lock = await repo.tryLock(runId);
    if (!lock) throw new RetryLater();
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    this.active.set(runId, ac);
    try {
      row = await repo.getRun(runId);
      if (!row || isTerminal(row.status)) return;
      let def: AutomationDefinition;
      try {
        def = await pinnedDefinition(this.deps.definitions(), row);
      } catch (err) {
        const code =
          (err as { code?: string }).code === 'definition_changed'
            ? 'definition_changed'
            : 'definition_unavailable';
        await this.deps.store.updateRun(
          runId,
          { status: 'failed', endedAt: this.deps.now(), error: { code, message: (err as Error).message } },
          ['queued', 'running', 'awaiting_approval', 'awaiting_input', 'awaiting_arm', 'awaiting_reauth'],
        );
        await this.deps.store.appendEvent(runId, {
          type: 'status',
          data: { scope: 'run', status: 'failed', error: { code, message: (err as Error).message } },
        });
        return;
      }
      this.deps.store.bind(runId, def);
      // `user.roles` for the initiator's first steps.
      if (row.identity === 'delegated')
        await this.deps.identity.liveSession(row.sessionHash).catch(() => null);
      const outcome = await this.deps.engine.execute(runId, def, { signal: ac.signal });
      if (outcome.wakeAt) await this.deps.queue.enqueue(runId, { startAfter: outcome.wakeAt });
      if (
        outcome.status === 'succeeded' &&
        def.refreshTokens &&
        !row.dryRun &&
        row.identity === 'delegated' &&
        row.sessionHash &&
        this.deps.refreshTokens
      )
        await this.deps
          .refreshTokens(row.sessionHash)
          .catch((err: unknown) => this.deps.log?.warn({ err, runId }, 'token refresh after run failed'));
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.active.delete(runId);
      await lock.release();
    }
  }

  /** Expires pending approvals and re-enqueues runs that look abandoned (queued/running without progress). */
  async sweep(): Promise<void> {
    const { repo, now } = this.deps;
    const t = now();
    for (const task of await repo.listTasks({ status: 'pending' })) {
      if (!task.expiresAt || task.expiresAt > t) continue;
      const updated = await repo.updateTask(task.id, { status: 'expired', decidedAt: t }, 'pending');
      if (!updated) continue;
      const run = await repo.getRun(task.subjectId);
      if (run) await this.deps.queue.enqueue((await rootOf(repo, run)).id);
    }
    for (const run of await repo.staleRuns(['queued', 'running'], new Date(t.getTime() - STALE_MS), 50)) {
      if (run.parentRunId) continue;
      await this.deps.queue.enqueue(run.id);
    }
  }
}
