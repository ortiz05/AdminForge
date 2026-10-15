import type { Playbook } from '@adminforge/schemas';

/**
 * Bulk actions (R9: "bulk actions are playbooks with forEach"). A bulk run is a parent run whose definition is
 * synthesised from the pinned target playbook: one `forEach` over `inputs.items` (per-item inputs, already validated
 * against the target's `inputs:`) whose body is a `playbook` step — so every item becomes its own child run with its
 * own approvals, audit trail and compensation, and the parent shows progress and the per-item results.
 */

export const BULK_LOOP_ID = 'items';
export const BULK_CHILD_ID = 'run';
export const BULK_MAX_CONCURRENCY = 10;

export interface BulkOptions {
  /** Items in flight at once (default 5, ≤ 10). */
  concurrency?: number;
  /** Stop launching items after the first failure (default false: every item is attempted). */
  stopOnError?: boolean;
}

/** Parent-run inputs of a bulk run. */
export interface BulkInputs {
  items: Array<Record<string, unknown>>;
  concurrency?: number;
  stopOnError?: boolean;
}

export function bulkDefinition(target: Playbook, opts: BulkOptions = {}): Playbook {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 5, BULK_MAX_CONCURRENCY));
  const child = {
    id: BULK_CHILD_ID,
    type: 'playbook',
    ref: target.id,
    version: target.version,
    mode: target.mode,
    describe: target.title,
    // Whole-expression template: the item object is passed as data, never re-rendered.
    inputs: '${ item }' as unknown as Record<string, unknown>,
  };
  return {
    kind: 'playbook',
    id: target.id,
    version: target.version,
    title: `${target.title} (bulk)`,
    ...(target.summary ? { summary: target.summary } : {}),
    owner: target.owner,
    risk: target.risk,
    mode: target.mode,
    ...(target.requires ? { requires: target.requires } : {}),
    steps: [
      {
        id: BULK_LOOP_ID,
        type: 'forEach',
        name: `${target.title} × items`,
        items: '${ inputs.items }',
        as: 'item',
        concurrency,
        maxItems: 1000,
        onError: opts.stopOnError ? 'fail' : 'continue',
        steps: [child],
      },
    ],
    outputs: {
      total: '${ $count(inputs.items) }',
      succeeded: `\${ $count(steps.${BULK_LOOP_ID}.output[status = 'succeeded']) }`,
      failed: `\${ $count(steps.${BULK_LOOP_ID}.output[status = 'failed']) }`,
    },
  } as Playbook;
}
