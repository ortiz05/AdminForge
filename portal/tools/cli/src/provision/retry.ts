/**
 * Retries for Entra and ARM replication delays: an object created a moment ago can be "not found" on the next call
 * (or PrincipalNotFound in ARM). `withReplicationRetry` retries only those errors (`isReplicationDelay`, or the
 * caller's `isRetryable`) with backoff; sleep and attempts are injectable so tests run instantly. Used by the
 * provisioning apply steps.
 */
import { ApiError, defaultSleep, type Sleep } from '@adminforge/connectors';

/**
 * Entra objects take seconds to replicate: a just-created application, service principal, group, or user can
 * be "not found" by the next call, and ARM reports PrincipalNotFound until the principal reaches it.
 */
export function isReplicationDelay(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.code === 'PrincipalNotFound' || err.code === 'Request_ResourceNotFound') return true;
  if (err.status === 404) return true;
  if (err.status === 400) {
    return /does not exist|do not exist|not found|cannot be found|could not be found|Invalid object identifier|reference-property objects are not present|no service principal|not present in the directory|does not reference a valid/i.test(
      err.message,
    );
  }
  return false;
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: Sleep;
  isRetryable?: (err: unknown) => boolean;
  /** Called before each wait (e.g. to print "waiting for replication…"). */
  onRetry?: (err: unknown, attempt: number, waitMs: number) => void;
}

/** Retries `fn` with exponential backoff while the error looks like replication delay. */
export async function withReplicationRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 8;
  const baseMs = opts.baseMs ?? 2000;
  const maxMs = opts.maxMs ?? 20_000;
  const sleep = opts.sleep ?? defaultSleep;
  const retryable = opts.isRetryable ?? isReplicationDelay;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !retryable(err)) throw err;
      const wait = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
      opts.onRetry?.(err, attempt, wait);
      await sleep(wait);
    }
  }
}
