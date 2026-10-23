import { PortalRole } from '@adminforge/schemas';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditActor, type AppContext } from '../context';
import { noPortalRole, parseBody, unauthenticated } from '../errors';
import { buildMe } from '../routes/me';
import { ARM_RATE_LIMIT, armMinutes, armPreconditions } from './arm-routes';
import { requireSessionWithCsrf } from './guards';
import { safeReturnTo, signInReturnTo } from './return-to';
import {
  clearSessionCookie,
  dropWriteAccess,
  endSession,
  rotateSession,
  startSession,
} from './session-plugin';

/** The synthetic identity used by mock sign-in (never a real tenant). */
export const MOCK_USER = {
  userOid: '00000000-0000-4000-8000-0000000000a1',
  upn: 'avery@example.com',
  displayName: 'Avery Engineer',
  tenantId: '00000000-0000-4000-8000-00000000e0e0',
  tenantName: 'Example Org',
  tenantDomain: 'example.com',
} as const;

/**
 * POST /auth/mock/state — lets tests and the e2e suite put the session into any state, except one Entra never leaves:
 * a session without any AdminForge role ends, as the role re-check ends it with Entra.
 */
export const MockStateRequest = z.object({
  roles: z.array(PortalRole).optional(),
  /** Minutes until write access ends (fractions allowed for expiry tests); null disarms. */
  armedMinutes: z
    .number()
    .positive()
    .max(24 * 60)
    .nullable()
    .optional(),
});

/** Mock auth (AUTH_MODE=mock only; refused in production by config). */
export function mockAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Querystring: { returnTo?: string } }>('/auth/login', async (request, reply) => {
    if (request.session) await endSession(ctx, request.session);
    const session = await startSession(ctx, request, reply, {
      ...MOCK_USER,
      roles: [...ctx.config.MOCK_ROLES],
      readAccountId: 'mock-read',
    });
    await ctx.audit.append({
      ...auditActor(ctx, request, session),
      action: 'session.signin',
      result: 'success',
      details: { roles: session.roles, mock: true },
    });
    return reply.redirect(signInReturnTo(request.query.returnTo));
  });

  app.post('/auth/mock/state', async (request, reply) => {
    let session = requireSessionWithCsrf(request);
    const body = parseBody(MockStateRequest, request.body);
    if (body.roles?.length === 0) {
      await endSession(ctx, session);
      clearSessionCookie(ctx, reply);
      await ctx.audit.append({
        ...auditActor(ctx, request, session),
        action: 'session.access_revoked',
        result: 'success',
        details: { previousRoles: session.roles, reason: 'roles', mock: true },
      });
      throw noPortalRole();
    }
    if (body.roles) session = (await ctx.sessions.update(session.idHash, { roles: body.roles }))!;
    if (body.armedMinutes === null) session = await dropWriteAccess(ctx, session);
    else if (body.armedMinutes !== undefined) {
      session = (await ctx.sessions.update(session.idHash, {
        writeAccountId: 'mock-write',
        writeExpiresAt: new Date(ctx.now().getTime() + body.armedMinutes * 60_000),
        writeExtended: false,
        writeReason: 'mock state',
      }))!;
    }
    return buildMe(ctx, session);
  });

  /** Arms immediately (no step-up in mock mode), with a new session id as in Entra mode (S-08). */
  app.post<{ Querystring: { returnTo?: string } }>(
    '/auth/arm',
    { config: { rateLimit: ARM_RATE_LIMIT } },
    async (request, reply) => {
      const { session, body } = armPreconditions(request);
      const minutes = armMinutes(ctx, body.minutes);
      const until = new Date(ctx.now().getTime() + minutes * 60_000);
      const updated = await rotateSession(ctx, request, reply, session, {
        writeAccountId: 'mock-write',
        writeExpiresAt: until,
        writeExtended: false,
        writeReason: body.reason,
      });
      if (!updated) throw unauthenticated();
      await ctx.audit.append({
        ...auditActor(ctx, request, updated),
        action: 'session.armed',
        result: 'success',
        details: {
          minutes,
          requestedMinutes: body.minutes,
          reason: body.reason,
          armedUntil: until.toISOString(),
          stepUp: 'none',
          sessionRotated: true,
          mock: true,
        },
      });
      return { redirect: safeReturnTo(request.query.returnTo) };
    },
  );
}
