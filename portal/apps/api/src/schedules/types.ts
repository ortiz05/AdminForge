import type { Schedule } from '@adminforge/schemas';

/**
 * Storage shapes for the scheduler (R6, ADR-011): `schedules`, `schedule_runs`, `probe_results` and the schedule rows of
 * `approvals` (subject_type = 'schedule'). See db/schema.ts for the columns.
 */

/** `content` = synced from portal/content/schedules; `portal` = created in the UI. */
export type ScheduleSource = 'content' | 'portal';

export interface ScheduleRow {
  id: string;
  key: string;
  source: ScheduleSource;
  /** The validated schedule definition this row runs (content is re-synced when its sha256 changes). */
  definition: Schedule;
  sha256: string;
  enabled: boolean;
  createdBy: string | null;
  /** Who approved enabling a write-capable schedule (second person, UPN). */
  approvedBy: string | null;
  /** Playbook fingerprint the approval covered (runs/fingerprint.ts); runs refuse a playbook that no longer matches. */
  approvedTarget: string | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastStatus: string | null;
  /** The account an Operator chose for this content schedule (`automation` | `app:<name>`); null = not chosen. */
  runAs: string | null;
  runAsSetBy: string | null;
  runAsSetAt: Date | null;
  /** The account (identityKey) the two-person approval covered; null = approved before accounts were recorded. */
  approvedIdentity: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewSchedule = Pick<
  ScheduleRow,
  'key' | 'source' | 'definition' | 'sha256' | 'enabled' | 'nextRunAt'
> &
  Partial<Pick<ScheduleRow, 'createdBy' | 'approvedBy' | 'approvedTarget'>>;
/** Caps on report schedules created in the portal, checked with the insert in one step (store.insertPortalSchedule). */
export interface PortalScheduleCaps {
  /** Active (not deleted) portal schedules in total. */
  total: number;
  /** Active portal schedules of one creator. */
  perCreator: number;
  /** Portal schedules one creator made since `since` (deleted ones included). */
  recent: number;
  since: Date;
}

export type PortalInsertResult =
  { ok: true; row: ScheduleRow } | { ok: false; reason: 'exists' | 'total' | 'perCreator' | 'recent' };

export type SchedulePatch = Partial<
  Pick<
    ScheduleRow,
    | 'definition'
    | 'sha256'
    | 'enabled'
    | 'approvedBy'
    | 'approvedTarget'
    | 'nextRunAt'
    | 'lastRunAt'
    | 'lastStatus'
    | 'createdBy'
    | 'runAs'
    | 'runAsSetBy'
    | 'runAsSetAt'
    | 'approvedIdentity'
  >
>;

/**
 * `queued` = waiting for the scheduler (run now, retries, `overlap: queue`; `startedAt` is when it becomes due);
 * `running` → `succeeded` | `failed` | `timeout`; `skipped` = not run because the previous run was still going.
 */
export const SCHEDULE_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'timeout',
  'skipped',
] as const;
export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUSES)[number];
export type ScheduleTrigger = 'cron' | 'manual' | 'retry';

export interface RunErrorInfo {
  code: string;
  message: string;
  hint?: string;
}

export interface ScheduleRunRow {
  id: string;
  scheduleId: string;
  scheduleKey: string;
  trigger: ScheduleTrigger;
  status: ScheduleRunStatus;
  /** Playbook run id (playbook jobs). */
  runId: string | null;
  /** Job summary; for queued rows also who asked (`requestedBy`) and the retry attempt. */
  result: Record<string, unknown> | null;
  error: RunErrorInfo | null;
  /** Report file, relative to ADMINFORGE_ARTIFACTS_DIR. */
  artifactPath: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

export type NewScheduleRun = Pick<ScheduleRunRow, 'scheduleId' | 'scheduleKey' | 'trigger' | 'status'> &
  Partial<
    Pick<ScheduleRunRow, 'id' | 'runId' | 'result' | 'error' | 'artifactPath' | 'startedAt' | 'endedAt'>
  >;
export type ScheduleRunPatch = Partial<
  Pick<ScheduleRunRow, 'status' | 'runId' | 'result' | 'error' | 'artifactPath' | 'startedAt' | 'endedAt'>
>;

export type ProbeStatus = 'ok' | 'warn' | 'crit' | 'error';

export interface ProbeResultRow {
  id: number;
  probeKey: string;
  ts: Date;
  status: ProbeStatus;
  metric: number | null;
  durationMs: number | null;
  message: string | null;
  details: unknown;
  scheduleRunId: string | null;
}
export type NewProbeResult = Omit<ProbeResultRow, 'id'>;

/** A decision on a schedule approval. */
export interface ScheduleDecision {
  oid: string;
  upn: string;
  decision: 'approve' | 'reject';
  comment: string | null;
  at: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

/** Policy stored on a schedule approval (enable a write-capable schedule: two-person rule, R6). */
export interface ScheduleApprovalPolicy {
  kind: 'approval';
  action: 'enable';
  approvers: string[];
  minApprovals: number;
  title: string;
  message: string;
  definitionKey: string;
  definitionVersion: string;
  /** The approval is for exactly this definition; a changed schedule needs a new approval. */
  sha256: string;
  /** Playbook jobs: fingerprint of the playbook and its children at request time (a changed playbook voids it). */
  targetFingerprint?: string;
  /** The account the schedule runs as at request time (identityKey); an approval for another account no longer applies. */
  identity?: string;
  requestedByUpn: string;
  initiatorOid: string;
  /** Approving changes no tenant data, so the approver need not arm write access. */
  writesAfter: false;
}

export interface ScheduleApprovalRow {
  id: string;
  subjectType: 'schedule';
  /** Schedule key. */
  subjectId: string;
  policy: ScheduleApprovalPolicy;
  decisions: ScheduleDecision[];
  status: ApprovalStatus;
  /** Requester oid. */
  requestedBy: string;
  expiresAt: Date | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export type NewScheduleApproval = Pick<
  ScheduleApprovalRow,
  'subjectId' | 'policy' | 'requestedBy' | 'expiresAt'
>;
export type ScheduleApprovalPatch = Partial<Pick<ScheduleApprovalRow, 'decisions' | 'status' | 'decidedAt'>>;

/** Keyset cursor for run history (newest first). */
export interface RunCursor {
  startedAt: Date;
  id: string;
}
