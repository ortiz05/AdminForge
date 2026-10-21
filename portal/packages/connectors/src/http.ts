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
  /**
   * Runs one attempt — the request and reading its body — under the caller's concurrency limit (the API's outbound
   * slots). Token acquisition and the waits between attempts (Retry-After, backoff) happen outside it, so a throttled
   * crawl doesn't hold a slot while it sleeps.
   */
  gate?: Gate;
  /** Applies to every request without its own `signal` (the caller's abort: a closed page, a deadline). */
  signal?: AbortSignal;
  /**
   * How often an attempt that timed out is tried again (default 1): a request that took the whole timeout once
   * usually does again, and each try costs the full timeout. Throttling and server errors keep `maxRetries`.
   */
  maxTimeoutRetries?: number;
  /** Called before every retry (telemetry: retried throttling is otherwise invisible). Never throws into the call. */
  onRetry?: (info: RetryInfo) => void;
}

/** Wraps one attempt (see HttpClientOptions.gate). */
export type Gate = <T>(attempt: () => Promise<T>) => Promise<T>;

export interface RetryInfo {
  /** HTTP status of the attempt (0 = network failure or timeout). */
  status: number;
  reason: 'throttled' | 'server' | 'network' | 'timeout';
  /** The attempt that failed (0-based). */
  attempt: number;
  delayMs: number;
  url: string;
}

/** Waits `ms` with `sleep`, or rejects as soon as `signal` aborts (with its reason). */
export async function abortableSleep(sleep: Sleep, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort!);
  }
}

/**
 * Waits `ms` on a real timer, or rejects with the signal's reason as soon as it aborts — clearing the timer, so a
 * stopping process isn't held open by the wait. For callers whose `sleep` takes the signal itself (scheduled jobs,
 * synthetic transaction probes); `abortableSleep` wraps an injected `Sleep` instead.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

const SERVER_RETRYABLE = new Set([500, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/**
 * Headers AdminForge owns on every outbound call (S-02), lower case: the bearer token, the correlation id Microsoft
 * logs (Graph's and ARM's spelling), cookies and the host — and method-override headers, which would turn a request the
 * policy judged as a POST into a DELETE or PATCH on a server that honours them. Content may never set them — the request schema refuses them
 * at validate time (a mirrored list in @adminforge/schemas, which depends on nothing but zod and yaml), the datasource
 * executor and the playbook engine refuse them at run time, and `createHttpClient` drops them from what a caller passes
 * before adding its own, so nothing can replace or double the token or the correlation id.
 */
export const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'host',
  'x-ms-client-request-id',
  'client-request-id',
  // Method overrides: the request policy judges the method a request is sent with (S-23, `readPost`).
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
]);

/** Whether `name` is one of FORBIDDEN_HEADERS, in any letter case. */
export const isForbiddenHeader = (name: string): boolean => FORBIDDEN_HEADERS.has(name.trim().toLowerCase());

/** Defaults the caller may replace (one value each, whatever the caller's letter case). */
const CALLER_OVERRIDABLE = new Set(['accept', 'content-type']);

/**
 * The headers of one attempt: AdminForge's defaults, then the caller's (forbidden names dropped; a caller Accept or
 * Content-Type replaces the default rather than joining it), then the bearer token and the correlation id.
 */
function requestHeaders(
  caller: Record<string, string> | undefined,
  own: { token: string; hasBody: boolean; correlation?: [string, string] },
): Record<string, string> {
  const out: Record<string, string> = {
    Accept: 'application/json',
    ...(own.hasBody ? { 'Content-Type': 'application/json' } : {}),
  };
  for (const [name, value] of Object.entries(caller ?? {})) {
    if (isForbiddenHeader(name)) continue;
    const lower = name.toLowerCase();
    if (CALLER_OVERRIDABLE.has(lower))
      for (const k of Object.keys(out)) if (k.toLowerCase() === lower) delete out[k];
    out[name] = value;
  }
  out.Authorization = `Bearer ${own.token}`;
  if (own.correlation) out[own.correlation[0]] = own.correlation[1];
  return out;
}

/** Longest wait a Retry-After can ask for. */
const MAX_RETRY_AFTER_MS = 120_000;
/** How far a Retry-After wait is spread either side (D-03a). */
const RETRY_AFTER_JITTER = 0.2;

/**
 * Delay before the next attempt: Retry-After (seconds or HTTP date) or exponential backoff with jitter.
 *
 * Retry-After is spread ±20 % (D-03a): when Microsoft throttles, every waiting call (and every ARM poll, which reads
 * Retry-After here too) used to come back on exactly the second it named, and be throttled together again. The wait
 * never goes past 120 s: near the cap the window is [80 % of the wait, 120 s] instead of piling up on the cap.
 */
export function retryDelay(
  retryAfter: string | null,
  attempt: number,
  random: () => number = Math.random,
): number {
  const asked = retryAfterMs(retryAfter);
  if (asked !== undefined) {
    const base = Math.min(asked, MAX_RETRY_AFTER_MS);
    const low = base * (1 - RETRY_AFTER_JITTER);
    const high = Math.min(base * (1 + RETRY_AFTER_JITTER), MAX_RETRY_AFTER_MS);
    return Math.round(low + random() * (high - low));
  }
  return Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(random() * 250);
}

/** The wait a Retry-After header asks for, in ms (delta-seconds or an HTTP date); undefined when there is none. */
function retryAfterMs(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs >= 0 ? secs * 1000 : undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(at - Date.now(), 0) : undefined;
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

/** What one attempt came to: a response to return or throw, a retry, or a fetch failure. */
type Attempt<T> =
  | { kind: 'done'; result: HttpResult<T> }
  | { kind: 'error'; error: ApiError }
  | { kind: 'retry'; status: number; retryAfter: string | null }
  | { kind: 'failed'; error: unknown };

const ungated: Gate = (attempt) => attempt();

/**
 * Authenticated JSON client with retries (Retry-After honoured), timeouts, and normalised errors. Each attempt runs
 * through `gate` (the caller's concurrency slot); waits between attempts don't hold it and end early when the
 * request is aborted.
 */
export function createHttpClient(opts: HttpClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const maxRetries = opts.maxRetries ?? 4;
  const maxTimeoutRetries = opts.maxTimeoutRetries ?? 1;
  const sleep = opts.sleep ?? defaultSleep;
  const gate = opts.gate ?? ungated;
  const reqIdHeader = opts.requestIdHeader ?? 'request-id';
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const notify = (info: RetryInfo) => {
    try {
      opts.onRetry?.(info);
    } catch {
      /* telemetry never breaks a call */
    }
  };

  async function send<T>(req: HttpRequest): Promise<HttpResult<T>> {
    const method = (req.method ?? 'GET').toUpperCase();
    const idempotent = req.idempotent ?? IDEMPOTENT_METHODS.has(method);
    const signal = req.signal ?? opts.signal;
    let timeouts = 0;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const started = performance.now();
      // Token failures (re-auth needed, not armed, …) propagate unchanged and are never retried here.
      const token = await opts.getToken();
      const outcome = await gate(async (): Promise<Attempt<T>> => {
        const signals = [signal, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter(
          (s): s is AbortSignal => !!s,
        );
        let res: Response;
        try {
          res = await doFetch(req.url, {
            method,
            ...(opts.redirect ? { redirect: opts.redirect } : {}),
            headers: requestHeaders(req.headers, {
              token,
              hasBody: req.body !== undefined,
              ...(opts.correlationId && opts.correlationHeader
                ? { correlation: [opts.correlationHeader, opts.correlationId] as [string, string] }
                : {}),
            }),
            body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
            signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
          });
        } catch (err) {
          return { kind: 'failed', error: err };
        }
        const requestId = res.headers.get(reqIdHeader) ?? res.headers.get('x-ms-request-id') ?? undefined;
        const retryAfter = res.headers.get('retry-after');
        const retryable =
          res.status === 429 ||
          (res.status === 503 && retryAfter !== null) ||
          (idempotent && SERVER_RETRYABLE.has(res.status));
        if (retryable && attempt < maxRetries) {
          await res.body?.cancel().catch(() => undefined);
          return { kind: 'retry', status: res.status, retryAfter };
        }
        // Streamed with a cap: a huge (or endless) body must not be buffered whole into memory.
        const { text } = await readBodyText(res, maxBytes, { url: req.url, requestId });
        const data = parseBody(text, res.headers.get('content-type') ?? '');
        const ms = Math.round(performance.now() - started);
        if (!res.ok)
          return {
            kind: 'error',
            error: errorFrom(res.status, res.statusText, data, res.headers, requestId),
          };
        return {
          kind: 'done',
          result: { data: data as T, status: res.status, requestId, ms, headers: res.headers },
        };
      });
      if (outcome.kind === 'done') return outcome.result;
      if (outcome.kind === 'error') throw outcome.error;
      if (outcome.kind === 'retry') {
        const delayMs = retryDelay(outcome.retryAfter, attempt);
        notify({
          status: outcome.status,
          reason: outcome.status === 429 || outcome.retryAfter !== null ? 'throttled' : 'server',
          attempt,
          delayMs,
          url: req.url,
        });
        await abortableSleep(sleep, delayMs, signal);
        continue;
      }
      // Only genuine fetch failures are retried: network errors (TypeError) and timeouts/aborts we did not ask for.
      const err = outcome.error;
      if (signal?.aborted || !isFetchFailure(err)) throw err;
      const timedOut = (err as { name?: string } | undefined)?.name === 'TimeoutError';
      if (timedOut) timeouts++;
      if (idempotent && attempt < maxRetries && (!timedOut || timeouts <= maxTimeoutRetries)) {
        const delayMs = retryDelay(null, attempt);
        notify({ status: 0, reason: timedOut ? 'timeout' : 'network', attempt, delayMs, url: req.url });
        await abortableSleep(sleep, delayMs, signal);
        continue;
      }
      throw networkError(err, req.url);
    }
  }
  return { send };
}
export type HttpClient = ReturnType<typeof createHttpClient>;
