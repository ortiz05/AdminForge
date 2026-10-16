import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasRole, requireRole, requireSession } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import { auditActor, type AppContext } from '../context';
import { AppError, parseBody } from '../errors';
import { PAUSE_KEYS, readPause, type PauseState, type PauseTarget } from '../execution/emergency';

/**
 * Emergency stop (finding ENG-08), registered inside the /api scope (session + CSRF on PUT already enforced):
 * - GET /api/emergency — the two flags for everyone signed in (the shell's banner) plus what the caller may do.
 * - PUT /api/admin/emergency `{ target: 'writes' | 'automation', paused, reason? }` — pausing needs Portal.Admin or
 *   Playbook.Approver and a reason; resuming needs Portal.Admin. Audited as `emergency.paused` / `emergency.resumed`.
 */

const EmergencyChange = z
  .object({
    target: z.enum(['writes', 'automation']),
    paused: z.boolean(),
    reason: z.string().max(500).optional(),
  })
  .strict();

const LABEL: Record<PauseTarget, string> = { writes: 'changes', automation: 'automation' };

const canPause = (s: SessionRecord) => hasRole(s, 'Portal.Admin') || hasRole(s, 'Playbook.Approver');
const canResume = (s: SessionRecord) => hasRole(s, 'Portal.Admin');

const view = ({ paused, reason, by, at }: PauseState): PauseState => ({ paused, reason, by, at });

async function emergencyState(ctx: AppContext, session: SessionRecord) {
  const [writes, automation] = await Promise.all([
    readPause(ctx.settings, 'writes'),
    readPause(ctx.settings, 'automation'),
  ]);
  return {
    writes: view(writes),
    automation: view(automation),
    canPause: canPause(session),
    canResume: canResume(session),
  };
}

export function emergencyRoutes(api: FastifyInstance, ctx: AppContext) {
  api.get('/emergency', async (request) => emergencyState(ctx, requireSession(request)));

  api.put('/admin/emergency', async (request) => {
    const session = requireSession(request);
    const change = parseBody(EmergencyChange, request.body);
    const what = LABEL[change.target];
    if (change.paused) {
      if (!canPause(session))
        throw new AppError(
          403,
          'forbidden',
          `Pausing ${what} needs the Portal.Admin or Playbook.Approver role.`,
          {
            hint: 'Ask a portal administrator, or someone in the AdminForge Admin or Playbook Approver group, to pause it.',
          },
        );
    } else requireRole(session, 'Portal.Admin', `Resuming ${what}`);
    const reason = change.reason?.trim() || null;
    if (change.paused && (!reason || reason.length < 3))
      throw new AppError(400, 'invalid_request', `Say why you’re pausing ${what}.`, {
        hint: 'The reason is shown to everyone signed in and kept in the audit log.',
      });

    const current = await readPause(ctx.settings, change.target);
    // Already in that state: nothing to change (and nothing to audit).
    if (current.paused === change.paused) return emergencyState(ctx, session);
    const at = ctx.now();
    const value: PauseState = {
      paused: change.paused,
      reason: change.paused ? reason : null,
      by: session.upn,
      at: at.toISOString(),
    };
    const saved = await ctx.settings.put(PAUSE_KEYS[change.target], value, {
      updatedBy: session.userOid,
      now: at,
      expectedVersion: current.version,
    });
    if (!saved)
      throw new AppError(409, 'conflict', `Someone else paused or resumed ${what} meanwhile.`, {
        hint: 'Reload the page to see the current state, then try again if it’s still needed.',
      });
    await ctx.audit.append({
      ...auditActor(ctx, request, session),
      action: change.paused ? 'emergency.paused' : 'emergency.resumed',
      targetType: 'settings',
      targetId: PAUSE_KEYS[change.target],
      result: 'success',
      details: {
        target: change.target,
        reason,
        ...(change.paused ? {} : { pausedReason: current.reason, pausedBy: current.by }),
        version: saved.version,
      },
    });
    ctx.events.publish({
      type: 'emergency.changed',
      data: { target: change.target, paused: change.paused },
    });
    return emergencyState(ctx, session);
  });
}
