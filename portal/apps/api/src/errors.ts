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

/** Plain words for the type zod expected (`invalid_type`). */
const TYPE_WORDS: Record<string, string> = {
  string: 'text',
  number: 'a number',
  int: 'a whole number',
  bigint: 'a whole number',
  boolean: 'true or false',
  array: 'a list',
  object: 'an object',
  date: 'a date',
  null: 'empty',
};

/** Plain words for the string formats zod checks (`invalid_format`). */
const FORMAT_WORDS: Record<string, string> = {
  email: 'an email address',
  url: 'a web address (URL)',
  uuid: 'a GUID',
  guid: 'a GUID',
  datetime: 'a date and time (ISO 8601)',
  date: 'a date (YYYY-MM-DD)',
  time: 'a time (HH:MM)',
  duration: 'a duration like PT1H',
  ipv4: 'an IPv4 address',
  ipv6: 'an IPv6 address',
};

const listOf = (values: readonly unknown[]) => {
  const words = values.slice(0, 10).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
  if (values.length > 10) words.push('…');
  return words.length <= 2 ? words.join(' or ') : `one of ${words.join(', ')}`;
};
const items = (n: number) => (n === 1 ? 'one item' : `${n} items`);

/**
 * What a zod issue says about its field, in plain words ("must be csv or xlsx", "is missing"), for the zod checks a
 * person can meet. Only zod's own wording is replaced: a message the schema wrote itself is kept (zod gives a
 * schema's own message precedence over this per-parse one).
 */
function plainIssue(iss: z.core.$ZodRawIssue): string {
  switch (iss.code) {
    case 'invalid_type':
      if (iss.input === undefined) return 'is missing';
      return `must be ${TYPE_WORDS[iss.expected] ?? `a ${iss.expected}`}`;
    case 'invalid_value':
      return iss.input === undefined ? `is missing (${listOf(iss.values)})` : `must be ${listOf(iss.values)}`;
    case 'too_small': {
      const min = Number(iss.minimum);
      if (iss.origin === 'string') return min <= 1 ? 'can’t be empty' : `must be at least ${min} characters`;
      if (iss.origin === 'array' || iss.origin === 'set') return `needs at least ${items(min)}`;
      if (iss.origin === 'number' || iss.origin === 'bigint')
        return iss.inclusive === false ? `must be more than ${min}` : `must be at least ${min}`;
      return 'is too small';
    }
    case 'too_big': {
      const max = Number(iss.maximum);
      if (iss.origin === 'string') return `must be at most ${max} characters`;
      if (iss.origin === 'array' || iss.origin === 'set') return `can have at most ${items(max)}`;
      if (iss.origin === 'number' || iss.origin === 'bigint')
        return iss.inclusive === false ? `must be less than ${max}` : `must be at most ${max}`;
      return 'is too large';
    }
    case 'invalid_format':
      return FORMAT_WORDS[iss.format]
        ? `must be ${FORMAT_WORDS[iss.format]}`
        : 'isn’t in the expected format';
    case 'not_multiple_of':
      return `must be a multiple of ${String(iss.divisor)}`;
    case 'unrecognized_keys':
      return iss.keys.length === 1 ? 'isn’t accepted' : 'aren’t accepted';
    default:
      return 'isn’t valid';
  }
}

/** `items[0].id`; the whole body is "the body". */
const fieldLabel = (path: readonly PropertyKey[]) =>
  path.length
    ? path.map((p, i) => (typeof p === 'number' ? `[${p}]` : `${i ? '.' : ''}${String(p)}`)).join('')
    : 'the body';

/** Parses a request body with zod, throwing a 400 ApiErrorBody (plain words, with a hint) on failure. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  // Messages produced here (zod's own wording replaced) are predicates for the field; others are the schema's own.
  const plain = new Set<string>();
  const parsed = schema.safeParse(body ?? {}, {
    error: (iss) => {
      const phrase = plainIssue(iss);
      plain.add(phrase);
      return phrase;
    },
  });
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const phrases = issues.slice(0, 3).map((i) => {
      const message = i.message.trim().replace(/\.$/, '');
      if (i.code === 'unrecognized_keys' && plain.has(message))
        return `${i.keys.map((k) => fieldLabel([...i.path, k])).join(', ')} ${message}`;
      if (plain.has(message)) return `${fieldLabel(i.path)} ${message}`;
      return i.path.length ? `${fieldLabel(i.path)}: ${message}` : message;
    });
    const more = issues.length > 3 ? `, and ${issues.length - 3} more` : '';
    throw new AppError(400, 'invalid_request', `The request isn’t valid: ${phrases.join('; ')}${more}.`, {
      hint: 'Correct it and try again. If you didn’t enter it yourself, reload the page.',
    });
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

const RELOAD =
  'Reload the page and try again. If it keeps happening, give a portal administrator the reference.';
const unreadableBody = () =>
  new AppError(400, 'invalid_request', 'AdminForge couldn’t read what this page sent.', { hint: RELOAD });

/** Fastify's body-parsing refusals, in our codes and words (its own texts name headers and parser details). */
const FASTIFY_ERRORS: Record<string, () => AppError> = {
  FST_ERR_CTP_BODY_TOO_LARGE: () =>
    new AppError(413, 'body_too_large', 'This request is larger than AdminForge accepts (256 KB).', {
      hint: 'Send less at once — fewer items or shorter text — then try again.',
    }),
  FST_ERR_CTP_INVALID_MEDIA_TYPE: () =>
    new AppError(415, 'unsupported_media_type', 'AdminForge didn’t understand the format of this request.', {
      hint: RELOAD,
    }),
  FST_ERR_CTP_INVALID_JSON_BODY: unreadableBody,
  FST_ERR_CTP_EMPTY_JSON_BODY: unreadableBody,
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: unreadableBody,
};

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
  if (fe?.validation) return new AppError(400, 'invalid_request', 'The request isn’t valid.');
  if (status >= 400 && status < 500) {
    const known = fe?.code ? FASTIFY_ERRORS[fe.code] : undefined;
    if (known) return known();
    // Fastify's own text can name headers or parser internals: the code (lower-cased) stays, the words are ours.
    const code = (fe?.code ?? 'bad_request').replace(/^FST_(ERR_)?/, '').toLowerCase();
    return new AppError(status, code, 'AdminForge couldn’t handle this request.', { hint: RELOAD });
  }
  return new AppError(500, 'internal', 'AdminForge hit an unexpected problem and didn’t finish this.', {
    hint: 'Try again. If it keeps happening, give a portal administrator the reference below.',
  });
}

/**
 * Hints for codes thrown in many places, where the person can act but the thrower gave none: used only when the
 * error has no hint of its own.
 */
export const DEFAULT_HINTS: Readonly<Record<string, string>> = {
  not_found: 'Check the address, or open the page from the navigation.',
  invalid_cursor: 'Reload the list to start again from the top.',
  run_not_found:
    'Open Runs to find it. You see the runs you started; Operators, Approvers and Admins see every run.',
  datasource_not_found:
    'The page may have changed since you opened it. Reload it; if it keeps happening, give a portal administrator the reference.',
  invalid_request: 'Check what you entered and try again. If you didn’t enter anything, reload the page.',
  body_too_large: 'Send less at once — fewer items or shorter text — then try again.',
};

/** The ApiErrorBody for `err`: its code, message and extras, a default hint where it has none, and the reference. */
export function errorBody(err: AppError, correlationId: string): ApiErrorBody {
  const extras = Object.fromEntries(Object.entries(err.extras).filter(([, v]) => v !== undefined));
  const hint = err.extras.hint ?? DEFAULT_HINTS[err.code];
  return {
    error: { code: err.code, message: err.message, ...extras, ...(hint ? { hint } : {}), correlationId },
  };
}

export function sendError(request: FastifyRequest, reply: FastifyReply, err: AppError) {
  return reply
    .status(err.status)
    .type('application/json; charset=utf-8')
    .send(errorBody(err, String(request.id)));
}

/**
 * Refusals that say something about who is trying what — missing roles, CSRF, the request policy, self-approval
 * (including approving one's own access) and someone else's step, confirmations that don't match, protected objects,
 * paused writes — as opposed to ordinary mistakes (validation, not
 * found). Each is appended to the audit log as `request.denied`.
 */
export const AUDITED_DENIALS: ReadonlySet<string> = new Set([
  'forbidden',
  'csrf',
  'policy_denied',
  'own_run',
  'own_request',
  // An approver whom the change grants access to, and anyone completing a step that waits for another engineer.
  'own_access',
  'not_your_step',
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
 * 5xx refusals that shed load on purpose (a flood of sign-in starts): expected, so logged at info without a stack —
 * one warning a minute per code says it is happening and how often.
 */
export const SHED_LOAD: ReadonlySet<string> = new Set(['signin_busy']);

/** Counts shed-load refusals per code; `warn` is called for the first one and then at most once a minute. */
export class ShedLog {
  private readonly last = new Map<string, { at: number; refused: number }>();
  refused(code: string, warn: (refused: number) => void, now = Date.now()) {
    const prev = this.last.get(code);
    if (prev && now - prev.at < 60_000) {
      prev.refused++;
      return;
    }
    warn((prev?.refused ?? 0) + 1);
    this.last.set(code, { at: now, refused: 0 });
  }
}

/**
 * The single error handler: every failure leaves as an ApiErrorBody — except a browser navigation to /auth/* (Entra
 * redirects back there) or to a report download link, which goes to the problem page so nobody sees raw JSON.
 * With `denials`, security-relevant refusals are also audited.
 */
export function registerErrorHandler(app: FastifyInstance, opts: { denials?: DenialAudit } = {}) {
  const sheds = new ShedLog();
  app.setErrorHandler(async (err, request, reply) => {
    const appErr = toAppError(err);
    if (SHED_LOAD.has(appErr.code)) {
      request.log.info({ code: appErr.code, status: appErr.status }, 'request rejected');
      sheds.refused(appErr.code, (refused) =>
        request.log.warn({ code: appErr.code, refused }, 'refusing requests to protect the service'),
      );
    } else if (appErr.status >= 500) request.log.error({ err }, 'request failed');
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
