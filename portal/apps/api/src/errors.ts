import { ApiError } from '@adminforge/connectors';
import type { ApiErrorBody } from '@adminforge/schemas';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NotArmed, ReauthRequired } from './auth/types';

type ErrorExtras = Omit<ApiErrorBody['error'], 'code' | 'message' | 'correlationId'>;

/** An error that maps directly to an ApiErrorBody response. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extras: ErrorExtras = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Where the SPA sends the browser to sign in. */
export const loginUrl = (returnTo = '/', claims?: string) =>
  `/auth/login?returnTo=${encodeURIComponent(returnTo)}${claims ? `&claims=${encodeURIComponent(Buffer.from(claims, 'utf8').toString('base64url'))}` : ''}`;

export const unauthenticated = () =>
  new AppError(401, 'unauthenticated', 'Sign in to continue.', { login: loginUrl() });

/** Parses a request body with zod, throwing a 400 ApiErrorBody on failure. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new AppError(400, 'invalid_request', `The request is not valid. ${detail}`);
  }
  return parsed.data;
}

function upstreamError(err: ApiError): AppError {
  const extras = { hint: err.requestId ? `Microsoft request-id ${err.requestId}` : undefined };
  if (err.status === 401 || err.status === 403) return new AppError(403, 'upstream_forbidden', err.message, extras);
  if (err.status === 404) return new AppError(404, 'upstream_not_found', err.message, extras);
  if (err.status === 429) return new AppError(429, 'throttled', 'Microsoft throttled this request. Try again shortly.', extras);
  return new AppError(502, 'upstream_error', err.message, extras);
}

/** Normalises anything thrown by a route into an AppError. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ReauthRequired) {
    if (err.kind === 'write') {
      return new AppError(403, 'rearm', 'Write access needs to be re-armed.', {
        hint: 'Arm write access again to continue.',
        reauth: { url: '/auth/arm' },
      });
    }
    const url = loginUrl('/', err.claims);
    return new AppError(401, 'reauth', 'Your sign-in needs to be refreshed.', { login: url, reauth: { url } });
  }
  if (err instanceof NotArmed) {
    return new AppError(403, 'not_armed', err.message, { hint: 'Arm write access to continue.' });
  }
  if (err instanceof ApiError) return upstreamError(err);
  const fe = err as Partial<FastifyError> | undefined;
  const status = typeof fe?.statusCode === 'number' ? fe.statusCode : 500;
  if (status === 429) return new AppError(429, 'rate_limited', 'Too many requests. Slow down and try again.');
  if (fe?.validation) return new AppError(400, 'invalid_request', fe.message ?? 'The request is not valid.');
  if (status >= 400 && status < 500) {
    const code = (fe?.code ?? 'bad_request').replace(/^FST_(ERR_)?/, '').toLowerCase();
    return new AppError(status, code, fe?.message ?? 'Bad request.');
  }
  return new AppError(500, 'internal', 'Something went wrong. Quote the correlation id if you report this.');
}

export function sendError(request: FastifyRequest, reply: FastifyReply, err: AppError) {
  const body: ApiErrorBody = {
    error: {
      code: err.code,
      message: err.message,
      ...Object.fromEntries(Object.entries(err.extras).filter(([, v]) => v !== undefined)),
      correlationId: request.id,
    },
  };
  return reply.status(err.status).type('application/json; charset=utf-8').send(body);
}

/** The single error handler: every failure leaves as an ApiErrorBody. */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, request, reply) => {
    const appErr = toAppError(err);
    if (appErr.status >= 500) request.log.error({ err }, 'request failed');
    else request.log.info({ code: appErr.code, status: appErr.status }, 'request rejected');
    return sendError(request, reply, appErr);
  });
}
