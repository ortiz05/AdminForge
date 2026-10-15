import { timingSafeEqual } from 'node:crypto';
import { RUNNER_AUTH_SCHEME, RUNNER_MAX_CLOCK_SKEW_SECONDS, computeRunnerSignature } from './client';

export type AuthFailureReason =
  | 'missing_signature'
  | 'malformed_signature'
  | 'missing_timestamp'
  | 'stale_timestamp'
  | 'before_start'
  | 'bad_signature';

export type AuthResult = { ok: true } | { ok: false; reason: AuthFailureReason };

const SIGNATURE_RE = new RegExp(`^${RUNNER_AUTH_SCHEME} ([0-9a-f]{64})$`);
const TIMESTAMP_RE = /^\d{1,12}$/;

/**
 * Verifies `Authorization: AdminForge-HMAC <hex>` + `X-AdminForge-Timestamp` over the method, request target
 * (path + query) and raw body — see the canonical string in client.ts.
 * The timestamp must be within ±maxSkewSeconds of now (replay window).
 */
export function verifyRunnerRequest(opts: {
  key: Buffer;
  authorization: string | undefined;
  timestamp: string | undefined;
  /** HTTP method of the request as received. */
  method: string;
  /** Request target as received (path + query, e.g. request.raw.url). */
  path: string;
  body: Buffer;
  nowSeconds?: number;
  maxSkewSeconds?: number;
  /**
   * Unix seconds when this runner process started. The replay cache (job ids) lives in memory, so a request signed
   * before the process started could only be a replay across a restart; it is refused.
   */
  notBeforeSeconds?: number;
}): AuthResult {
  if (!opts.authorization) return { ok: false, reason: 'missing_signature' };
  const match = SIGNATURE_RE.exec(opts.authorization.trim());
  if (!match) return { ok: false, reason: 'malformed_signature' };
  if (!opts.timestamp) return { ok: false, reason: 'missing_timestamp' };
  if (!TIMESTAMP_RE.test(opts.timestamp)) return { ok: false, reason: 'stale_timestamp' };
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(opts.timestamp)) > (opts.maxSkewSeconds ?? RUNNER_MAX_CLOCK_SKEW_SECONDS)) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  if (opts.notBeforeSeconds !== undefined && Number(opts.timestamp) < opts.notBeforeSeconds) {
    return { ok: false, reason: 'before_start' };
  }
  let expectedHex: string;
  try {
    expectedHex = computeRunnerSignature({
      key: opts.key,
      timestamp: opts.timestamp,
      method: opts.method,
      path: opts.path,
      body: opts.body,
    });
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  const expected = Buffer.from(expectedHex, 'hex');
  const given = Buffer.from(match[1]!, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}
