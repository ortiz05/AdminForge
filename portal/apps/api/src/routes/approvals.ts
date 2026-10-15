import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { AppError } from '../errors';
import type { RunsModule } from '../runs/module';
import { callerOf } from './runs';

const Query = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']).optional() });

/**
 * GET /api/approvals?status=pending → {items: TaskView[]} — the approver inbox (Playbook.Approver). Items are run
 * approval gates the caller holds an approver role for: {id, subjectType:'run', subjectId (run id), stepId (step path),
 * title, requestedBy (UPN), createdAt, expiresAt, policy, status, decisions, canDecide}. Decide with
 * POST /api/runs/:subjectId/approvals/:stepId.
 */
export function approvalRoutes(api: FastifyInstance, _ctx: AppContext, runs: RunsModule) {
  api.get('/approvals', async (request) => {
    const q = Query.safeParse(request.query ?? {});
    if (!q.success) throw new AppError(400, 'invalid_request', 'status must be pending, approved, rejected, expired or cancelled.');
    return runs.service.listApprovals(callerOf(request), q.data.status ? { status: q.data.status } : {});
  });
}
