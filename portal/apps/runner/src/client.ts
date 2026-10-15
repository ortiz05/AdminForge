import { createHash, createHmac } from 'node:crypto';
import {
  RESPONSE_SIGNATURE_HEADER,
  RunnerEventVerifier,
  RunnerResponseError,
  deriveRunnerKey,
  newResponseNonce,
  sealRunnerTokens,
  verifyRunnerResponse,
} from './crypto';
import { type RunnerEvent, type RunnerJobInput, RunnerEventSchema } from './protocol';

export { decodeRunnerKey, RUNNER_MIN_KEY_BYTES } from './crypto';

/**
 * Client side of the runner protocol, used by the AdminForge API (and tests).
 *
 * Every request carries:
 *   Authorization:          AdminForge-HMAC <hex>
 *   X-AdminForge-Timestamp: <unix seconds>
 * where
 *   <hex>     = hex(HMAC-SHA256(request-mac key, canonical))
 *   key       = HKDF-SHA256 of the base64-decoded RUNNER_SHARED_KEY (at least 32 bytes), see crypto.ts
 *   canonical = `${timestamp}.${METHOD}.${pathAndQuery}.${sha256hex(body)}`
 *     timestamp     the X-AdminForge-Timestamp value (unix seconds)
 *     METHOD        the HTTP method, upper-case (GET, POST)
 *     pathAndQuery  the request target exactly as sent on the wire: path plus query string, no scheme or
 *                   host, percent-encoding as sent (e.g. /v1/jobs/run-1%3Astep-2/cancel)
 *     body          the exact request body bytes ('' for GET and body-less POST)
 * e.g. "1792034653.POST./v1/jobs/abc/cancel.e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
 * The runner accepts timestamps within ±60 s of its clock. Binding method and path means a captured
 * signature cannot be replayed against another endpoint or another job.
 *
 * Job requests additionally seal the delegated tokens (AES-256-GCM, bound to the job id and timestamp) and carry
 * a nonce over which the runner signs every event of its answer; see crypto.ts. Redirects are refused.
 */
export const RUNNER_AUTH_SCHEME = 'AdminForge-HMAC';
export const RUNNER_TIMESTAMP_HEADER = 'x-adminforge-timestamp';
export const RUNNER_MAX_CLOCK_SKEW_SECONDS = 60;
/** Longest NDJSON line a client accepts (the runner caps a worker line at 8 Mi characters). */
export const RUNNER_MAX_LINE_CHARS = 16 * 1024 * 1024;

export type RunnerKey = string | Uint8Array;
export type RunnerBody = string | Uint8Array;

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

/** HMAC-SHA256 (request-mac key) over the canonical string, hex encoded. */
export function computeRunnerSignature(input: RunnerSignatureInput): string {
  return createHmac('sha256', deriveRunnerKey(input.key, 'requestMac'))
    .update(canonicalRunnerString(input))
    .digest('hex');
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

export interface PreparedRunnerJob {
  jobId: string;
  /** Sent with the job; the runner signs its answer over it. */
  nonce: string;
  /** The exact body to send (tokens sealed). */
  body: string;
  headers: RunnerSignatureHeaders & { 'content-type': string };
}

/**
 * Builds a signed job request: seals the tokens for this job and timestamp, adds a fresh nonce, and signs the
 * body. Plaintext tokens never appear in the body.
 */
export function prepareRunnerJob(opts: {
  key: RunnerKey;
  job: RunnerJobInput;
  /** Request target (default /v1/jobs). */
  path?: string;
  timestamp?: number;
  nonce?: string;
}): PreparedRunnerJob {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? newResponseNonce();
  const { tokens, ...rest } = opts.job;
  const present = Object.fromEntries(
    Object.entries(tokens ?? {}).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
    ),
  );
  const body = JSON.stringify({
    ...rest,
    ...(Object.keys(present).length
      ? { sealedTokens: sealRunnerTokens({ key: opts.key, jobId: rest.jobId, timestamp, tokens: present }) }
      : {}),
    nonce,
  });
  return {
    jobId: rest.jobId,
    nonce,
    body,
    headers: {
      'content-type': 'application/json',
      ...signRunnerRequest({ key: opts.key, method: 'POST', path: opts.path ?? '/v1/jobs', body, timestamp }),
    },
  };
}

/**
 * Parses an NDJSON byte stream into values. Blank lines are keep-alives and are skipped. A line longer than
 * maxLineChars fails the stream (a well-behaved runner never sends one).
 * Accepts a WHATWG ReadableStream (fetch Response.body) or any async iterable of bytes (Node streams).
 */
export async function* readNdjson(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>,
  maxLineChars = RUNNER_MAX_LINE_CHARS,
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
    if (buffer.length > maxLineChars)
      throw new RunnerResponseError('The runner sent a line that is too long');
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
    /** False when the answer carried no valid runner signature (code and message are then generic). */
    readonly verified = true,
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
 * Reads a non-200 job answer. Its code and message are used only when the runner signed it for this request;
 * anything else (another process on the port, a proxy, an unauthenticated request) gets a generic error.
 */
export async function readRunnerRefusal(
  res: Response,
  opts: { key: RunnerKey; nonce: string },
): Promise<{ verified: boolean; code: string; message: string }> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    // unreadable body
  }
  const verified = verifyRunnerResponse({
    key: opts.key,
    nonce: opts.nonce,
    status: res.status,
    body: text,
    signature: res.headers.get(RESPONSE_SIGNATURE_HEADER),
  });
  if (verified) {
    try {
      const payload = JSON.parse(text) as { error?: unknown; message?: unknown };
      return {
        verified,
        code: typeof payload.error === 'string' ? payload.error : 'runner_error',
        message: typeof payload.message === 'string' ? payload.message : `Runner answered ${res.status}`,
      };
    } catch {
      // signed but not JSON
    }
  }
  return {
    verified,
    code: verified ? 'runner_error' : 'unverified_response',
    message: verified
      ? `Runner answered ${res.status}`
      : `Runner answered ${res.status} without a valid signature for this request`,
  };
}

/**
 * Submits a job and yields its verified events as they arrive, ending with `done`.
 * Throws RunnerRequestError when the runner refuses the job before it starts, and RunnerResponseError when the
 * answer is not signed by the runner for this request or ends without `done`.
 */
export async function* submitRunnerJob(
  opts: RunnerClientOptions & { job: RunnerJobInput },
): AsyncGenerator<RunnerEvent> {
  const url = new URL('/v1/jobs', opts.baseUrl);
  const prepared = prepareRunnerJob({ key: opts.key, job: opts.job, path: requestTarget(url) });
  const res = await (opts.fetch ?? fetch)(url, {
    method: 'POST',
    headers: prepared.headers,
    body: prepared.body,
    redirect: 'error',
    signal: opts.signal,
  });
  if (res.status !== 200 || !res.body) {
    const refusal = await readRunnerRefusal(res, { key: opts.key, nonce: prepared.nonce });
    throw new RunnerRequestError(res.status, refusal.code, refusal.message, refusal.verified);
  }
  const verifier = new RunnerEventVerifier(opts.key, prepared.jobId, prepared.nonce);
  for await (const value of readNdjson(res.body)) {
    const event = verifier.accept(value);
    const parsed = RunnerEventSchema.safeParse(event);
    if (parsed.success) yield parsed.data as RunnerEvent;
    if (verifier.finished) break;
  }
  if (!verifier.finished) throw new RunnerResponseError('The runner answer ended before the job finished');
}

/** Asks the runner to stop a running job. Returns false when the runner does not know the job. */
export async function cancelRunnerJob(opts: RunnerClientOptions & { jobId: string }): Promise<boolean> {
  const url = new URL(`/v1/jobs/${encodeURIComponent(opts.jobId)}/cancel`, opts.baseUrl);
  const res = await (opts.fetch ?? fetch)(url, {
    method: 'POST',
    headers: signRunnerRequest({ key: opts.key, method: 'POST', path: requestTarget(url) }),
    redirect: 'error',
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
  return new RunnerRequestError(res.status, code, message, false);
}
