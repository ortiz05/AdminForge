import { randomUUID } from 'node:crypto';
import { and, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { ArtifactStore } from '../artifacts/store';
import type { AuditWriter } from '../audit/writer';
import { writeTx, type Db } from '../db/client';
import {
  approvals,
  probeResults,
  runStepEvents,
  runSteps,
  runs,
  scheduleRuns,
  schedules,
} from '../db/schema';
import { pruneBudget, type PruneBudget, type PruneBudgetOptions } from './budget';

export { RETENTION_BATCH, RETENTION_BUDGET_MS } from './budget';

export interface RetentionPolicy {
  runDays: number;
  scheduleRunDays: number;
  probeDays: number;
  artifactDays: number;
}

export interface RetentionResult {
  /** News and changes items past their feed's retention (or of feeds no longer defined). */
  news: number;
  runs: number;
  steps: number;
  events: number;
  approvals: number;
  scheduleRuns: number;
  /** Deleted report schedules created in the portal, once no run history is left (and a day after creation). */
  portalSchedules: number;
  probeResults: number;
  artifacts: number;
  /** The pass stopped at its time budget with rows still to delete: run it again soon (the next housekeeping pass). */
  pending: boolean;
}

/** Runs that are over and need nobody: parked runs and `needs_review` (a person must look) are never purged. */
const FINISHED = ['succeeded', 'failed', 'cancelled', 'compensated'];
const DAY_MS = 86_400_000;

/** Rows per delete (default 2,000), the time budget per pass (default 2 s) and its clock (tests). */
export type RetentionOptions = PruneBudgetOptions;

/**
 * Deletes history older than the policy: finished runs (with their steps, events and decided run approvals), schedule
 * run history, deleted portal schedules without history, probe results, report files and News and changes items past
 * their feed's retention. Every table — and the report files and news items after them — is purged in batches of
 * `RETENTION_BATCH` rows (files) with the event loop let in between, and a pass stops after `RETENTION_BUDGET_MS`
 * (`pending`: the caller runs it again soon) — so a large backlog never holds the write lock or the API for long
 * (D-02). The audit log is append-only and is never touched; the purge itself is audited (counts only).
 */
export async function applyRetention(
  db: Db,
  deps: {
    artifacts: ArtifactStore | null;
    audit: AuditWriter;
    now: Date;
    /** News and changes retention (per-feed retentionDays; feeds.prune). */
    news?: { prune(now: Date, budget?: PruneBudget): Promise<number> } | null;
  },
  policy: RetentionPolicy,
  opts: RetentionOptions = {},
): Promise<RetentionResult> {
  const budget = pruneBudget(opts);
  const batch = budget.batch;
  const cutoff = (days: number) => new Date(deps.now.getTime() - days * DAY_MS);
  const result: RetentionResult = {
    news: 0,
    runs: 0,
    steps: 0,
    events: 0,
    approvals: 0,
    scheduleRuns: 0,
    portalSchedules: 0,
    probeResults: 0,
    artifacts: 0,
    pending: false,
  };

  const runCutoff = cutoff(policy.runDays);
  const scheduleRunCutoff = cutoff(policy.scheduleRunDays);
  const probeCutoff = cutoff(policy.probeDays);
  /** One batch per table: deletes up to `batch` rows and returns how many went. */
  const purges: Array<[Exclude<keyof RetentionResult, 'pending'>, () => number]> = [
    [
      'runs',
      () => {
        const ids = db
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              inArray(runs.status, FINISHED),
              lt(sql`coalesce(${runs.endedAt}, ${runs.updatedAt})`, runCutoff.getTime()),
            ),
          )
          .limit(batch)
          .all()
          .map((r) => r.id);
        if (!ids.length) return 0;
        return writeTx(db, (tx) => {
          // The run first: its steps and events go with it (ON DELETE CASCADE), and an approval may only be deleted
          // once its run is gone (the approvals_delete_with_subject trigger).
          result.events += tx.delete(runStepEvents).where(inArray(runStepEvents.runId, ids)).run().changes;
          result.steps += tx.delete(runSteps).where(inArray(runSteps.runId, ids)).run().changes;
          const deleted = tx.delete(runs).where(inArray(runs.id, ids)).run().changes;
          result.approvals += tx
            .delete(approvals)
            .where(
              and(
                sql`${approvals.subjectType} = 'run'`,
                inArray(approvals.subjectId, ids),
                sql`${approvals.status} <> 'pending'`,
              ),
            )
            .run().changes;
          return deleted;
        });
      },
    ],
    [
      'scheduleRuns',
      () =>
        db
          .delete(scheduleRuns)
          .where(
            inArray(
              scheduleRuns.id,
              db
                .select({ id: scheduleRuns.id })
                .from(scheduleRuns)
                .where(and(isNotNull(scheduleRuns.endedAt), lt(scheduleRuns.startedAt, scheduleRunCutoff)))
                .limit(batch),
            ),
          )
          .run().changes,
    ],
    // A deleted (retired) portal schedule is kept while it has run history (and for a day after it was created, so
    // the "50 created per person in 24 hours" cap still counts it); then the row goes too.
    [
      'portalSchedules',
      () =>
        db
          .delete(schedules)
          .where(
            inArray(
              schedules.id,
              db
                .select({ id: schedules.id })
                .from(schedules)
                .where(
                  and(
                    sql`${schedules.source} = 'portal'`,
                    sql`${schedules.definition} ->> 'status' = 'retired'`,
                    lt(schedules.createdAt, cutoff(1)),
                    sql`not exists (select 1 from ${scheduleRuns} where ${scheduleRuns.scheduleId} = ${schedules.id})`,
                  ),
                )
                .limit(batch),
            ),
          )
          .run().changes,
    ],
    [
      'probeResults',
      () =>
        db
          .delete(probeResults)
          .where(
            inArray(
              probeResults.id,
              db
                .select({ id: probeResults.id })
                .from(probeResults)
                .where(lt(probeResults.ts, probeCutoff))
                .limit(batch),
            ),
          )
          .run().changes,
    ],
  ];

  purging: for (const [field, step] of purges) {
    for (;;) {
      const n = step();
      result[field] += n;
      if (n < batch) break;
      if (!(await budget.next())) break purging;
    }
  }
  // Report files and News and changes items within what is left of the same budget.
  if (deps.artifacts && !budget.pending)
    result.artifacts = await deps.artifacts.pruneOlderThan(cutoff(policy.artifactDays), budget);
  if (deps.news && !budget.pending) result.news = await deps.news.prune(deps.now, budget);
  result.pending = budget.pending;

  const { pending: _pending, ...counts } = result;
  if (Object.values(counts).some((n) => n > 0))
    await deps.audit.append({
      actorOid: 'system',
      actorUpn: 'AdminForge housekeeping',
      mode: 'read',
      action: 'housekeeping.retention',
      correlationId: randomUUID(),
      targetType: 'retention',
      targetId: 'history',
      result: 'success',
      details: { ...result, policy },
    });
  return result;
}
