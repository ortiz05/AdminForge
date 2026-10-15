import { queryOptions } from '@tanstack/react-query';
import { api } from '../lib/api';
import { arr, bool, listOf, num, pick, rec } from './json';

/**
 * GET /api/approvals?status=pending → { items: TaskView[] } (Playbook.Approver): run approval gates the caller may
 * approve — { id, subjectType, subjectId, stepId (step path), kind, title, status, requestedBy, createdAt, expiresAt,
 * policy: { approvers, minApprovals, message, writesAfter, definitionKey, … }, decisions, canDecide }.
 * Decisions: runs → POST /api/runs/:subjectId/approvals/:stepId { decision, comment };
 *            schedules / definitions → POST /api/approvals/:id { decision, comment } (not built yet; see report).
 */

export interface ApprovalItem {
  id: string;
  subjectType: 'run' | 'schedule' | 'definition';
  subjectId: string;
  stepId: string | null;
  title: string;
  requestedBy: string;
  createdAt: string | null;
  expiresAt: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  message: string | null;
  approvers: string[];
  minApprovals: number;
  /** Steps after this gate change the tenant and run as the approver (ADR-010), so approving needs write access. */
  requiresArm: boolean;
  /** Definition key / schedule key the request is about, when the server says. */
  ref: string | null;
  /** The server's verdict (role, not the requester, not decided yet); null = decide locally. */
  canDecide: boolean | null;
}

export function readApprovalItem(raw: unknown): ApprovalItem | null {
  const o = rec(raw);
  const policy = rec(o.policy);
  const id = pick(o, 'id');
  const subjectId = pick(o, 'subjectId', 'runId');
  if (!id || !subjectId || (o.kind ?? policy.kind) === 'manual') return null;
  const subjectType = o.subjectType === 'schedule' || o.subjectType === 'definition' ? o.subjectType : 'run';
  const status = o.status === 'approved' || o.status === 'rejected' || o.status === 'expired' ? o.status : 'pending';
  const explicitArm = bool(o.requiresArm) ?? bool(policy.writesAfter) ?? bool(policy.requiresArm);
  return {
    id,
    subjectType,
    subjectId,
    stepId: pick(o, 'stepId') ?? null,
    title: pick(o, 'title') ?? `${subjectType} ${subjectId}`,
    requestedBy: pick(o, 'requestedBy') ?? pick(rec(o.requestedBy), 'upn') ?? 'someone',
    createdAt: pick(o, 'createdAt') ?? null,
    expiresAt: pick(o, 'expiresAt') ?? null,
    status,
    message: pick(o, 'message') ?? pick(policy, 'message') ?? null,
    approvers: arr(policy.approvers ?? o.approvers).filter((x): x is string => typeof x === 'string'),
    minApprovals: num(policy.minApprovals) ?? num(o.minApprovals) ?? 1,
    // Run approvals gate write steps unless the server says otherwise; schedule/definition approvals change no tenant data.
    requiresArm: explicitArm ?? subjectType === 'run',
    ref: pick(o, 'ref', 'definitionKey', 'playbook', 'scheduleKey') ?? pick(policy, 'definitionKey') ?? null,
    canDecide: bool(o.canDecide) ?? null,
  };
}

export const approvalsQuery = (status = 'pending') =>
  queryOptions({
    queryKey: ['approvals', status] as const,
    queryFn: ({ signal }) =>
      api(`/api/approvals?status=${encodeURIComponent(status)}`, { schema: listOf(readApprovalItem), signal }),
    refetchInterval: 30_000,
  });

export type Decision = 'approve' | 'reject';

export function decide(item: Pick<ApprovalItem, 'id' | 'subjectType' | 'subjectId' | 'stepId'>, decision: Decision, comment: string) {
  const body = { decision, comment: comment.trim() || undefined };
  if (item.subjectType === 'run' && item.stepId)
    return api(`/api/runs/${encodeURIComponent(item.subjectId)}/approvals/${encodeURIComponent(item.stepId)}`, { method: 'POST', body });
  return api(`/api/approvals/${encodeURIComponent(item.id)}`, { method: 'POST', body });
}
