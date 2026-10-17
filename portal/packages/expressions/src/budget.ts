/**
 * One time budget for a whole evaluation, sub-expressions included. `evaluate` binds the absolute deadline as
 * `$__afDeadline`; the native fast paths (order-by.ts, group-by.ts) evaluate their per-item sub-expressions with it
 * bound too, and every sub-expression checks it at each evaluation step (`deadlineGuard`), so a sort term or a group
 * key evaluated once per row gets only what is left of the budget — never a fresh 250 ms per row.
 */

/** Variable that carries the evaluation's deadline (epoch ms). */
export const DEADLINE_BINDING = '__afDeadline';

/** JSONata's own timeout error shape (D1012), as the evaluator reports it. */
export const timeoutError = (timeoutMs: number) => ({
  code: 'D1012',
  value: timeoutMs,
  stack: new Error().stack,
});

/** Throws D1012 once `deadline` (epoch ms) has passed. */
export function checkDeadline(deadline: unknown, timeoutMs: number): void {
  if (typeof deadline === 'number' && Date.now() > deadline) throw timeoutError(timeoutMs);
}

/**
 * An `__evaluate_entry` hook for sub-expressions: JSONata calls it before every evaluation step with the step's
 * environment, where `$__afDeadline` is bound when the caller passed it.
 */
export const deadlineGuard =
  (timeoutMs: number) =>
  (_expr: unknown, _input: unknown, environment: { lookup(name: string): unknown }): void =>
    checkDeadline(environment.lookup(DEADLINE_BINDING), timeoutMs);
