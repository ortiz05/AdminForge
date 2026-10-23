// The schedules API's views and caller helpers, split from service.ts (organization review O-04).
import {
  identityKey,
  identityLabel,
  type PortalRole,
  type Schedule,
  type RunAsDefaults,
} from '@adminforge/schemas';

export { creatorFilesAccess, SCHEDULED_DATA_ROLES } from './run-access';

import type { AuditInput } from '../audit/writer';
import { hasRole } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import { AppError } from '../errors';
import { type DeliveryView, type NotifyView } from './delivery-keys';
import type { ScheduleGrantRow } from './grants';
import type {
  ApprovalStatus,
  RunCursor,
  ScheduleApprovalPolicy,
  ScheduleApprovalRow,
  ScheduleRow,
  ScheduleRunRow,
} from './types';
import { runAsOf } from './run-as';

/**
 * Schedules as the API sees them (R6): list, enable/disable (two-person approval for write-capable schedules),
 * run now, history, report downloads, and the schedule side of the approvals inbox. Execution is the scheduler's job;
 * this service only writes rows, audits, and wakes the scheduler (`schedule.run_requested`).
 */

export interface Caller {
  session: SessionRecord;
  correlationId: string;
  ip: string | null;
}

export interface ScheduleItem {
  key: string;
  title: string;
  summary: string | null;
  cron: string;
  cronText: string | null;
  timezone: string;
  enabled: boolean;
  /** `automation`, `app:<name>` or `user` (identityKey). */
  identity: string;
  /** Who it runs as (ADR-014), for people. */
  runsAs: RunsAsView;
  job: {
    kind: Schedule['job']['kind'];
    ref?: string;
    refs?: string[];
    select?: { tags: string[] };
    /** Report jobs: the params the report runs with. */
    params?: Record<string, unknown>;
  };
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  writeCapable: boolean;
  approvedBy?: string[];
  source: 'content' | 'portal';
  /** The creator's UPN (portal schedules); null for content. */
  createdBy: string | null;
  /** Portal schedule, the caller holds Portal.Operator and created it (by oid) or holds Portal.Admin. */
  canManage: boolean;
  /** Report jobs: where the file goes (configuration key names, never values). */
  delivery?: DeliveryView[];
  /** `notify.onFailure` targets (key names). */
  notify?: NotifyView[];
  /** Set while an enable request waits for its second approver. */
  pendingApprovalId: string | null;
}

/** Who a schedule runs as, as the schedule list and page show it. */
export interface RunsAsView {
  kind: 'automation' | 'app' | 'user';
  /** The app identity's name, or the creator's UPN. */
  name: string | null;
  /** "automation identity", "app identity reports-team", "avery@example.com (their own access)". */
  label: string;
  /**
   * Creator schedules: whether the creator's grant works (`signed_in`), was refused by Microsoft (`needs_sign_in`), or
   * was never given (`not_signed_in`).
   */
  signIn?: 'signed_in' | 'needs_sign_in' | 'not_signed_in';
  /** Creator schedules: the caller is the creator and may sign in for it. */
  canSignIn?: boolean;
}

export interface ScheduleRunItem {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  runId?: string;
  artifact?: { name: string; href: string; size: number | null };
  error?: { code: string; message: string; hint?: string };
  /** Why a run didn't happen (skipped runs), or sent nothing (Run now while the schedule was disabled). */
  reason?: string;
}

/** Run now on a disabled schedule (F-10): what the answer says. */
export const FILE_ONLY_MESSAGE =
  'The schedule is disabled, so this run only writes the file: it sends no email, Teams message or notification.';

/** Schedule approvals in the inbox shape the web UI reads (same as run TaskViews, subjectType 'schedule'). */
export interface ScheduleApprovalView {
  id: string;
  subjectType: 'schedule';
  subjectId: string;
  stepId: null;
  kind: 'approval';
  title: string;
  status: ApprovalStatus;
  requestedBy: string;
  requestedByOid: string;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  scheduleKey: string;
  policy: Omit<ScheduleApprovalPolicy, 'initiatorOid'>;
  decisions: ScheduleApprovalRow['decisions'];
  canDecide: boolean;
}

export const APPROVAL_TTL_MS = 7 * 86_400_000;
/** Run now on a portal schedule: not again within this long of the last manual run. */
export const PORTAL_RUN_NOW_INTERVAL_MS = 15 * 60_000;

/** What `item` needs of a report: who may open it and which params it redacts. */
export interface ReportAccess {
  requires?: { portalRoles?: PortalRole[] };
  params?: Record<string, { redact?: boolean }>;
}

/** A portal schedule that was deleted (soft delete: kept for its history, hidden everywhere else). */
export const isDeleted = (row: Pick<ScheduleRow, 'source' | 'definition'>) =>
  row.source === 'portal' && row.definition.status === 'retired';

/**
 * Who may edit or delete a schedule created in the portal: a Portal.Operator who created it (by oid) or who is also a
 * Portal.Admin. Content schedules change through git only. (Any Operator may still turn one off.)
 */
export function canManage(row: Pick<ScheduleRow, 'source' | 'createdBy'>, session?: SessionRecord): boolean {
  if (!session || row.source !== 'portal' || !hasRole(session, 'Portal.Operator')) return false;
  return (!!row.createdBy && row.createdBy === session.userOid) || hasRole(session, 'Portal.Admin');
}

/** Who a schedule runs as, for its list row and page (the grant decides a creator schedule's sign-in state). */
export function runsAsView(
  row: Pick<ScheduleRow, 'definition' | 'createdBy' | 'source'> &
    Partial<Pick<ScheduleRow, 'runAs' | 'runAsSetBy' | 'runAsSetAt'>>,
  session?: SessionRecord,
  grant?: ScheduleGrantRow | null,
  defaults?: RunAsDefaults,
): RunsAsView {
  const { identity, source } = runAsOf({ ...row, runAs: row.runAs ?? null }, defaults);
  // Where the account comes from, and who chose it when an Operator did.
  const origin = {
    source,
    ...(source === 'override' && row.runAsSetBy ? { setBy: row.runAsSetBy } : {}),
    ...(source === 'override' && row.runAsSetAt ? { setAt: row.runAsSetAt.toISOString() } : {}),
  };
  if (!identity || identity === 'automation')
    return { kind: 'automation', name: null, label: identityLabel(identity), ...origin };
  if ('app' in identity)
    return { kind: 'app', name: identity.app, label: identityLabel(identity), ...origin };
  const owner = row.source === 'portal' ? row.definition.owner : null;
  return {
    ...origin,
    kind: 'user',
    name: owner,
    label: identityLabel(identity, owner),
    signIn: !grant ? 'not_signed_in' : grant.status === 'active' ? 'signed_in' : 'needs_sign_in',
    canSignIn: !!session && !!row.createdBy && row.createdBy === session.userOid,
  };
}

/** Audit actor fields for a schedules API caller. */
export function actorOf(c: Caller): Omit<AuditInput, 'action' | 'result'> {
  return {
    actorOid: c.session.userOid,
    actorUpn: c.session.upn,
    sessionHash: c.session.idHash,
    mode: 'read',
    correlationId: c.correlationId,
    ip: c.ip,
  };
}

export function encodeRunCursor(r: Pick<ScheduleRunRow, 'startedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ s: r.startedAt.toISOString(), i: r.id }), 'utf8').toString('base64url');
}

export function decodeRunCursor(cursor: string): RunCursor {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: string; i?: string };
    const startedAt = new Date(v.s ?? '');
    if (Number.isNaN(startedAt.getTime()) || !v.i || !/^[0-9a-f-]{36}$/i.test(v.i)) throw new Error('bad');
    return { startedAt, id: v.i };
  } catch {
    throw new AppError(400, 'invalid_request', 'The cursor is not valid.');
  }
}
