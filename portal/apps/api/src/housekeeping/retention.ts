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
}

/** Runs that are over and need nobody: parked runs and `needs_review` (a person must look) are never purged. */
const FINISHED = ['succeeded', 'failed', 'cancelled', 'compensated'];
const BATCH = 2_000;
const DAY_MS = 86_400_000;

/**
 * Deletes history older than the policy: finished runs (with their steps, events and decided run approvals), schedule
 * run history, deleted portal schedules without history, probe results, report files and News and changes items past
 * their feed's retention. Batched so a large backlog doesn't hold the write lock for long. The audit log is
 * append-only and is never touched; the purge itself is audited (counts only).
 */
export async function applyRetention(
  db: Db,
  deps: {
    artifacts: ArtifactStore | null;
    audit: AuditWriter;
    now: Date;
    /** News and changes retention (per-feed retentionDays; feeds.prune). */
    news?: { prune(now: Date): Promise<number> } | null;
  },
  policy: RetentionPolicy,
): Promise<RetentionResult> {
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
  };

  const runCutoff = cutoff(policy.runDays);
  for (;;) {
    const old = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          inArray(runs.status, FINISHED),
          lt(sql`coalesce(${runs.endedAt}, ${runs.updatedAt})`, runCutoff.getTime()),
        ),
      )
      .limit(BATCH);
    if (!old.length) break;
    const ids = old.map((r) => r.id);
    writeTx(db, (tx) => {
      // The run first: its steps and events go with it (ON DELETE CASCADE), and an approval may only be deleted once
      // its run is gone (the approvals_delete_with_subject trigger).
      result.events += tx
        .delete(runStepEvents)
        .where(inArray(runStepEvents.runId, ids))
        .returning({ id: runStepEvents.id })
        .all().length;
      result.steps += tx
        .delete(runSteps)
        .where(inArray(runSteps.runId, ids))
        .returning({ runId: runSteps.runId })
        .all().length;
      result.runs += tx.delete(runs).where(inArray(runs.id, ids)).returning({ id: runs.id }).all().length;
      result.approvals += tx
        .delete(approvals)
        .where(
          and(
            sql`${approvals.subjectType} = 'run'`,
            inArray(approvals.subjectId, ids),
            sql`${approvals.status} <> 'pending'`,
          ),
        )
        .returning({ id: approvals.id })
        .all().length;
    });
    if (old.length < BATCH) break;
  }

  result.scheduleRuns = (
    await db
      .delete(scheduleRuns)
      .where(and(isNotNull(scheduleRuns.endedAt), lt(scheduleRuns.startedAt, cutoff(policy.scheduleRunDays))))
      .returning({ id: scheduleRuns.id })
  ).length;
  // A deleted (retired) portal schedule is kept while it has run history (and for a day after it was created, so the
  // "50 created per person in 24 hours" cap still counts it); then the row goes too.
  result.portalSchedules = (
    await db
      .delete(schedules)
      .where(
        and(
          sql`${schedules.source} = 'portal'`,
          sql`${schedules.definition} ->> 'status' = 'retired'`,
          lt(schedules.createdAt, cutoff(1)),
          sql`not exists (select 1 from ${scheduleRuns} where ${scheduleRuns.scheduleId} = ${schedules.id})`,
        ),
      )
      .returning({ id: schedules.id })
  ).length;
  result.probeResults = (
    await db
      .delete(probeResults)
      .where(lt(probeResults.ts, cutoff(policy.probeDays)))
      .returning({ id: probeResults.id })
  ).length;
  if (deps.artifacts) result.artifacts = await deps.artifacts.pruneOlderThan(cutoff(policy.artifactDays));
  if (deps.news) result.news = await deps.news.prune(deps.now);

  if (Object.values(result).some((n) => n > 0))
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
