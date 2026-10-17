import { compile } from '@adminforge/expressions';

/**
 * Which params an expression uses, for datasource cache keys (executor.ts): `params.<name>` paths give their names;
 * anything that can reach params another way gives `'*'` (all of them) — `params` on its own or indexed
 * (`params[…]`, `$lookup(params, …)`), the root context (`$`, `$$`) where it is the scope, and wildcards or
 * descendants there (`*.q`, `**.q`, `$each($, …)`, `$sift($, …)`). A key that counts too many params only shares
 * less; one that counts too few would serve one filter's results for another, so every doubt means all.
 */

type Node = Record<string, unknown> & { type?: string; value?: unknown };

/** Node kinds whose children are evaluated against another context (an item), not the root scope. */
const ITEM_CONTEXT_KEYS = new Set(['stages', 'predicate', 'terms', 'group']);

export function paramsUsed(source: string): string[] | '*' {
  let ast: Node;
  try {
    ast = compile(source).ast() as unknown as Node;
  } catch {
    return '*';
  }
  const names = new Set<string>();
  let all = false;
  const visit = (node: unknown, atRoot: boolean): void => {
    if (all || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x, atRoot);
      return;
    }
    const n = node as Node;
    // `$$` is always the root scope; `$`, `*` and `**` are when evaluated against it.
    if (n.type === 'variable' && n.value === '$') return void (all = true);
    if (atRoot && (n.type === 'wildcard' || n.type === 'descendant')) return void (all = true);
    if (atRoot && n.type === 'variable' && n.value === '') return void (all = true);
    if (n.type === 'name' && n.value === 'params') return void (all = true);
    if (n.type === 'path' && Array.isArray(n.steps)) {
      const steps = n.steps as Node[];
      let from = 0;
      if (steps[0]?.type === 'name' && steps[0].value === 'params') {
        const next = steps[1];
        if (next?.type !== 'name' || typeof next.value !== 'string' || next.stages || next.predicate)
          return void (all = true);
        names.add(next.value);
        from = 2;
      }
      steps.forEach((s, i) => {
        if (i < from) return;
        // The first step sees the path's own context; later steps see the items before them.
        visit(s, atRoot && i === 0);
      });
      for (const [k, x] of Object.entries(n))
        if (k !== 'steps' && x && typeof x === 'object') visit(x, false);
      return;
    }
    for (const [k, x] of Object.entries(n))
      if (x && typeof x === 'object') visit(x, atRoot && !ITEM_CONTEXT_KEYS.has(k));
  };
  visit(ast, true);
  return all ? '*' : [...names].sort();
}
