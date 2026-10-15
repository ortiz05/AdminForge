import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { AppError, parseBody } from '../errors';
import type { RunsModule } from '../runs/module';
import type { SchedulesModule } from '../schedules/module';
import { ApprovalBody, callerOf } from './runs';

const Query = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']).optional(),
});

/**
 * GET /api/approvals?status=pending → {items: TaskView[]} — the approver inbox (Playbook.Approver), oldest first:
 * - run approval gates the caller holds an approver role for: {id, subjectType:'run', subjectId (run id), stepId (step
 *   path), title, requestedBy (UPN), createdAt, expiresAt, policy, status, decisions, canDecide}. Decide with
 *   POST /api/runs/:subjectId/approvals/:stepId.
 * - requests to enable a write-capable schedule (two-person rule, R6): {id, subjectType:'schedule', subjectId (schedule
 *   key), stepId: null, scheduleKey, …same fields}. Decide with POST /api/approvals/:id {decision, comment?} →
 *   {status, approvals, required}; the requester cannot approve their own request.
 */
export function approvalRoutes(
  api: FastifyInstance,
  _ctx: AppContext,
  runs: RunsModule,
  schedules?: SchedulesModule,
) {
  api.get('/approvals', async (request) => {
    const q = Query.safeParse(request.query ?? {});
    if (!q.success)
      throw new AppError(
        400,
        'invalid_request',
        'status must be pending, approved, rejected, expired or cancelled.',
      );
    const caller = callerOf(request);
    const runItems = await runs.service.listApprovals(caller, q.data.status ? { status: q.data.status } : {});
    if (!schedules) return runItems;
    const scheduleItems = await schedules.service.listApprovals(caller.session, q.data.status);
    const items = [...runItems.items, ...scheduleItems].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
    return { ...runItems, items };
  });

  api.post<{ Params: { id: string } }>('/approvals/:id', async (request) => {
    const body = parseBody(ApprovalBody, request.body);
    const approval = schedules ? await schedules.service.getApproval(request.params.id) : null;
    if (!approval)
      throw new AppError(404, 'approval_not_found', 'That approval request no longer exists.', {
        hint: 'It may have been decided, withdrawn or expired. Open Approvals to see what is waiting for you.',
      });
    return schedules!.service.decide(callerOf(request), request.params.id, body);
  });
}
