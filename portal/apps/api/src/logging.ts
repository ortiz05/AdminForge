/**
 * Log serializers. A failed database query arrives as drizzle's DrizzleQueryError, whose message, stack and `params`
 * carry every bound value — CSRF tokens, PKCE verifiers, sealed token blobs, raw run inputs. A database driver's own error
 * may add the offending values (`detail`). None of that may reach a log line.
 */

const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;
const MAX_DEPTH = 3;
/** Own properties that carry bound values (drizzle `params`, a driver's `detail`, `parameters`). */
const DROPPED = new Set(['params', 'parameters', 'detail', 'values']);

/** Drops drizzle's "\nparams: …" tail from an error message (and from the message part of a stack). */
export function stripParams(text: string): string {
  return text.replace(/\nparams:[\s\S]*?(?=\n\s+at\s|$)/, '\nparams: [redacted]');
}

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

function serialize(err: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (!err || typeof err !== 'object') return err;
  if (seen.has(err)) return '[circular]';
  seen.add(err);
  const e = err as Error & Record<string, unknown>;
  const out: Record<string, unknown> = {
    type: (e.constructor as { name?: string } | undefined)?.name ?? e.name ?? 'Error',
  };
  if (typeof e.message === 'string') out.message = truncate(stripParams(e.message), MAX_MESSAGE);
  if (typeof e.stack === 'string') out.stack = truncate(stripParams(e.stack), MAX_STACK);
  for (const [k, v] of Object.entries(e)) {
    if (k === 'message' || k === 'stack' || k === 'cause' || DROPPED.has(k) || typeof v === 'function')
      continue;
    out[k] = typeof v === 'string' ? truncate(stripParams(v), MAX_MESSAGE) : v;
  }
  if (e.cause !== undefined)
    out.cause = depth < MAX_DEPTH ? serialize(e.cause, depth + 1, seen) : '[truncated]';
  return out;
}

export interface SerializedError {
  [key: string]: unknown;
  type: string;
  message: string;
  stack: string;
}

/** pino `err` serializer: type, message, stack and own properties — never bound query parameters. */
export function serializeError(err: unknown): SerializedError {
  if (!err || typeof err !== 'object')
    return { type: typeof err, message: truncate(stripParams(String(err)), MAX_MESSAGE), stack: '' };
  const out = serialize(err, 0, new WeakSet()) as Record<string, unknown>;
  return {
    ...out,
    type: String(out.type ?? 'Error'),
    message: typeof out.message === 'string' ? out.message : '',
    stack: typeof out.stack === 'string' ? out.stack : '',
  };
}

/** For the worker and scheduler's own JSON loggers: `err`/`error` fields go through serializeError (no query params). */
export function safeLogFields(fields: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, k === 'err' || k === 'error' ? serializeError(v) : v]),
  );
}
