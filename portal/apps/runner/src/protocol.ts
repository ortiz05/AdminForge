import { z } from 'zod';
import { RESPONSE_NONCE_RE } from './crypto';

/**
 * Wire protocol of the AdminForge runner.
 *
 * API → runner:   POST /v1/jobs  (RunnerJobRequest, JSON; tokens sealed, see crypto.ts)
 * runner → API:   200 application/x-ndjson, one RunnerEvent per line, starting with `accepted` and ending with
 *                 `done`. Every event carries `seq` and `mac` (signed over the request's nonce, crypto.ts) and
 *                 is verified before the API uses it. Blank lines are keep-alives and must be ignored.
 *                 Refusals are JSON with X-AdminForge-Signature.
 * worker → runner (stdout of the pwsh worker): the same log/progress/output/error events plus the
 *                 internal `ready` and `exit` messages, which never reach the API.
 */

export const RUNNER_SERVICES = ['graph', 'exchange', 'teams', 'sharepointAdmin', 'arm'] as const;
export type RunnerService = (typeof RUNNER_SERVICES)[number];

export const RUNNER_MAX_TIMEOUT_SECONDS = 1800;
export const RUNNER_DEFAULT_TIMEOUT_SECONDS = 300;

/** Relative path under ADMINFORGE_SCRIPTS_DIR, e.g. `exchange/Get-MailboxForwarding.ps1`. */
export const ScriptPathSchema = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.ps1$/, 'Expected a script path like exchange/Get-Thing.ps1');

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lower-case hex sha256');

const TokenSchema = z.string().min(1).max(32_768);
const HostLabel = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';

/** Delegated access tokens of the calling engineer, as sealed by the client (crypto.ts) and opened by the runner. */
export const RunnerTokensSchema = z.strictObject({
  graph: TokenSchema.optional(),
  exchange: TokenSchema.optional(),
  teams: TokenSchema.optional(),
  sharepointAdmin: TokenSchema.optional(),
  arm: TokenSchema.optional(),
});
export type RunnerTokens = z.output<typeof RunnerTokensSchema>;

/** Upper bound for the sealed token payload (five tokens of at most 32 KiB, JSON, base64url). */
export const SEALED_TOKENS_MAX_CHARS = 262_144;

export const RunnerJobRequestSchema = z.strictObject({
  /** Unique per job; the API uses `<runId>:<stepId>`. Reusing an id within 10 minutes is refused. */
  jobId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'Expected 1-128 characters: letters, digits, . _ : -'),
  script: z.strictObject({ path: ScriptPathSchema, sha256: Sha256Schema }),
  /** Passed to the script as a hashtable ($Inputs); never interpolated into code. */
  inputs: z.record(z.string(), z.unknown()).default({}),
  mode: z.enum(['read', 'write']),
  /**
   * The delegated tokens for the services the script declares, AES-256-GCM-sealed for this job id and request
   * timestamp (crypto.ts). Absent when the script needs no service. Plaintext tokens are refused.
   */
  sealedTokens: z.string().max(SEALED_TOKENS_MAX_CHARS).optional(),
  /** Random per request (32 bytes, base64url). The runner signs every event of its answer over it. */
  nonce: z.string().regex(RESPONSE_NONCE_RE, 'Expected a 32-byte base64url nonce'),
  tenant: z.strictObject({
    id: z.guid(),
    /** Organization for Exchange Online (e.g. the tenant's initial *.onmicrosoft.com domain). */
    domain: z
      .string()
      .max(253)
      .regex(new RegExp(`^(?:${HostLabel}\\.)+[A-Za-z]{2,63}$`), 'Expected a DNS domain'),
    /** `contoso` for https://contoso-admin.sharepoint.com — required when a sharepointAdmin token is sent. */
    spoTenantName: z
      .string()
      .regex(new RegExp(`^${HostLabel}$`), 'Expected a SharePoint tenant name')
      .optional(),
  }),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(RUNNER_MAX_TIMEOUT_SECONDS)
    .default(RUNNER_DEFAULT_TIMEOUT_SECONDS),
});

/** The request body on the wire (defaults optional). */
export type RunnerJobRequest = z.input<typeof RunnerJobRequestSchema>;
/** What a client hands to prepareRunnerJob: plaintext tokens, which are sealed before they leave the process. */
export type RunnerJobInput = Omit<RunnerJobRequest, 'sealedTokens' | 'nonce'> & { tokens?: RunnerTokens };
/** What the runner works with after validation and decryption. */
export type RunnerJob = Omit<z.output<typeof RunnerJobRequestSchema>, 'sealedTokens' | 'nonce'> & {
  tokens: RunnerTokens;
};

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type RunnerLogLevel = (typeof LOG_LEVELS)[number];

/**
 * input     script inputs failed validation
 * auth      a required token is missing or a service connection failed
 * readOnly  the script called a command that is not allowed in read-only mode
 * script    the script threw
 * timeout   the job exceeded timeoutSeconds and the worker was killed
 * cancelled the job was cancelled (API request or client disconnect)
 * runner    the worker crashed or no worker was available
 * protocol  the worker produced output the runner could not accept (too large, malformed)
 */
export const ERROR_CATEGORIES = [
  'input',
  'auth',
  'readOnly',
  'script',
  'timeout',
  'cancelled',
  'runner',
  'protocol',
] as const;
export type RunnerErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const JOB_STATUSES = ['succeeded', 'failed', 'timeout', 'cancelled'] as const;
export type RunnerJobStatus = (typeof JOB_STATUSES)[number];

export type RunnerEvent =
  | { type: 'accepted'; jobId: string }
  | { type: 'log'; level: RunnerLogLevel; message: string; ts: string }
  | { type: 'progress'; percent: number; message: string }
  | { type: 'output'; data: unknown }
  | { type: 'error'; message: string; category: RunnerErrorCategory }
  | { type: 'done'; status: RunnerJobStatus; durationMs: number };

export const RunnerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('accepted'), jobId: z.string() }),
  z.object({ type: z.literal('log'), level: z.enum(LOG_LEVELS), message: z.string(), ts: z.string() }),
  z.object({ type: z.literal('progress'), percent: z.number().min(0).max(100), message: z.string() }),
  z.object({ type: z.literal('output'), data: z.unknown() }),
  z.object({ type: z.literal('error'), message: z.string(), category: z.enum(ERROR_CATEGORIES) }),
  z.object({
    type: z.literal('done'),
    status: z.enum(JOB_STATUSES),
    durationMs: z.number().int().nonnegative(),
  }),
]);

export function encodeEvent(event: RunnerEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Sent by a worker once its modules are imported and it waits for a job on stdin. */
export interface WorkerReadyInfo {
  pid?: number;
  pwsh?: string;
  modules?: Array<{ name: string; version: string }>;
  failed?: Array<{ name: string; error: string }>;
}

/** Payload written to the worker's stdin (one JSON line). The only place tokens travel. */
export interface WorkerJobPayload {
  jobId: string;
  mode: 'read' | 'write';
  script: { path: string; sha256: string; content: string };
  inputs: Record<string, unknown>;
  tokens: RunnerTokens;
  tenant: RunnerJob['tenant'];
  timeoutSeconds: number;
}

export type WorkerMessage =
  | Extract<RunnerEvent, { type: 'log' | 'progress' | 'output' | 'error' }>
  | { type: 'ready'; info: WorkerReadyInfo }
  | { type: 'exit'; status: 'succeeded' | 'failed' };

export const MAX_MESSAGE_CHARS = 16_384;

export function truncate(text: string, max = MAX_MESSAGE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const asText = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);

/**
 * Turns one stdout line of a worker into a message. Never throws: anything that is not a well-formed
 * worker message becomes a log event so a misbehaving script cannot break the stream.
 * Returns undefined for blank lines.
 */
export function parseWorkerLine(line: string, now: () => Date = () => new Date()): WorkerMessage | undefined {
  const text = line.trim();
  if (!text) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { type: 'log', level: 'info', message: truncate(text), ts: now().toISOString() };
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    return { type: 'log', level: 'info', message: truncate(text), ts: now().toISOString() };
  }
  switch (value.type) {
    case 'log': {
      const level = LOG_LEVELS.includes(value.level as RunnerLogLevel)
        ? (value.level as RunnerLogLevel)
        : 'info';
      const ts =
        typeof value.ts === 'string' && !Number.isNaN(Date.parse(value.ts)) ? value.ts : now().toISOString();
      return { type: 'log', level, message: truncate(asText(value.message)), ts };
    }
    case 'progress': {
      const raw = Number(value.percent);
      const percent = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;
      return { type: 'progress', percent, message: truncate(asText(value.message)) };
    }
    case 'output':
      return { type: 'output', data: value.data === undefined ? null : value.data };
    case 'error': {
      const category = ERROR_CATEGORIES.includes(value.category as RunnerErrorCategory)
        ? (value.category as RunnerErrorCategory)
        : 'script';
      return { type: 'error', message: truncate(asText(value.message) || 'Script failed'), category };
    }
    case 'ready': {
      const { type: _type, ...info } = value;
      return { type: 'ready', info: info as WorkerReadyInfo };
    }
    case 'exit':
      return { type: 'exit', status: value.status === 'succeeded' ? 'succeeded' : 'failed' };
    default:
      return {
        type: 'log',
        level: 'warn',
        message: truncate(`Ignored unrecognised worker event of type "${value.type}"`),
        ts: now().toISOString(),
      };
  }
}
