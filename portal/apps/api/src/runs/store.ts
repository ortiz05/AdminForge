import {
  isTerminal,
  type Actor,
  type AutomationDefinition,
  type Decision,
  type HumanTask,
  type RunEventInput,
  type RunPatch,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type StepRecord,
  writesAfter,
} from '@adminforge/engine';
import type { AuditWriter } from '../audit/writer';
import { toRecord, type RunNotification, type RunRepository, type RunRow, type TaskRow } from './types';

/** "automation identity" or "app identity <name>": who an automation run executed as (ADR-011, ADR-014). */
export const executedAs = (row: Pick<RunRow, 'identityName'>) =>
  row.identityName ? `app identity ${row.identityName}` : 'automation identity';

/** Audit actor fields for something a run did (delegated: the engineer; automation: the app-only identity). */
export function runAuditActor(
  row: Pick<RunRow, 'identity' | 'identityName' | 'initiatorOid' | 'initiatorUpn' | 'sessionHash'>,
  actor?: Actor | null,
) {
  if (row.identity === 'automation')
    return { actorOid: 'automation', actorUpn: executedAs(row), sessionHash: null };
  return {
    actorOid: actor?.oid ?? row.initiatorOid,
    actorUpn: actor?.upn ?? row.initiatorUpn,
    sessionHash: null,
  };
}

const auditResult = (status: RunStatus) =>
  status === 'succeeded' || status === 'compensated' || status === 'cancelled' ? 'success' : 'failure';

/** Maps a stored event to its notification / SSE type. */
export function notificationType(e: Pick<RunEventInput, 'type' | 'data'>): RunNotification['type'] {
  if (e.type === 'status') return e.data.scope === 'run' ? 'run' : 'step';
  if (e.type === 'progress') return 'progress';
  return 'log';
}

/**
 * The engine's RunStore over the run repository. Besides persistence it audits every executed write step
 * (`run.step.write`) and run completion (`run.completed`), and turns approval/manual parks into `approvals` rows.
 */
export class RepositoryRunStore implements RunStore {
  private readonly defs = new Map<string, AutomationDefinition>();
  private readonly rows = new Map<
    string,
    Pick<
      RunRow,
      | 'initiatorOid'
      | 'parentRunId'
      | 'identity'
      | 'identityName'
      | 'initiatorUpn'
      | 'sessionHash'
      | 'definitionKey'
      | 'definitionVersion'
      | 'correlationId'
      | 'scheduleId'
    >
  >();

  constructor(
    readonly repo: RunRepository,
    private readonly audit: AuditWriter,
    /** Called once when a run's approval gate opens (approver notifications). */
    private readonly onApprovalRequested?: (info: {
      runId: string;
      title: string;
      requestedBy: string | null;
      correlationId: string;
    }) => Promise<void>,
  ) {}

  /** Registers the pinned definition of a run before the engine executes it (titles and policies of human tasks). */
  bind(runId: string, def: AutomationDefinition): void {
    this.defs.set(runId, def);
  }

  private async row(runId: string) {
    let r = this.rows.get(runId);
    if (!r) {
      const full = await this.repo.getRun(runId);
      if (!full) return null;
      r = {
        initiatorOid: full.initiatorOid,
        initiatorUpn: full.initiatorUpn,
        parentRunId: full.parentRunId,
        identity: full.identity,
        identityName: full.identityName,
        sessionHash: full.sessionHash,
        definitionKey: full.definitionKey,
        definitionVersion: full.definitionVersion,
        correlationId: full.correlationId,
        scheduleId: full.scheduleId,
      };
      // Only metadata of runs being executed is needed; keep the cache small in long-lived workers.
      if (this.rows.size >= 1000) this.rows.clear();
      this.rows.set(runId, r);
    }
    return r;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const row = await this.repo.getRun(runId);
    return row ? toRecord(row) : null;
  }

  async updateRun(runId: string, patch: RunPatch, expect?: readonly RunStatus[]): Promise<RunRecord | null> {
    const row = await this.repo.updateRun(runId, patch, expect);
    if (!row) return null;
    if (patch.status && isTerminal(patch.status)) {
      await this.audit.append({
        ...runAuditActor(row),
        mode: null,
        action: 'run.completed',
        targetType: 'run',
        targetId: runId,
        details: {
          definition: row.definitionKey,
          version: row.definitionVersion,
          status: patch.status,
          dryRun: row.dryRun,
          trigger: row.trigger,
          ...(row.error
            ? {
                error: { code: row.error.code, message: row.error.message, stepId: row.error.stepId ?? null },
              }
            : {}),
          ...(row.identity === 'automation'
            ? { scheduledBy: row.initiatorUpn ?? row.initiatorOid, executedAs: executedAs(row) }
            : {}),
        },
        result: auditResult(patch.status),
        correlationId: row.correlationId,
      });
      this.rows.delete(runId);
    }
    return toRecord(row);
  }

  listSteps(runId: string): Promise<StepRecord[]> {
    return this.repo.listSteps(runId);
  }

  async saveStep(
    runId: string,
    record: StepRecord,
    meta: { actor: Actor | null; dryRun: boolean },
  ): Promise<void> {
    await this.repo.saveStep(runId, record);
    const executedWrite =
      record.mode === 'write' &&
      !meta.dryRun &&
      (record.status === 'succeeded' || record.status === 'failed') &&
      record.type !== 'playbook';
    if (!executedWrite) return;
    const row = await this.row(runId);
    if (!row) return;
    await this.audit.append({
      ...runAuditActor(row, meta.actor),
      mode: 'write',
      action: 'run.step.write',
      targetType: 'run',
      targetId: runId,
      details: {
        definition: row.definitionKey,
        version: row.definitionVersion,
        stepId: record.stepId,
        path: record.path,
        type: record.type,
        attempt: record.attempt,
        compensation: record.path.endsWith('#compensate'),
        request: record.request,
        status: record.status,
        requestId: record.msRequestId,
        ...(record.error
          ? {
              error: {
                code: record.error.code,
                message: record.error.message,
                status: record.error.status ?? null,
              },
            }
          : {}),
        ...(row.identity === 'automation'
          ? { scheduledBy: row.initiatorUpn ?? row.initiatorOid, executedAs: executedAs(row) }
          : {}),
      },
      result: record.status === 'succeeded' ? 'success' : 'failure',
      correlationId: row.correlationId,
    });
  }

  async appendEvent(runId: string, event: RunEventInput): Promise<void> {
    const row = await this.row(runId);
    const type = notificationType(event);
    const status = typeof event.data.status === 'string' ? event.data.status : undefined;
    await this.repo.appendEvent(runId, event, {
      v: 1,
      runId,
      type,
      ...(status ? { status } : {}),
      initiatorOid: row?.initiatorOid ?? null,
      parentRunId: row?.parentRunId ?? null,
    });
  }

  async openTask(runId: string, task: HumanTask): Promise<void> {
    const row = await this.row(runId);
    const def = this.defs.get(runId);
    const { requestedBy, ...rest } = task;
    const isNew = task.kind === 'approval' && !(await this.repo.getTask(runId, task.path));
    await this.repo.upsertTask(runId, task, {
      ...rest,
      title: def?.title ?? row?.definitionKey ?? 'Run',
      definitionKey: row?.definitionKey ?? def?.id ?? '',
      definitionVersion: row?.definitionVersion ?? def?.version ?? '',
      requestedByUpn: requestedBy.upn,
      initiatorOid: row?.initiatorOid ?? null,
      ...(task.kind === 'approval' ? { writesAfter: def ? writesAfter(def, task.path) : true } : {}),
    });
    if (isNew && this.onApprovalRequested)
      await this.onApprovalRequested({
        runId,
        title: def?.title ?? row?.definitionKey ?? 'Run',
        requestedBy: requestedBy.upn ?? null,
        correlationId: row?.correlationId ?? runId,
      }).catch(() => undefined);
  }

  async getDecision(runId: string, path: string): Promise<Decision | null> {
    const task = await this.repo.getTask(runId, path);
    return task ? decisionOf(task) : null;
  }
}

/** The engine's view of a decided task (null while pending or cancelled). */
export function decisionOf(task: TaskRow): Decision | null {
  const at = (task.decidedAt ?? new Date()).toISOString();
  const last = (kinds: string[]) => [...task.decisions].reverse().find((d) => kinds.includes(d.decision));
  const actorOf = (d: { oid: string; upn: string | null }): Actor => ({
    kind: 'delegated',
    oid: d.oid,
    upn: d.upn,
  });
  if (task.policy.kind === 'approval') {
    if (task.status === 'approved') {
      const d = last(['approve'])!;
      return {
        kind: 'approval',
        approved: true,
        actor: actorOf(d),
        comment: d.comment ?? null,
        decidedAt: at,
      };
    }
    if (task.status === 'rejected') {
      const d = last(['reject']);
      return {
        kind: 'approval',
        approved: false,
        actor: d ? actorOf(d) : null,
        comment: d?.comment ?? null,
        decidedAt: at,
      };
    }
    if (task.status === 'expired')
      return { kind: 'approval', approved: false, actor: null, comment: null, decidedAt: at, expired: true };
    return null;
  }
  if (task.status === 'approved' || task.status === 'rejected') {
    const d = last(['confirm', 'decline'])!;
    return {
      kind: 'manual',
      confirmed: task.status === 'approved',
      actor: actorOf(d),
      notes: d.comment ?? null,
      values: d.values ?? {},
      decidedAt: at,
    };
  }
  return null;
}
