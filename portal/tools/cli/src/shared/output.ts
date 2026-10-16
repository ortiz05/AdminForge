/**
 * Terminal output for every command.
 *
 * `Out` is how commands print: one line per call, injected so tests collect lines instead of writing to stdout
 * (`index.ts` passes `console.log`). The renderers turn a list of planned operations into the two views the
 * provisioning commands share:
 *   - plan view (`provision … [--dry-run]`): `+ create`, `~ update`, `- remove`, `= no-op`, `! skip` per object
 *     (`✗ cannot` for a blocked skip);
 *   - status view (`provision status`): `✓` in the desired state, `✗` missing or drifted (or `blocked`: opted into
 *     but impossible here, e.g. a permission the provisioner lacks), `⚠` cannot be done here.
 *
 * Operations are structural (`RenderableOp`), so this module depends on nothing else in the CLI; the provisioning
 * model (`provision/model.ts`) reuses `PlanAction` as its `Action`. Lines never contain secret values — callers
 * put only names and non-secret detail into `title`, `changes` and `detail`.
 */

/** Prints one line. */
export type Out = (line: string) => void;

/**
 * What provisioning will do with one object. `skip` = cannot be done here (licensing/permissions/config);
 * `delete` = remove something AdminForge manages that is no longer wanted (a credential, a test-user role).
 */
export type PlanAction = 'create' | 'update' | 'delete' | 'noop' | 'skip';

/** The part of a planned operation the views print. */
export interface RenderableOp {
  action: PlanAction;
  /** Heading the operation is grouped under (Applications, Groups, Azure RBAC, …). */
  section: string;
  title: string;
  /** What differs (update) or why (skip/create); never contains secret values. */
  changes?: string[];
  /** Extra non-secret detail for the status view (e.g. a grant's scope string). */
  detail?: string;
  /** A skip the operator asked for that can't be done here (a missing permission, a refused object): ✗ in status. */
  blocked?: boolean;
}

const PLAN_MARK: Record<PlanAction, string> = {
  create: '+ create',
  update: '~ update',
  delete: '- remove',
  noop: '= no-op ',
  skip: '! skip  ',
};
const STATUS_MARK: Record<PlanAction, string> = {
  noop: '✓',
  create: '✗',
  update: '✗',
  delete: '✗',
  skip: '⚠',
};

/** Operations that change something (what `provision status` counts as not in the desired state). */
export const isChange = (op: Pick<RenderableOp, 'action'>) =>
  op.action === 'create' || op.action === 'update' || op.action === 'delete';

function bySection<T extends RenderableOp>(ops: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const op of ops) map.set(op.section, [...(map.get(op.section) ?? []), op]);
  return map;
}

/** How many operations of each action, plus `changes` (create + update + delete). */
export function counts(ops: RenderableOp[]) {
  const n = (a: PlanAction) => ops.filter((o) => o.action === a).length;
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

/** "2 to create, 1 to update, 14 unchanged, 0 skipped" (removals only when there are any). */
export const summaryLine = (ops: RenderableOp[]) => {
  const c = counts(ops);
  return `${c.create} to create, ${c.update} to update, ${c.delete ? `${c.delete} to remove, ` : ''}${c.noop} unchanged, ${c.skip} skipped`;
};

/** Plan view: one line per object with create/update/no-op/skip and what differs. */
export function renderPlan(ops: RenderableOp[], out: Out): void {
  for (const [section, list] of bySection(ops)) {
    out(`  ${section}`);
    for (const op of list) {
      const why = op.changes?.length ? `  (${op.changes.join(', ')})` : '';
      out(`    ${op.blocked ? '✗ cannot' : PLAN_MARK[op.action]}  ${op.title}${why}`);
    }
  }
  out(`  Plan: ${summaryLine(ops)}`);
}

/** Status view: ✓ in the desired state, ✗ missing or drifted, ⚠ cannot be provisioned here. */
export function renderStatus(ops: RenderableOp[], out: Out): void {
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
      out(`    ${op.blocked ? '✗' : STATUS_MARK[op.action]} ${op.title}${why}`);
      if (op.detail) out(`        ${op.detail}`);
    }
  }
}
