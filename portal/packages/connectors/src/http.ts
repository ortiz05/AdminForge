import { defaultSleep, type Sleep, type TokenProvider } from './types';

/** Error from any Microsoft REST API, normalised. */
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

export interface HttpRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
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

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function retryDelay(retryAfter: string | null, attempt: number): number {
  const secs = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 120_000);
  return Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 250);
}

function parseBody(text: string, contentType: string): unknown {
  if (!text) return undefined;
  if (contentType.includes('json')) return JSON.parse(text);
  return /^\d+$/.test(text.trim()) ? Number(text) : text;
}

function errorFrom(status: number, statusText: string, data: unknown, headers: Headers, requestId?: string): ApiError {
  const body = data as { error?: { code?: string; message?: string } | string; message?: string } | undefined;
  const err = typeof body?.error === 'object' ? body.error : undefined;
  const code = err?.code ?? (typeof body?.error === 'string' ? body.error : `HTTP${status}`);
  const message = err?.message ?? body?.message ?? statusText;
  const claims = /claims="([^"]+)"/.exec(headers.get('www-authenticate') ?? '')?.[1];
  return new ApiError(status, code, message, requestId, claims);
}

/** Authenticated JSON client with retries (Retry-After honoured), timeouts, and normalised errors. */
export function createHttpClient(opts: HttpClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const maxRetries = opts.maxRetries ?? 4;
  const sleep = opts.sleep ?? defaultSleep;
  const reqIdHeader = opts.requestIdHeader ?? 'request-id';

  async function send<T>(req: HttpRequest): Promise<HttpResult<T>> {
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      const res = await doFetch(req.url, {
        method: req.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${await opts.getToken()}`,
          Accept: 'application/json',
          ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.correlationId && opts.correlationHeader ? { [opts.correlationHeader]: opts.correlationId } : {}),
          ...req.headers,
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
      });
      const requestId = res.headers.get(reqIdHeader) ?? res.headers.get('x-ms-request-id') ?? undefined;
      if (RETRYABLE.has(res.status) && attempt < maxRetries) {
        await sleep(retryDelay(res.headers.get('retry-after'), attempt));
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
