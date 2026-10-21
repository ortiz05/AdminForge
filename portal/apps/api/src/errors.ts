import { ApiError, RESPONSE_TOO_LARGE } from '@adminforge/connectors';
import type { ApiErrorBody } from '@adminforge/schemas';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditWriter } from './audit/writer';
import { isArmed, type SessionRecord } from './auth/session-store';
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

/** Public page (rendered by the SPA without a session) that explains a failed sign-in or write-access round trip. */
export const PROBLEM_PAGE = '/sign-in-problem';

/** A top-level browser navigation (an Entra redirect, a link, a new tab), where a JSON error would show raw. */
export function isNavigation(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const mode = request.headers['sec-fetch-mode'];
  if (typeof mode === 'string') return mode === 'navigate';
  return (request.headers.accept ?? '').includes('text/html');
}

/** The problem page for `err`: only the code, the correlation id and an upstream detail travel in the URL. */
export function problemPageUrl(request: FastifyRequest, err: AppError): string {
  const params = new URLSearchParams({ code: err.code, ref: String(request.id) });
  if (request.url.startsWith('/auth/arm')) params.set('during', 'arm');
  else if (request.url.startsWith('/api/artifacts/')) params.set('during', 'download');
  const detail = err.extras.detail;
  if (detail && /^[A-Za-z0-9_]{1,40}$/.test(detail)) params.set('detail', detail);
  return `${PROBLEM_PAGE}?${params}`;
}

/** Where the SPA sends the browser to sign in. */
export const loginUrl = (returnTo = '/', claims?: string) =>
  `/auth/login?returnTo=${encodeURIComponent(returnTo)}${claims ? `&claims=${encodeURIComponent(Buffer.from(claims, 'utf8').toString('base64url'))}` : ''}`;

export const unauthenticated = () =>
  new AppError(401, 'unauthenticated', 'Your AdminForge session has ended. Sign in to continue.', {
    login: loginUrl(),
  });

/** Signed in, but no AdminForge role (sign-in, or a session left without one): what Entra sign-in answers too. */
export const noPortalRole = () =>
  new AppError(403, 'no_portal_role', 'Your account doesn’t have access to AdminForge yet.', {
    hint: 'Ask a portal administrator to add you to an AdminForge group: Reader to view, Operator to make changes.',
  });

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
  const ref = err.requestId ? ` Microsoft request-id: ${err.requestId}.` : '';
  const detail = err.code ? { detail: err.code.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || undefined } : {};
  if (err.status === 401 || err.status === 403)
    return new AppError(403, 'upstream_forbidden', err.message, {
      hint: `Your Microsoft Entra role may not allow this (check PIM for an eligible role), or the tenant lacks the licence or permission it needs.${ref}`,
      ...detail,
    });
  if (err.status === 404)
    return new AppError(404, 'upstream_not_found', err.message, {
      hint: `It may have been deleted or renamed. Refresh the list and try again.${ref}`,
      ...detail,
    });
  if (err.code === RESPONSE_TOO_LARGE)
    return new AppError(502, 'response_too_large', err.message, {
      hint: 'Narrow it down (filters, fewer columns or a shorter time range) so the result is smaller.',
    });
  if (err.status === 429)
    return new AppError(429, 'throttled', 'Microsoft is limiting requests right now.', {
      hint: `Wait a minute, then try again.${ref}`,
    });
  return new AppError(502, 'upstream_error', err.message, {
    hint: `Microsoft returned an error. Try again; if it persists, give a portal administrator the reference.${ref}`,
    ...detail,
  });
}

/** Normalises anything thrown by a route into an AppError. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ReauthRequired) {
    if (err.kind === 'write') {
      return new AppError(403, 'rearm', 'Your write access needs a fresh verification.', {
        hint: 'Arm write access again to continue.',
      });
    }
    const url = loginUrl('/', err.claims);
    return new AppError(401, 'reauth', 'Microsoft needs you to sign in again.', {
      hint: 'Sign in again to continue. If this keeps coming back, give a portal administrator the reference.',
      login: url,
      reauth: { url },
    });
  }
  if (err instanceof NotArmed) {
    return new AppError(403, 'not_armed', err.message, { hint: 'Arm write access to continue.' });
  }
  if (err instanceof ApiError) return upstreamError(err);
  const fe = err as Partial<FastifyError> | undefined;
  const status = typeof fe?.statusCode === 'number' ? fe.statusCode : 500;
  if (status === 429)
    return new AppError(429, 'rate_limited', 'Too many requests from your browser this minute.', {
      hint: 'Wait a minute, then try again.',
    });
  if (fe?.validation) return new AppError(400, 'invalid_request', fe.message ?? 'The request is not valid.');
  if (status >= 400 && status < 500) {
    const code = (fe?.code ?? 'bad_request').replace(/^FST_(ERR_)?/, '').toLowerCase();
    return new AppError(status, code, fe?.message ?? 'Bad request.');
  }
  return new AppError(500, 'internal', 'AdminForge hit an unexpected problem and didn’t finish this.', {
    hint: 'Try again. If it keeps happening, give a portal administrator the reference below.',
  });
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

/**
 * Refusals that say something about who is trying what — missing roles, CSRF, the request policy, self-approval,
 * confirmations that don't match, protected objects, paused writes — as opposed to ordinary mistakes (validation, not
 * found). Each is appended to the audit log as `request.denied`.
 */
export const AUDITED_DENIALS: ReadonlySet<string> = new Set([
  'forbidden',
  'csrf',
  'policy_denied',
  'own_run',
  'own_request',
  'confirmation_mismatch',
  'preview_required',
  'preview_stale',
  'protected_object',
  'writes_paused',
  'session_mismatch',
]);

/** At most one `request.denied` per session (or address, without one) and code in this window; the rest are counted. */
export const DENIAL_AUDIT_WINDOW_MS = 60_000;

/**
 * Audits refused requests (AUDITED_DENIALS), rate-limited per session + code so a looping client can't flood the
 * permanent log: the next event after a quiet window carries how many were not recorded (`suppressed`). Only the
 * route pattern, the code and the status are kept — never request bodies, query values or path parameters.
 */
export class DenialAudit {
  private readonly last = new Map<string, { at: number; suppressed: number }>();

  constructor(private readonly deps: { audit: Pick<AuditWriter, 'append'>; now: () => Date }) {}

  async record(request: FastifyRequest, err: AppError): Promise<void> {
    if (!AUDITED_DENIALS.has(err.code)) return;
    const now = this.deps.now();
    const t = now.getTime();
    // (Typed here rather than through the session plugin's augmentation, which not every importer loads.)
    const session = (request as { session?: SessionRecord | null }).session ?? null;
    const key = `${session?.idHash ?? `ip:${request.ip}`}|${err.code}`;
    const prev = this.last.get(key);
    if (prev && t - prev.at < DENIAL_AUDIT_WINDOW_MS) {
      prev.suppressed++;
      return;
    }
    if (this.last.size > 10_000)
      for (const [k, v] of this.last) if (t - v.at >= DENIAL_AUDIT_WINDOW_MS) this.last.delete(k);
    this.last.set(key, { at: t, suppressed: 0 });
    const route = request.routeOptions?.url ?? request.url.split(/[?#]/)[0]!.slice(0, 200);
    await this.deps.audit.append({
      actorOid: session?.userOid ?? null,
      actorUpn: session?.upn ?? null,
      sessionHash: session?.idHash ?? null,
      mode: session ? (isArmed(session, now) ? 'write' : 'read') : null,
      action: 'request.denied',
      targetType: 'route',
      targetId: `${request.method} ${route}`,
      result: 'denied',
      details: {
        code: err.code,
        status: err.status,
        ...(prev?.suppressed ? { suppressed: prev.suppressed } : {}),
      },
      correlationId: request.id,
      ip: request.ip,
    });
  }
}

/**
 * The single error handler: every failure leaves as an ApiErrorBody — except a browser navigation to /auth/* (Entra
 * redirects back there) or to a report download link, which goes to the problem page so nobody sees raw JSON.
 * With `denials`, security-relevant refusals are also audited.
 */
export function registerErrorHandler(app: FastifyInstance, opts: { denials?: DenialAudit } = {}) {
  app.setErrorHandler(async (err, request, reply) => {
    const appErr = toAppError(err);
    if (appErr.status >= 500) request.log.error({ err }, 'request failed');
    else request.log.info({ code: appErr.code, status: appErr.status }, 'request rejected');
    if (opts.denials)
      await opts.denials
        .record(request, appErr)
        .catch((auditErr: unknown) => request.log.warn({ err: auditErr }, 'denied request not audited'));
    if (
      (request.url.startsWith('/auth/') || request.url.startsWith('/api/artifacts/')) &&
      isNavigation(request)
    ) {
      return reply.header('cache-control', 'no-store').redirect(problemPageUrl(request, appErr), 303);
    }
    return sendError(request, reply, appErr);
  });
}
