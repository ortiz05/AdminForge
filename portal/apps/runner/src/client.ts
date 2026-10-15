import { createHash, createHmac } from 'node:crypto';
import { type RunnerEvent, type RunnerJobRequest, RunnerEventSchema } from './protocol';

/**
 * Client side of the runner protocol, used by the AdminForge API (and tests).
 *
 * Every request carries:
 *   Authorization:          AdminForge-HMAC <hex>
 *   X-AdminForge-Timestamp: <unix seconds>
 * where
 *   <hex>     = hex(HMAC-SHA256(key, canonical))
 *   key       = base64-decoded RUNNER_SHARED_KEY (at least 32 bytes)
 *   canonical = `${timestamp}.${METHOD}.${pathAndQuery}.${sha256hex(body)}`
 *     timestamp     the X-AdminForge-Timestamp value (unix seconds)
 *     METHOD        the HTTP method, upper-case (GET, POST)
 *     pathAndQuery  the request target exactly as sent on the wire: path plus query string, no scheme or
 *                   host, percent-encoding as sent (e.g. /v1/jobs/run-1%3Astep-2/cancel)
 *     body          the exact request body bytes ('' for GET and body-less POST)
 * e.g. "1792034653.POST./v1/jobs/abc/cancel.e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
 * The runner accepts timestamps within ±60 s of its clock. Binding method and path means a captured
 * signature cannot be replayed against another endpoint or another job.
 */
export const RUNNER_AUTH_SCHEME = 'AdminForge-HMAC';
export const RUNNER_TIMESTAMP_HEADER = 'x-adminforge-timestamp';
export const RUNNER_MAX_CLOCK_SKEW_SECONDS = 60;
export const RUNNER_MIN_KEY_BYTES = 32;

export type RunnerKey = string | Uint8Array;
export type RunnerBody = string | Uint8Array;

/** Decodes RUNNER_SHARED_KEY (base64). Raw bytes are passed through. */
export function decodeRunnerKey(key: RunnerKey): Buffer {
  const bytes = typeof key === 'string' ? Buffer.from(key.trim(), 'base64') : Buffer.from(key);
  if (bytes.length < RUNNER_MIN_KEY_BYTES) {
    throw new Error(
      `RUNNER_SHARED_KEY must decode to at least ${RUNNER_MIN_KEY_BYTES} bytes (openssl rand -base64 32)`,
    );
  }
  return bytes;
}

export function sha256Hex(body: RunnerBody): string {
  return createHash('sha256').update(body).digest('hex');
}

export interface RunnerSignatureInput {
  key: RunnerKey;
  timestamp: number | string;
  /** HTTP method; upper-cased before signing. */
  method: string;
  /** Path plus query exactly as sent, starting with "/" (e.g. "/v1/jobs/abc/cancel"). */
  path: string;
  body?: RunnerBody;
}

/** The string that is signed: `${timestamp}.${METHOD}.${pathAndQuery}.${sha256hex(body)}`. */
export function canonicalRunnerString(input: Omit<RunnerSignatureInput, 'key'>): string {
  const method = input.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new Error(`Invalid HTTP method for runner signing: ${input.method}`);
  if (!input.path.startsWith('/')) {
    throw new Error('Runner signing needs the request path (and query) starting with "/", not a full URL');
  }
  return `${input.timestamp}.${method}.${input.path}.${sha256Hex(input.body ?? '')}`;
}

/** HMAC-SHA256 over the canonical string, hex encoded. */
export function computeRunnerSignature(input: RunnerSignatureInput): string {
  return createHmac('sha256', decodeRunnerKey(input.key)).update(canonicalRunnerString(input)).digest('hex');
}

export type RunnerSignatureHeaders = Record<string, string> & {
  authorization: string;
  'x-adminforge-timestamp': string;
};

/**
 * Headers for one runner request. `method` and `path` are required: sign the exact method, path + query
 * and body bytes you send (JSON.stringify once, reuse the string).
 */
export function signRunnerRequest(opts: {
  key: RunnerKey;
  method: string;
  path: string;
  body?: RunnerBody;
  timestamp?: number;
}): RunnerSignatureHeaders {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = computeRunnerSignature({ ...opts, timestamp });
  return {
    authorization: `${RUNNER_AUTH_SCHEME} ${signature}`,
    'x-adminforge-timestamp': String(timestamp),
  };
}

/** The path + query of a URL exactly as fetch sends it. */
export function requestTarget(url: URL): string {
  return `${url.pathname}${url.search}`;
}

/**
 * Parses an NDJSON byte stream into values. Blank lines are keep-alives and are skipped.
 * Accepts a WHATWG ReadableStream (fetch Response.body) or any async iterable of bytes (Node streams).
 */
export async function* readNdjson(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  const iterable: AsyncIterable<Uint8Array | string> =
    Symbol.asyncIterator in body
      ? (body as AsyncIterable<Uint8Array | string>)
      : streamToIterable(body as ReadableStream<Uint8Array>);
  for await (const chunk of iterable) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as unknown;
      newline = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer) as unknown;
}

async function* streamToIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** A non-200 answer from the runner (validation, auth, hash mismatch, busy …). */
export class RunnerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RunnerRequestError';
  }
}

export interface RunnerClientOptions {
  /** e.g. http://127.0.0.1:3101 (RUNNER_URL). */
  baseUrl: string;
  /** RUNNER_SHARED_KEY (base64). */
  key: RunnerKey;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/**
 * Submits a job and yields its events as they arrive, ending with `done`.
 * Throws RunnerRequestError when the runner refuses the job before it starts.
 */
export async function* submitRunnerJob(
  opts: RunnerClientOptions & { job: RunnerJobRequest },
): AsyncGenerator<RunnerEvent> {
  const body = JSON.stringify(opts.job);
  const url = new URL('/v1/jobs', opts.baseUrl);
  const res = await (opts.fetch ?? fetch)(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...signRunnerRequest({ key: opts.key, method: 'POST', path: requestTarget(url), body }),
    },
    body,
    signal: opts.signal,
  });
  if (res.status !== 200 || !res.body) throw await toRequestError(res);
  for await (const value of readNdjson(res.body)) {
    const parsed = RunnerEventSchema.safeParse(value);
    if (parsed.success) yield parsed.data as RunnerEvent;
  }
}

/** Asks the runner to stop a running job. Returns false when the runner does not know the job. */
export async function cancelRunnerJob(opts: RunnerClientOptions & { jobId: string }): Promise<boolean> {
  const url = new URL(`/v1/jobs/${encodeURIComponent(opts.jobId)}/cancel`, opts.baseUrl);
  const res = await (opts.fetch ?? fetch)(url, {
    method: 'POST',
    headers: signRunnerRequest({ key: opts.key, method: 'POST', path: requestTarget(url) }),
    signal: opts.signal,
  });
  if (res.status === 404) return false;
  if (res.status !== 202) throw await toRequestError(res);
  return true;
}

async function toRequestError(res: Response): Promise<RunnerRequestError> {
  let code = 'runner_error';
  let message = `Runner answered ${res.status}`;
  try {
    const payload = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof payload.error === 'string') code = payload.error;
    if (typeof payload.message === 'string') message = payload.message;
  } catch {
    // non-JSON error body
  }
  return new RunnerRequestError(res.status, code, message);
}
