import { defaultSleep, type Sleep, type TokenProvider } from './types';

/** Error from any Microsoft REST API, normalised. Network failures use status 0 (code NetworkError or Timeout). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    /** Base64 claims challenge from WWW-Authenticate (Continuous Access Evaluation). */
    readonly claims?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Throttling, server errors and network failures — worth retrying for idempotent work (§7.8). */
export function isTransient(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 0 || err.status === 429 || err.status >= 500);
}

export interface HttpRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * Safe to retry after 5xx / network errors. Defaults to true for GET, HEAD, OPTIONS, PUT and DELETE.
   * 429 (and 503 with Retry-After) are always retried: the service did not process the request.
   */
  idempotent?: boolean;
  signal?: AbortSignal;
}

export interface HttpResult<T> {
  data: T;
  status: number;
  requestId?: string;
  ms: number;
  headers: Headers;
}

export interface HttpClientOptions {
  getToken: TokenProvider;
  fetch?: typeof fetch;
  maxRetries?: number;
  sleep?: Sleep;
  correlationId?: string;
  /** Header that carries the correlation id (Graph: client-request-id; ARM: x-ms-client-request-id). */
  correlationHeader?: string;
  /** Header that carries Microsoft's request id in responses. */
  requestIdHeader?: string;
  timeoutMs?: number;
}

const SERVER_RETRYABLE = new Set([500, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** Delay before the next attempt: Retry-After (seconds or HTTP date, capped at 120 s) or exponential backoff with jitter. */
export function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 120_000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 120_000);
  }
  return Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 250);
}

function parseBody(text: string, contentType: string): unknown {
  if (!text) return undefined;
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return /^\d+$/.test(text.trim()) ? Number(text) : text;
}

function errorFrom(
  status: number,
  statusText: string,
  data: unknown,
  headers: Headers,
  requestId?: string,
): ApiError {
  const body = data as { error?: { code?: string; message?: string } | string; message?: string } | undefined;
  const err = typeof body?.error === 'object' ? body.error : undefined;
  const code = err?.code ?? (typeof body?.error === 'string' ? body.error : `HTTP${status}`);
  const message =
    err?.message ??
    (typeof body?.message === 'string' ? body.message : undefined) ??
    (statusText || `HTTP ${status}`);
  const claims = /claims="([^"]+)"/.exec(headers.get('www-authenticate') ?? '')?.[1];
  return new ApiError(status, code, message, requestId, claims);
}

const isFetchFailure = (err: unknown): boolean => {
  const name = (err as { name?: string } | undefined)?.name;
  return err instanceof TypeError || name === 'TimeoutError' || name === 'AbortError';
};

function networkError(err: unknown, url: string): ApiError {
  const name = (err as { name?: string } | undefined)?.name;
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return 'the service';
    }
  })();
  if (name === 'TimeoutError')
    return new ApiError(0, 'Timeout', `No response from ${host} before the timeout.`);
  return new ApiError(
    0,
    'NetworkError',
    `Could not reach ${host}: ${(err as Error)?.message ?? String(err)}`,
  );
}

/** Authenticated JSON client with retries (Retry-After honoured), timeouts, and normalised errors. */
export function createHttpClient(opts: HttpClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const maxRetries = opts.maxRetries ?? 4;
  const sleep = opts.sleep ?? defaultSleep;
  const reqIdHeader = opts.requestIdHeader ?? 'request-id';

  async function send<T>(req: HttpRequest): Promise<HttpResult<T>> {
    const method = (req.method ?? 'GET').toUpperCase();
    const idempotent = req.idempotent ?? IDEMPOTENT_METHODS.has(method);
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      // Token failures (re-auth needed, not armed, …) propagate unchanged and are never retried here.
      const token = await opts.getToken();
      const signals = [req.signal, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter(
        (s): s is AbortSignal => !!s,
      );
      let res: Response;
      try {
        res = await doFetch(req.url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(opts.correlationId && opts.correlationHeader
              ? { [opts.correlationHeader]: opts.correlationId }
              : {}),
            ...req.headers,
          },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
        });
      } catch (err) {
        // Only genuine fetch failures are retried: network errors (TypeError) and timeouts/aborts we did not ask for.
        if (req.signal?.aborted || !isFetchFailure(err)) throw err;
        if (idempotent && attempt < maxRetries) {
          await sleep(retryDelay(null, attempt));
          continue;
        }
        throw networkError(err, req.url);
      }
      const requestId = res.headers.get(reqIdHeader) ?? res.headers.get('x-ms-request-id') ?? undefined;
      const retryAfter = res.headers.get('retry-after');
      const retryable =
        res.status === 429 ||
        (res.status === 503 && retryAfter !== null) ||
        (idempotent && SERVER_RETRYABLE.has(res.status));
      if (retryable && attempt < maxRetries) {
        await res.body?.cancel().catch(() => undefined);
        await sleep(retryDelay(retryAfter, attempt));
        continue;
      }
      const data = parseBody(await res.text(), res.headers.get('content-type') ?? '');
      const ms = Math.round(performance.now() - started);
      if (!res.ok) throw errorFrom(res.status, res.statusText, data, res.headers, requestId);
      return { data: data as T, status: res.status, requestId, ms, headers: res.headers };
    }
  }
  return { send };
}
export type HttpClient = ReturnType<typeof createHttpClient>;
