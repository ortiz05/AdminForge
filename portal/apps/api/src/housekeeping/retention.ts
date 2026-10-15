import { randomUUID } from 'node:crypto';
import { and, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { ArtifactStore } from '../artifacts/store';
import type { AuditWriter } from '../audit/writer';
import type { Db } from '../db/client';
import { approvals, probeResults, runStepEvents, runSteps, runs, scheduleRuns } from '../db/schema';

export interface RetentionPolicy {
  runDays: number;
  scheduleRunDays: number;
  probeDays: number;
  artifactDays: number;
}

export interface RetentionResult {
  runs: number;
  steps: number;
  events: number;
  approvals: number;
  scheduleRuns: number;
  probeResults: number;
  artifacts: number;
}

/** Runs that are over and need nobody: parked runs and `needs_review` (a person must look) are never purged. */
const FINISHED = ['succeeded', 'failed', 'cancelled', 'compensated'];
const BATCH = 2_000;
const DAY_MS = 86_400_000;

/**
 * Deletes history older than the policy: finished runs (with their steps, events and decided run approvals), schedule
 * run history, probe results and report files. Batched so a large backlog doesn't hold long locks. The audit log is
 * append-only and is never touched; the purge itself is audited (counts only).
 */
export async function applyRetention(
  db: Db,
  deps: { artifacts: ArtifactStore | null; audit: AuditWriter; now: Date },
  policy: RetentionPolicy,
): Promise<RetentionResult> {
  const cutoff = (days: number) => new Date(deps.now.getTime() - days * DAY_MS);
  const result: RetentionResult = {
    runs: 0,
    steps: 0,
    events: 0,
    approvals: 0,
    scheduleRuns: 0,
    probeResults: 0,
    artifacts: 0,
  };

  const runCutoff = cutoff(policy.runDays);
  for (;;) {
    const old = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(inArray(runs.status, FINISHED), lt(sql`coalesce(${runs.endedAt}, ${runs.updatedAt})`, runCutoff)),
      )
      .limit(BATCH);
    if (!old.length) break;
    const ids = old.map((r) => r.id);
    await db.transaction(async (tx) => {
      result.events += (
        await tx
          .delete(runStepEvents)
          .where(inArray(runStepEvents.runId, ids))
          .returning({ id: runStepEvents.id })
      ).length;
      result.steps += (
        await tx.delete(runSteps).where(inArray(runSteps.runId, ids)).returning({ runId: runSteps.runId })
      ).length;
      result.approvals += (
        await tx
          .delete(approvals)
          .where(
            and(
              sql`${approvals.subjectType} = 'run'`,
              inArray(approvals.subjectId, ids),
              sql`${approvals.status} <> 'pending'`,
            ),
          )
          .returning({ id: approvals.id })
      ).length;
      result.runs += (await tx.delete(runs).where(inArray(runs.id, ids)).returning({ id: runs.id })).length;
    });
    if (old.length < BATCH) break;
  }

  result.scheduleRuns = (
    await db
      .delete(scheduleRuns)
      .where(and(isNotNull(scheduleRuns.endedAt), lt(scheduleRuns.startedAt, cutoff(policy.scheduleRunDays))))
      .returning({ id: scheduleRuns.id })
  ).length;
  result.probeResults = (
    await db
      .delete(probeResults)
      .where(lt(probeResults.ts, cutoff(policy.probeDays)))
      .returning({ id: probeResults.id })
  ).length;
  if (deps.artifacts) result.artifacts = await deps.artifacts.pruneOlderThan(cutoff(policy.artifactDays));

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
