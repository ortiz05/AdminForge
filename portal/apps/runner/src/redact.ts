/**
 * Token redaction. Every line that leaves a worker (stdout or stderr) passes through the job's redactor
 * before it is parsed, streamed to the API, or logged; the supervisor's own log lines pass through the
 * generic patterns. Tokens are base64url + dots, which JSON never escapes, so redacting the raw line also
 * covers values nested anywhere inside an event.
 */
export const REDACTED = '[REDACTED]';

const GENERIC_PATTERNS: Array<[RegExp, string]> = [
  // JWTs (header.payload.signature) — Entra access tokens always start with eyJ.
  [/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Bearer credentials in echoed headers.
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, `$1${REDACTED}`],
];

export type Redactor = (text: string) => string;

/** Redacts the given secrets (exact matches, longest first) plus the generic patterns. */
export function createRedactor(secrets: Iterable<string | undefined | null> = []): Redactor {
  const exact = [
    ...new Set([...secrets].filter((s): s is string => typeof s === 'string' && s.length >= 8)),
  ].sort((a, b) => b.length - a.length);
  return (text: string) => {
    let out = text;
    for (const secret of exact) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    for (const [pattern, replacement] of GENERIC_PATTERNS) out = out.replace(pattern, replacement);
    return out;
  };
}

/** Generic-pattern redaction for supervisor log lines. */
export const redactGeneric: Redactor = createRedactor();

/**
 * Deep-redacts strings inside arrays and plain objects (used for supervisor log arguments). Class instances
 * (e.g. the request objects Fastify hands to its serializers) are passed through untouched.
 */
export function redactDeep<T>(value: T, redact: Redactor = redactGeneric, depth = 0): T {
  if (typeof value === 'string') return redact(value) as T;
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    const copy = new Error(redact(value.message));
    copy.name = value.name;
    if (value.stack) copy.stack = redact(value.stack);
    return copy as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact, depth + 1)) as T;
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact, depth + 1);
  return out as T;
}
