import { ApiErrorBody } from '@adminforge/schemas';
import { browser } from './browser';

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
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export const CSRF_HEADER = 'X-AdminForge-CSRF';

let csrfToken: string | undefined;

/** Called whenever GET /api/me succeeds; non-GET requests echo the token back. */
export function rememberCsrf(token: string | undefined): void {
  csrfToken = token;
}

/** Keeps the user's place: the sign-in round trip comes back to the page they were on. */
export function loginUrl(login: string, here: Location = window.location): string {
  const url = new URL(login, here.origin);
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
}

/**
 * fetch for the BFF: same-origin cookies, CSRF header on writes, typed errors, contract validation.
 * A 401 that carries `error.login` sends the browser to sign in.
 */
export async function api<T = unknown>(
  path: string,
  { method = 'GET', body, schema, signal }: RequestOptions<T> = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;

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
    const parsed = ApiErrorBody.safeParse(data);
    const correlation = res.headers.get('x-correlation-id') ?? undefined;
    if (!parsed.success) {
      throw new ApiRequestError(
        res.status,
        `http_${res.status}`,
        `The server answered ${res.status} ${res.statusText}.`.trim(),
        undefined,
        correlation,
      );
    }
    const err = parsed.data.error;
    if (res.status === 401 && err.login) browser.assign(loginUrl(err.login));
    throw new ApiRequestError(
      res.status,
      err.code,
      err.message,
      err.hint,
      err.correlationId ?? correlation,
      err.login,
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
