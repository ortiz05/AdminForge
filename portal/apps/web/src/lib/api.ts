import { parseApiError } from './contracts';
import { browser } from './browser';
import { isUserActive } from './activity';
import { maySignInAutomatically, noteAutomaticSignIn } from './sign-in-guard';

/** Anything with zod's `parse` — the contracts in @adminforge/schemas, or a small hand-written guard. */
export interface Parser<T> {
  parse(input: unknown): T;
}

/** A failed call, normalised from the BFF's `{ error: { code, message, hint?, login?, correlationId? } }`. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly correlationId?: string,
    readonly login?: string,
    /** The browser is on its way to sign in (a 401 on a request the person made). */
    readonly signingIn = false,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export const CSRF_HEADER = 'X-AdminForge-CSRF';
/** Sent (`1`) on requests the person didn't cause, so they don't count as activity for the session's idle timeout. */
export const BACKGROUND_HEADER = 'X-AdminForge-Background';

let csrfToken: string | undefined;

/** Called whenever GET /api/me succeeds; non-GET requests echo the token back. */
export function rememberCsrf(token: string | undefined): void {
  csrfToken = token;
}

const SIGN_IN_PATH = '/auth/login';

/**
 * Keeps the user's place: the sign-in round trip comes back to the page they were on. Only this site's own
 * /auth/login is ever followed (with its `claims`, nothing else), whatever an error body says — a `login` that points
 * anywhere else (another origin, `//host`, another path) falls back to a plain sign-in.
 */
export function loginUrl(login: string, here: Location = window.location): string {
  let given: URL | undefined;
  try {
    given = new URL(login, here.origin);
  } catch {
    given = undefined;
  }
  const own = given && given.origin === here.origin && given.pathname === SIGN_IN_PATH;
  const url = new URL(SIGN_IN_PATH, here.origin);
  const claims = own ? given!.searchParams.get('claims') : null;
  if (claims) url.searchParams.set('claims', claims);
  url.searchParams.set('returnTo', `${here.pathname}${here.search}`);
  return `${url.pathname}${url.search}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  schema?: Parser<T>;
  signal?: AbortSignal;
  /** Send the CSRF header on a GET too (reads with a side effect, e.g. fetching a show-once secret). */
  csrf?: boolean;
  /**
   * The request isn't the person's doing (polling, a refetch on focus or after a server event): sent with
   * `X-AdminForge-Background: 1` so it doesn't keep the session alive. Left out, it is background unless the person
   * interacted with the page in the last few seconds (`lib/activity.ts`) — every timer and refetch is covered.
   */
  background?: boolean;
  /** Internal: a stale CSRF token is refreshed and the request retried once. */
  csrfRetried?: boolean;
}

/**
 * fetch for the BFF: same-origin cookies, CSRF header on writes, typed errors, contract validation.
 * A 401 that carries `error.login` sends the browser to sign in — unless the request was background.
 */
export async function api<T = unknown>(path: string, options: RequestOptions<T> = {}): Promise<T> {
  const { method = 'GET', body, schema, signal, csrf, csrfRetried } = options;
  const background = options.background ?? !isUserActive();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if ((method !== 'GET' || csrf) && csrfToken) headers[CSRF_HEADER] = csrfToken;
  if (background) headers[BACKGROUND_HEADER] = '1';

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiRequestError(
      0,
      'network',
      'AdminForge could not reach its server.',
      'Check your connection or VPN, then try again.',
    );
  }

  const text = await res.text();
  const data = text ? parseJson(text) : undefined;

  if (!res.ok) {
    const parsed = parseApiError(data);
    const correlation = res.headers.get('x-correlation-id') ?? undefined;
    if (!parsed) {
      throw new ApiRequestError(
        res.status,
        `http_${res.status}`,
        `The server answered ${res.status} ${res.statusText}.`.trim(),
        undefined,
        correlation,
      );
    }
    const err = parsed.error;
    // The page's CSRF token went stale (signed in again in another tab): take the current one and retry once.
    if (res.status === 403 && err.code === 'csrf' && !csrfRetried && (await refreshCsrf(signal, background)))
      return api(path, { ...options, background, csrfRetried: true });
    // Signed out: off to sign-in, but only from a request the person made. An unattended tab never starts a sign-in
    // (single sign-on would quietly open a new session and defeat the idle timeout); the shell offers it instead.
    // Nor does a 401 right after a sign-in round trip: that would loop (lib/sign-in-guard.ts).
    const signingIn = res.status === 401 && Boolean(err.login) && !background && maySignInAutomatically();
    if (signingIn) {
      noteAutomaticSignIn();
      browser.assign(loginUrl(err.login!));
    }
    throw new ApiRequestError(
      res.status,
      err.code,
      err.message,
      err.hint,
      err.correlationId ?? correlation,
      err.login,
      signingIn,
    );
  }

  if (!schema) return data as T;
  try {
    return schema.parse(data);
  } catch {
    throw new ApiRequestError(
      res.status,
      'contract',
      `The response from ${path} doesn't match what this page expects.`,
      'The API and the web app may be on different versions. Reload the page; if it persists, tell a Portal Admin.',
      res.headers.get('x-correlation-id') ?? undefined,
    );
  }
}

/** Re-reads the session's CSRF token from /api/me; false when there is no session. */
async function refreshCsrf(signal: AbortSignal | undefined, background: boolean): Promise<boolean> {
  try {
    const res = await fetch('/api/me', {
      headers: { Accept: 'application/json', ...(background ? { [BACKGROUND_HEADER]: '1' } : {}) },
      credentials: 'same-origin',
      signal,
    });
    const me = res.ok ? parseJson(await res.text()) : undefined;
    if (!isRecord(me) || typeof me.csrf !== 'string') return false;
    rememberCsrf(me.csrf);
    return true;
  } catch {
    return false;
  }
}

/** For guards that only need an object with a few known keys. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{ redirect: string }` from /auth/arm and /auth/logout. */
export const RedirectResponse: Parser<{ redirect: string }> = {
  parse(input) {
    if (isRecord(input) && typeof input.redirect === 'string') return { redirect: input.redirect };
    throw new TypeError('Expected { redirect }');
  },
};

/** `{ armedUntil: string }` from /auth/arm/extend. */
export const ExtendResponse: Parser<{ armedUntil: string }> = {
  parse(input) {
    if (isRecord(input) && typeof input.armedUntil === 'string') return { armedUntil: input.armedUntil };
    throw new TypeError('Expected { armedUntil }');
  },
};
