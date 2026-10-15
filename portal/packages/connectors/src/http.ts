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
  return (
    err instanceof ApiError &&
    err.code !== RESPONSE_TOO_LARGE &&
    (err.status === 0 || err.status === 429 || err.status >= 500)
  );
}

/** ApiError code for a response body over the size limit (never retried: it would be just as large again). */
export const RESPONSE_TOO_LARGE = 'ResponseTooLarge';
/** Default cap on one response body (OUTBOUND_MAX_BYTES in the API): above Microsoft's own 64 MB result limits. */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'the service';
  }
};

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

/**
 * Reads a response body as text, streaming, and stops at `maxBytes`: `onLimit: 'throw'` refuses the response with a
 * ResponseTooLarge ApiError (connectors), `'truncate'` returns the first `maxBytes` (probes looking for a marker).
 * A Content-Length above the limit is refused before anything is read.
 */
export async function readBodyText(
  res: Response,
  maxBytes: number,
  opts: { onLimit?: 'throw' | 'truncate'; url?: string; requestId?: string } = {},
): Promise<{ text: string; truncated: boolean }> {
  const onLimit = opts.onLimit ?? 'throw';
  const tooLarge = () =>
    new ApiError(
      502,
      RESPONSE_TOO_LARGE,
      `The response from ${opts.url ? hostOf(opts.url) : 'the service'} is larger than the ${megabytes(maxBytes)} AdminForge accepts.`,
      opts.requestId,
    );
  const declared = Number(res.headers.get('content-length'));
  if (onLimit === 'throw' && Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);
      if (onLimit === 'throw') throw tooLarge();
      text += decoder.decode(value.subarray(0, maxBytes - total), { stream: true });
      return { text: text + decoder.decode(), truncated: true };
    }
    total += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), truncated: false };
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
  /** 'error' refuses redirects (connections to your own APIs: a bearer token must never follow one elsewhere). */
  redirect?: 'follow' | 'error' | 'manual';
  /** Largest response body accepted, in bytes (default DEFAULT_MAX_RESPONSE_BYTES); larger ones are refused. */
  maxResponseBytes?: number;
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

interface UpstreamErrorBody {
  code?: string;
  message?: string;
  /** Log Analytics / Kusto: nested causes, the innermost is the specific one (e.g. a KQL syntax error). */
  innererror?: UpstreamErrorBody;
  /** ARM: per-field details. */
  details?: Array<{ code?: string; message?: string }>;
}

/** The most specific message Microsoft gave: the innermost `innererror`, else the first ARM detail. */
function specificMessage(err: UpstreamErrorBody): string | undefined {
  let inner = err.innererror;
  let deepest: string | undefined;
  for (let depth = 0; inner && depth < 8; depth++, inner = inner.innererror)
    if (typeof inner.message === 'string' && inner.message) deepest = inner.message;
  const detail = err.details?.find((d) => typeof d.message === 'string' && d.message)?.message;
  return (deepest ?? detail)?.slice(0, 500);
}

function errorFrom(
  status: number,
  statusText: string,
  data: unknown,
  headers: Headers,
  requestId?: string,
): ApiError {
  const body = data as { error?: UpstreamErrorBody | string; message?: string } | undefined;
  const err = typeof body?.error === 'object' ? body.error : undefined;
  const code = err?.code ?? (typeof body?.error === 'string' ? body.error : `HTTP${status}`);
  const outer =
    err?.message ??
    (typeof body?.message === 'string' ? body.message : undefined) ??
    (statusText || `HTTP ${status}`);
  const specific = err ? specificMessage(err) : undefined;
  const message = specific && specific !== outer ? `${outer.replace(/\.$/, '')}: ${specific}` : outer;
  const claims = /claims="([^"]+)"/.exec(headers.get('www-authenticate') ?? '')?.[1];
  return new ApiError(status, code, message, requestId, claims);
}

const isFetchFailure = (err: unknown): boolean => {
  const name = (err as { name?: string } | undefined)?.name;
  return err instanceof TypeError || name === 'TimeoutError' || name === 'AbortError';
};

function networkError(err: unknown, url: string): ApiError {
  const name = (err as { name?: string } | undefined)?.name;
  const host = hostOf(url);
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
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

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
          ...(opts.redirect ? { redirect: opts.redirect } : {}),
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
      // Streamed with a cap: a huge (or endless) body must not be buffered whole into memory.
      const { text } = await readBodyText(res, maxBytes, { url: req.url, requestId });
      const data = parseBody(text, res.headers.get('content-type') ?? '');
      const ms = Math.round(performance.now() - started);
      if (!res.ok) throw errorFrom(res.status, res.statusText, data, res.headers, requestId);
      return { data: data as T, status: res.status, requestId, ms, headers: res.headers };
    }
  }
  return { send };
}
export type HttpClient = ReturnType<typeof createHttpClient>;
