import type { Action, PlanOp, Section } from './model';

export type Out = (line: string) => void;

const PLAN_MARK: Record<Action, string> = {
  create: '+ create',
  update: '~ update',
  delete: '- remove',
  noop: '= no-op ',
  skip: '! skip  ',
};
const STATUS_MARK: Record<Action, string> = { noop: '✓', create: '✗', update: '✗', delete: '✗', skip: '⚠' };

/** Operations that change something (what `provision status` counts as not in the desired state). */
export const isChange = (op: Pick<PlanOp, 'action'>) =>
  op.action === 'create' || op.action === 'update' || op.action === 'delete';

function bySection<T extends PlanOp>(ops: T[]): Map<Section, T[]> {
  const map = new Map<Section, T[]>();
  for (const op of ops) map.set(op.section, [...(map.get(op.section) ?? []), op]);
  return map;
}

export function counts(ops: PlanOp[]) {
  const n = (a: Action) => ops.filter((o) => o.action === a).length;
  return {
    create: n('create'),
    update: n('update'),
    delete: n('delete'),
    noop: n('noop'),
    skip: n('skip'),
    /** Everything that changes something. */
    changes: n('create') + n('update') + n('delete'),
  };
}

export const summaryLine = (ops: PlanOp[]) => {
  const c = counts(ops);
  return `${c.create} to create, ${c.update} to update, ${c.delete ? `${c.delete} to remove, ` : ''}${c.noop} unchanged, ${c.skip} skipped`;
};

/** Plan view: one line per object with create/update/no-op/skip and what differs. */
export function renderPlan(ops: PlanOp[], out: Out): void {
  for (const [section, list] of bySection(ops)) {
    out(`  ${section}`);
    for (const op of list) {
      const why = op.changes?.length ? `  (${op.changes.join(', ')})` : '';
      out(`    ${PLAN_MARK[op.action]}  ${op.title}${why}`);
    }
  }
  out(`  Plan: ${summaryLine(ops)}`);
}

/** Status view: ✓ in the desired state, ✗ missing or drifted, ⚠ cannot be provisioned here. */
export function renderStatus(ops: PlanOp[], out: Out): void {
  for (const [section, list] of bySection(ops)) {
    out(`  ${section}`);
    for (const op of list) {
      const why =
        op.action !== 'noop' && op.changes?.length
          ? ` — ${op.changes.join(', ')}`
          : op.action === 'create'
            ? ' — missing'
            : op.action === 'delete'
              ? ' — to remove'
              : '';
      out(`    ${STATUS_MARK[op.action]} ${op.title}${why}`);
      if (op.detail) out(`        ${op.detail}`);
    }
  }
}
