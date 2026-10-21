import { yieldToLoop } from '../db/client';

/** Rows (or files) per batch: each delete holds the write lock and the event loop only briefly. */
export const RETENTION_BATCH = 2_000;
/** Longest a housekeeping pass keeps deleting; the rest goes at the next pass. */
export const RETENTION_BUDGET_MS = 2_000;

/**
 * The limits one housekeeping pass deletes within, shared by everything it prunes — retention's tables, report files,
 * News and changes items (D-02): work goes `batch` rows or files at a time with the event loop let in between, and
 * stops once the time is spent, leaving `pending` set so the caller runs the pass again soon.
 */
export interface PruneBudget {
  /** Rows or files per batch. */
  readonly batch: number;
  /** The pass stopped at its time budget with work left. */
  readonly pending: boolean;
  /** After a full batch: lets the event loop in and resolves true to go on, or false (setting `pending`) when spent. */
  next(): Promise<boolean>;
}

export interface PruneBudgetOptions {
  /** Rows or files per batch (default 2,000). */
  batch?: number;
  /** Time for the whole pass (default 2 s; `Infinity`: batches only). */
  budgetMs?: number;
  /** Milliseconds for the budget (tests); default `performance.now`. */
  clock?: () => number;
}

/** A pass's budget, started now. */
export function pruneBudget(opts: PruneBudgetOptions = {}): PruneBudget {
  const batch = opts.batch ?? RETENTION_BATCH;
  const budgetMs = opts.budgetMs ?? RETENTION_BUDGET_MS;
  const clock = opts.clock ?? (() => performance.now());
  const startedAt = clock();
  let pending = false;
  return {
    batch,
    get pending() {
      return pending;
    },
    async next() {
      if (pending) return false;
      if (clock() - startedAt >= budgetMs) {
        pending = true;
        return false;
      }
      await yieldToLoop();
      return true;
    },
  };
}
