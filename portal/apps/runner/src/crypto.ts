import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Key separation and payload protection between the API and the runner.
 *
 * RUNNER_SHARED_KEY is never used directly. Three keys are derived from it with HKDF-SHA256
 * (salt "adminforge-runner", 32 bytes each), one per purpose:
 *   request-mac       HMAC-SHA256 over every request (client.ts: canonical string)
 *   response-mac      HMAC-SHA256 over every event and error answer of the runner (proves the answer came
 *                     from the runner and belongs to this request)
 *   token-encryption  AES-256-GCM over the delegated tokens of a job
 *
 * Tokens:   sealedTokens = "v1.<iv>.<ciphertext>.<tag>" (base64url, 12-byte IV, 16-byte tag), associated data
 *           "adminforge-runner-tokens.v1.<jobId>.<X-AdminForge-Timestamp>". A process that answers on RUNNER_URL
 *           instead of the runner sees only ciphertext; a sealed payload cannot be moved to another job or request.
 * Answers:  the API sends a random `nonce` (32 bytes, base64url) with every job. Each NDJSON event carries `seq`
 *           (0, 1, 2 … in order, starting with `accepted`) and `mac` = hex(HMAC(response-mac,
 *           "adminforge-runner-event.v1.<jobId>.<nonce>.<seq>.<JSON of the event without seq and mac>")).
 *           Refusals (non-200 JSON) carry X-AdminForge-Signature = hex(HMAC(response-mac,
 *           "adminforge-runner-response.v1.<nonce>.<status>.<sha256hex(body)>")).
 */

export type RunnerKeyMaterial = string | Uint8Array;

export const RUNNER_MIN_KEY_BYTES = 32;

/** Decodes RUNNER_SHARED_KEY (base64). Raw bytes are passed through. */
export function decodeRunnerKey(key: RunnerKeyMaterial): Buffer {
  const bytes = typeof key === 'string' ? Buffer.from(key.trim(), 'base64') : Buffer.from(key);
  if (bytes.length < RUNNER_MIN_KEY_BYTES) {
    throw new Error(
      `RUNNER_SHARED_KEY must decode to at least ${RUNNER_MIN_KEY_BYTES} bytes (openssl rand -base64 32)`,
    );
  }
  return bytes;
}

const HKDF_SALT = Buffer.from('adminforge-runner', 'utf8');

export const RUNNER_KEY_PURPOSES = {
  requestMac: 'adminforge-runner/v1 request-mac',
  responseMac: 'adminforge-runner/v1 response-mac',
  tokenEncryption: 'adminforge-runner/v1 token-encryption',
} as const;
export type RunnerKeyPurpose = keyof typeof RUNNER_KEY_PURPOSES;

/** The 32-byte key for one purpose, derived from RUNNER_SHARED_KEY with HKDF-SHA256. */
export function deriveRunnerKey(key: RunnerKeyMaterial, purpose: RunnerKeyPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', decodeRunnerKey(key), HKDF_SALT, RUNNER_KEY_PURPOSES[purpose], 32));
}

const hmacHex = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest('hex');

function equalHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// ── Response nonce ──────────────────────────────────────────────────────────────────────────────────────────

export const RESPONSE_NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
export const RESPONSE_SIGNATURE_HEADER = 'x-adminforge-signature';

/** 32 random bytes, base64url (43 characters). One per request. */
export function newResponseNonce(): string {
  return randomBytes(32).toString('base64url');
}

// ── Sealed tokens ───────────────────────────────────────────────────────────────────────────────────────────

const SEALED_RE = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]*)\.([A-Za-z0-9_-]{22})$/;

export class SealedTokensError extends Error {
  override name = 'SealedTokensError';
}

const tokensAad = (jobId: string, timestamp: number | string) =>
  Buffer.from(`adminforge-runner-tokens.v1.${jobId}.${timestamp}`, 'utf8');

/** Encrypts the tokens of one job request (AES-256-GCM, associated data = job id + request timestamp). */
export function sealRunnerTokens(opts: {
  key: RunnerKeyMaterial;
  jobId: string;
  timestamp: number | string;
  tokens: Record<string, string>;
}): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveRunnerKey(opts.key, 'tokenEncryption'), iv);
  cipher.setAAD(tokensAad(opts.jobId, opts.timestamp));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(opts.tokens), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

/**
 * Decrypts sealed tokens. Throws SealedTokensError when the payload is malformed, was sealed with another key,
 * or belongs to another job or request (associated data mismatch). Returns the parsed JSON (validate it).
 */
export function openRunnerTokens(opts: {
  key: RunnerKeyMaterial;
  jobId: string;
  timestamp: number | string;
  sealed: string;
}): unknown {
  const match = SEALED_RE.exec(opts.sealed);
  if (!match) throw new SealedTokensError('sealedTokens is not a v1 sealed payload');
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveRunnerKey(opts.key, 'tokenEncryption'),
      Buffer.from(match[1]!, 'base64url'),
    );
    decipher.setAAD(tokensAad(opts.jobId, opts.timestamp));
    decipher.setAuthTag(Buffer.from(match[3]!, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(match[2]!, 'base64url')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as unknown;
  } catch {
    throw new SealedTokensError('sealedTokens could not be decrypted for this job');
  }
}

// ── Signed answers ──────────────────────────────────────────────────────────────────────────────────────────

const eventMac = (key: Buffer, jobId: string, nonce: string, seq: number, eventJson: string) =>
  hmacHex(key, `adminforge-runner-event.v1.${jobId}.${nonce}.${seq}.${eventJson}`);

/** Runner side: turns the events of one job into signed NDJSON lines (`seq` and `mac` added). */
export class RunnerEventSigner {
  private readonly key: Buffer;
  private seq = 0;

  constructor(
    key: RunnerKeyMaterial,
    private readonly jobId: string,
    private readonly nonce: string,
  ) {
    this.key = deriveRunnerKey(key, 'responseMac');
  }

  /** One NDJSON line (with the trailing newline). */
  line(event: object): string {
    const seq = this.seq++;
    const mac = eventMac(this.key, this.jobId, this.nonce, seq, JSON.stringify(event));
    return `${JSON.stringify({ ...event, seq, mac })}\n`;
  }
}

/** The answer of the runner failed verification: not from the runner, not for this request, or incomplete. */
export class RunnerResponseError extends Error {
  override name = 'RunnerResponseError';
}

/**
 * API side: verifies the events of one job, in order. `accept` returns the event without `seq`/`mac`, or throws
 * RunnerResponseError. The first event must be `accepted` for this job; nothing after `done` is accepted.
 */
export class RunnerEventVerifier {
  private readonly key: Buffer;
  private expected = 0;
  private finishedFlag = false;

  constructor(
    key: RunnerKeyMaterial,
    private readonly jobId: string,
    private readonly nonce: string,
  ) {
    this.key = deriveRunnerKey(key, 'responseMac');
  }

  /** True once a verified `done` event arrived. */
  get finished(): boolean {
    return this.finishedFlag;
  }

  /** True once the verified `accepted` event arrived. */
  get accepted(): boolean {
    return this.expected > 0;
  }

  accept(value: unknown): Record<string, unknown> & { type: string } {
    if (this.finishedFlag) throw new RunnerResponseError('The runner sent events after the job finished');
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new RunnerResponseError('The runner sent an event that is not an object');
    const { seq, mac, ...event } = value as Record<string, unknown>;
    if (seq !== this.expected || typeof mac !== 'string')
      throw new RunnerResponseError('The runner sent an unsigned or out-of-order event');
    if (!equalHex(mac, eventMac(this.key, this.jobId, this.nonce, this.expected, JSON.stringify(event))))
      throw new RunnerResponseError('The runner sent an event whose signature does not match');
    if (typeof event.type !== 'string')
      throw new RunnerResponseError('The runner sent an event without a type');
    if (this.expected === 0 && (event.type !== 'accepted' || event.jobId !== this.jobId))
      throw new RunnerResponseError('The runner did not accept this job first');
    this.expected++;
    if (event.type === 'done') this.finishedFlag = true;
    return event as Record<string, unknown> & { type: string };
  }
}

const responseMac = (key: Buffer, nonce: string, status: number, body: string) =>
  hmacHex(
    key,
    `adminforge-runner-response.v1.${nonce}.${status}.${createHash('sha256').update(body).digest('hex')}`,
  );

/** Runner side: the X-AdminForge-Signature value for a non-200 JSON answer to an authenticated job request. */
export function signRunnerResponse(opts: {
  key: RunnerKeyMaterial;
  nonce: string;
  status: number;
  body: string;
}): string {
  return responseMac(deriveRunnerKey(opts.key, 'responseMac'), opts.nonce, opts.status, opts.body);
}

/** API side: true when a non-200 answer carries a valid signature for this request's nonce. */
export function verifyRunnerResponse(opts: {
  key: RunnerKeyMaterial;
  nonce: string;
  status: number;
  body: string;
  signature: string | null | undefined;
}): boolean {
  if (!opts.signature) return false;
  return equalHex(
    opts.signature.trim().toLowerCase(),
    responseMac(deriveRunnerKey(opts.key, 'responseMac'), opts.nonce, opts.status, opts.body),
  );
}
