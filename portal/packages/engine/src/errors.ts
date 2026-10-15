import { ApiError, isTransient } from '@adminforge/connectors';
import { ExpressionError } from '@adminforge/expressions';
import type { RunError, RunStatus } from './types';

/**
 * The identity a step needs is not usable right now. The engine parks the run instead of failing it:
 * `not_armed` → `awaiting_arm`, `reauth` → `awaiting_reauth`. Adapters translate their own token errors into this.
 */
export class IdentityUnavailable extends Error {
  constructor(
    readonly reason: 'not_armed' | 'reauth',
    message?: string,
  ) {
    super(
      message ??
        (reason === 'not_armed'
          ? 'Write access is not armed.'
          : 'The sign-in behind this run needs to be refreshed.'),
    );
    this.name = 'IdentityUnavailable';
  }

  get parkStatus(): RunStatus {
    return this.reason === 'not_armed' ? 'awaiting_arm' : 'awaiting_reauth';
  }
}

/** A step-level failure with a stable code. `transient` failures are retried when the step declares `retry`. */
export class StepError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly opts: {
      transient?: boolean;
      status?: number;
      requestId?: string;
      retryAfterMs?: number;
      details?: Record<string, unknown>;
      /** Next step for the person (shown with the run's failure). */
      hint?: string;
    } = {},
  ) {
    super(message);
    this.name = 'StepError';
  }
}

/** Raised inside the engine when the run was cancelled (API) or its signal aborted. */
export class RunCancelled extends Error {
  constructor() {
    super('The run was cancelled.');
    this.name = 'RunCancelled';
  }
}

/** 429 / 5xx / network failures (connectors' ApiError), or an error marked `transient: true` (StepError option). */
export function isTransientError(err: unknown): boolean {
  if (err instanceof StepError) return err.opts.transient === true;
  if (isTransient(err)) return true;
  return (err as { transient?: unknown } | undefined)?.transient === true;
}

/** Retry-After carried by an error (ms), when the service sent one. */
export function retryAfterMs(err: unknown): number | undefined {
  if (err instanceof StepError) return err.opts.retryAfterMs;
  const v = (err as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  return typeof v === 'number' && v >= 0 ? v : undefined;
}

/** Normalises anything a step threw into a RunError. */
export function toRunError(err: unknown, at?: { stepId: string; path: string }): RunError {
  const where = at ? { stepId: at.stepId, path: at.path } : {};
  if (err instanceof StepError) {
    return {
      code: err.code,
      message: err.message,
      ...where,
      ...(err.opts.status !== undefined ? { status: err.opts.status } : {}),
      ...(err.opts.requestId ? { requestId: err.opts.requestId } : {}),
      ...(err.opts.details ? { details: err.opts.details } : {}),
      ...(err.opts.hint ? { hint: err.opts.hint } : {}),
    };
  }
  if (err instanceof ApiError) {
    // The API's OutboundError subclass carries an actionable hint (which role, licence or permission is missing).
    const hint = (err as { hint?: unknown }).hint;
    return {
      code: err.code || `HTTP${err.status}`,
      message: err.message,
      ...where,
      status: err.status,
      ...(err.requestId ? { requestId: err.requestId } : {}),
      ...(typeof hint === 'string' && hint ? { hint } : {}),
    };
  }
  if (err instanceof ExpressionError) {
    return {
      code: 'expression_error',
      message: err.message,
      ...where,
      ...(err.path ? { details: { field: err.path } } : {}),
    };
  }
  const e = err as { code?: unknown; message?: unknown; status?: unknown; requestId?: unknown } | undefined;
  return {
    code: typeof e?.code === 'string' ? e.code : 'step_error',
    message: typeof e?.message === 'string' ? e.message : String(err),
    ...where,
    ...(typeof e?.status === 'number' ? { status: e.status } : {}),
    ...(typeof e?.requestId === 'string' ? { requestId: e.requestId } : {}),
  };
}
