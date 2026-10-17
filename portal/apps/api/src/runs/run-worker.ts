import {
  bulkDefinition,
  hasWriteSteps,
  isParked,
  isTerminal,
  type AutomationDefinition,
  type Engine,
  type RunError,
  type RunStatus,
  type RunStore,
} from '@adminforge/engine';
import type { Playbook } from '@adminforge/schemas';
import type { AuditWriter } from '../audit/writer';
import type { DefinitionResolver } from '../definitions/types';
import { AppError } from '../errors';
import type { RunEventBus } from './events';
import type { SessionIdentityResolver } from './identity';
import { RetryLater, type RunQueue } from './queue';
import { executedAs, type RepositoryRunStore } from './store';
import { RUN_STATUS_ACTIVE, type RunRepository, type RunRow } from './types';

type Log = {
  info?(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error?(obj: object, msg: string): void;
};

const SWEEP_MS = 60_000;
const STALE_MS = 10 * 60_000;
/** A run waiting for write access or a fresh sign-in is stopped after this long (IAM-02). */
export const PARKED_MAX_MS = 24 * 3_600_000;
const PARKED_ON_IDENTITY: readonly RunStatus[] = ['awaiting_arm', 'awaiting_reauth'];

/** The run can't continue: its playbook was updated, changed or retired after it started (IAM-02, ENG-07). */
export const runOutdated = (details: Record<string, unknown> = {}): RunError => ({
  code: 'run_outdated',
  message: 'This playbook changed after the run started.',
  hint: 'Start a new run.',
  details,
});

/** Whether any run in the tree has sent (or may have sent) a write. */
export async function wroteAnything(repo: RunRepository, tree: readonly RunRow[]): Promise<boolean> {
  const notSent: readonly string[] = ['waiting', 'planned', 'skipped', 'cancelled'];
  for (const r of tree)
    if (
      (await repo.listSteps(r.id)).some(
        (x) => x.mode === 'write' && x.type !== 'playbook' && !notSent.includes(x.status),
      )
    )
      return true;
  return false;
}

/**
 * The first unfinished run of `tree` whose pinned version is no longer the current published one (a newer version,
 * the same version republished with other content, or retired), else null. A parked run that hasn't changed anything
 * yet continues only on the current version, like starting one: an older version may lack roles, approvals or fixes
 * added since. Two exceptions, so a publish never strands work: a tree that already sent a write finishes on the
 * versions that started it (a half-done change is worse than an old one), and runbooks — checklists — carry on, since
 * every playbook they start runs its current version (children.ts).
 */
export async function outdatedRun(
  definitions: DefinitionResolver,
  repo: RunRepository,
  tree: readonly RunRow[],
): Promise<{ row: RunRow; current: string | null } | null> {
  if (await wroteAnything(repo, tree)) return null;
  for (const r of tree) {
    if (isTerminal(r.status) || r.kind === 'runbook') continue;
    let current: { version: string; sha256: string };
    try {
      current = await definitions.resolve(r.kind, r.definitionKey);
    } catch (err) {
      if (err instanceof AppError && err.status === 404) return { row: r, current: null };
      throw err;
    }
    if (current.version !== r.definitionVersion || current.sha256 !== r.definitionSha256)
      return { row: r, current: current.version };
  }
  return null;
}

/**
 * Ends every unfinished run of `tree` (root first) as failed with `error` and cancels their open approvals and
 * manual steps. With `expect`, the root must still be in one of those states (otherwise nothing changes: someone
 * resumed or cancelled it meanwhile). Ending a run audits `run.completed` through the store. Returns how many ended.
 */
export async function failTree(
  deps: { repo: RunRepository; store: RunStore },
  tree: readonly RunRow[],
  error: RunError,
  now: Date,
  expect: readonly RunStatus[] = RUN_STATUS_ACTIVE,
): Promise<number> {
  let ended = 0;
  for (const [i, r] of tree.entries()) {
    if (isTerminal(r.status)) continue;
    const updated = await deps.store.updateRun(
      r.id,
      { status: 'failed', endedAt: now, error },
      i === 0 ? expect : RUN_STATUS_ACTIVE,
    );
    if (!updated) {
      if (i === 0) return 0;
      continue;
    }
    ended++;
    await deps.store.appendEvent(r.id, { type: 'status', data: { scope: 'run', status: 'failed', error } });
    for (const t of await deps.repo.listTasks({ runId: r.id, status: 'pending' }))
      await deps.repo.updateTask(t.id, { status: 'cancelled', decidedAt: now }, 'pending');
  }
  return ended;
}

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
      /** Audits runs the sweep stops (`run.expired`). */
      audit?: AuditWriter;
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
      // A run that stopped (approval, input, arming, sign-in) continues only on the current version and only for
      // someone still allowed to run it (IAM-02).
      if (isParked(row.status) && !(await this.mayContinue(row, def))) return;
      this.deps.store.bind(runId, def);
      // `user.roles` for the initiator's first steps.
      if (row.identity === 'delegated')
        await this.deps.identity.liveSession(row.sessionHash, {}, row.initiatorOid).catch(() => null);
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

  /**
   * Before a parked root run continues: every unfinished run in its tree is still on the current published version
   * (else it fails `run_outdated`), and the initiator, while signed in, still holds the roles running it needs (else
   * it fails `forbidden`). A signed-out initiator is left to the engine, which parks the run for a new sign-in when
   * one of their steps comes up.
   */
  private async mayContinue(row: RunRow, def: AutomationDefinition): Promise<boolean> {
    const { repo, store, now } = this.deps;
    const tree = await repo.runTree(row.id);
    const stale = await outdatedRun(this.deps.definitions(), repo, tree);
    if (stale) {
      await failTree(
        { repo, store },
        tree,
        runOutdated({
          definition: stale.row.definitionKey,
          version: stale.row.definitionVersion,
          current: stale.current,
        }),
        now(),
      );
      return false;
    }
    if (row.identity !== 'delegated') return true;
    const session = await this.deps.identity
      .liveSession(row.sessionHash, {}, row.initiatorOid)
      .catch(() => null);
    if (!session) return true;
    const needs = [
      ...(def.requires?.portalRoles ?? []),
      ...(!row.dryRun && (def.mode === 'write' || hasWriteSteps(def)) ? ['Portal.Operator'] : []),
    ];
    const missing = [...new Set(needs)].filter((r) => !session.roles.includes(r));
    if (!missing.length) return true;
    await failTree(
      { repo, store },
      tree,
      {
        code: 'forbidden',
        message: `${session.upn} no longer has the ${missing.join(' and ')} role that ${def.title} needs, so the run stopped.`,
        hint: 'Ask a portal administrator for the role, or ask someone who has it to run this playbook.',
      },
      now(),
    );
    return false;
  }

  /**
   * Expires pending approvals, stops runs that waited more than 24 hours for write access or a fresh sign-in, and
   * re-enqueues runs that look abandoned (queued/running without progress).
   */
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
    for (const run of await repo.staleRuns(PARKED_ON_IDENTITY, new Date(t.getTime() - PARKED_MAX_MS), 50)) {
      if (run.parentRunId) continue;
      await this.expireParked(run, t);
    }
    for (const run of await repo.staleRuns(['queued', 'running'], new Date(t.getTime() - STALE_MS), 50)) {
      if (run.parentRunId) continue;
      await this.deps.queue.enqueue(run.id);
    }
  }

  /** IAM-02: a run parked on arming or signing in for over 24 hours is stopped (audited `run.expired`). */
  private async expireParked(run: RunRow, now: Date): Promise<void> {
    const { repo, store } = this.deps;
    const tree = await repo.runTree(run.id);
    const ended = await failTree(
      { repo, store },
      tree,
      {
        code: 'run_expired',
        message: `The run waited more than 24 hours for ${run.status === 'awaiting_arm' ? 'write access' : 'a new sign-in'}, so it was stopped.`,
        hint: 'Start a new run.',
      },
      now,
      PARKED_ON_IDENTITY,
    );
    if (!ended) return;
    await this.deps.audit
      ?.append({
        actorOid: run.identity === 'automation' ? 'automation' : run.initiatorOid,
        actorUpn: run.identity === 'automation' ? executedAs(run) : run.initiatorUpn,
        mode: null,
        action: 'run.expired',
        targetType: 'run',
        targetId: run.id,
        details: {
          definition: run.definitionKey,
          version: run.definitionVersion,
          previousStatus: run.status,
          parkedSince: run.updatedAt.toISOString(),
          runsEnded: ended,
        },
        result: 'failure',
        correlationId: run.correlationId,
      })
      .catch((err: unknown) =>
        this.deps.log?.warn({ err: { message: (err as Error).message } }, 'run expiry audit failed'),
      );
  }
}
