import { useEffect, useMemo, useState } from 'react';
import { renderTemplate, type Scope } from '@adminforge/expressions';
import { getPath } from './path';

/**
 * Display expressions (`status: ${ … }`, `href: ${ … }`, `when`, row action inputs) are evaluated in the browser
 * against data the page already has. JSONata is async, so components use these helpers; plain values and
 * `${ row.id }`-style paths resolve synchronously without the evaluator.
 */

/** True when any string inside contains `${`. */
export function hasExpression(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('${');
  if (Array.isArray(value)) return value.some(hasExpression);
  if (value && typeof value === 'object') return Object.values(value).some(hasExpression);
  return false;
}

const SIMPLE = /^\s*\$\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\}\s*$/;

/** `${ row.id }` → ['row', 'id']; anything more complex → null. */
export function simplePath(template: string): string | null {
  const m = SIMPLE.exec(template);
  return m ? m[1]! : null;
}

const UNRESOLVED = Symbol('unresolved');

/** Resolves without JSONata when possible (literals, simple paths); otherwise returns UNRESOLVED. */
function resolveSync(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') {
    if (!value.includes('${')) return value.replace(/\$\$\{/g, '${');
    const p = simplePath(value);
    return p ? getPath(scope, p) : UNRESOLVED;
  }
  if (Array.isArray(value)) {
    const out = value.map((v) => resolveSync(v, scope));
    return out.includes(UNRESOLVED) ? UNRESOLVED : out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolveSync(v, scope);
      if (r === UNRESOLVED) return UNRESOLVED;
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return value;
}

/** Evaluates a template (deeply), using the fast path when it can. */
export async function evaluateTemplate<T = unknown>(template: unknown, scope: Scope): Promise<T> {
  const fast = resolveSync(template, scope);
  if (fast !== UNRESOLVED) return fast as T;
  return renderTemplate<T>(template, scope);
}

/** Synchronous result when no evaluator is needed; `undefined` + pending otherwise. */
export function tryResolveSync(template: unknown, scope: Scope): { value: unknown; resolved: boolean } {
  const fast = resolveSync(template, scope);
  return fast === UNRESOLVED ? { value: undefined, resolved: false } : { value: fast, resolved: true };
}

export interface Evaluated<T> {
  value: T | undefined;
  pending: boolean;
  error?: Error;
}

/** Evaluates `template` against `scope` whenever either changes. Literals and simple paths are synchronous. */
export function useTemplate<T = unknown>(template: unknown, scope: Scope, enabled = true): Evaluated<T> {
  const sync = useMemo(
    () => (enabled ? tryResolveSync(template, scope) : { value: undefined, resolved: true }),
    [template, scope, enabled],
  );
  // The result is tagged with the inputs it was computed for, so a stale result never shows for new inputs.
  const key = useMemo(() => ({ template, scope }), [template, scope]);
  const [state, setState] = useState<{ for: unknown; value?: T; error?: Error }>({ for: null });
  useEffect(() => {
    if (sync.resolved) return;
    let live = true;
    renderTemplate<T>(key.template, key.scope).then(
      (value) => live && setState({ for: key, value }),
      (error: Error) => live && setState({ for: key, error }),
    );
    return () => {
      live = false;
    };
  }, [key, sync.resolved]);
  if (sync.resolved) return { value: sync.value as T | undefined, pending: false };
  const done = state.for === key;
  return { value: done ? state.value : undefined, pending: !done, error: done ? state.error : undefined };
}

/**
 * Per-row scope for list/statusGrid/timeline templates: the row's fields at the root (`${ initiatedBy.user.upn }`, as
 * docs/widgets.md writes them) plus `row` / `value`; page names (`params`, `user`, datasources) win over row fields.
 */
const rowScope = (base: Scope, row: unknown): Scope => ({
  ...(row && typeof row === 'object' && !Array.isArray(row) ? (row as Record<string, unknown>) : {}),
  ...base,
  row,
  value: row,
});

/** Evaluates one template per row (lists, timelines). Returns undefined until every row is done. */
export function useRowTemplates(
  rows: readonly unknown[],
  template: unknown,
  base: Scope,
  enabled = true,
): unknown[] | undefined {
  const sync = useMemo(() => {
    if (!enabled || template === undefined) return rows.map(() => undefined);
    const out = rows.map((row) => resolveSync(template, rowScope(base, row)));
    return out.includes(UNRESOLVED) ? null : out;
  }, [rows, template, base, enabled]);
  const [state, setState] = useState<{ rows: readonly unknown[]; values: unknown[] } | null>(null);
  useEffect(() => {
    if (sync) return;
    let live = true;
    void Promise.all(
      rows.map((row) => renderTemplate(template, rowScope(base, row)).catch(() => undefined)),
    ).then((values) => live && setState({ rows, values }));
    return () => {
      live = false;
    };
  }, [rows, template, base, sync]);
  if (sync) return sync;
  return state && state.rows === rows ? state.values : undefined;
}

/**
 * `when` semantics: absent → shown; only `true` (or a truthy evaluated value) shows. `undefined` until the first
 * answer — and, by default, again while a new scope re-evaluates, so an action is never offered on the strength of an
 * older answer (a bulk action gated on the current selection, say).
 *
 * `{ sticky: true }` (page blocks only): while a new scope re-evaluates (opening the inspector, a refetch), the last
 * decision for the same condition stands — a block that stays visible must not unmount and mount again, which would
 * drop focus, scroll position and table state (and focus return when the inspector closes).
 */
export function useWhen(when: unknown, scope: Scope, opts: { sticky?: boolean } = {}): boolean | undefined {
  const r = useTemplate<unknown>(when, scope, when !== undefined);
  const settled = when === undefined ? true : r.error ? false : r.pending ? undefined : Boolean(r.value);
  const [last, setLast] = useState<{ when: unknown; shown: boolean } | undefined>(undefined);
  // Remember the latest settled decision (React's "adjust state while rendering": runs only when it changes).
  if (settled !== undefined && (!last || last.when !== when || last.shown !== settled))
    setLast({ when, shown: settled });
  if (settled !== undefined) return settled;
  return opts.sticky && last && last.when === when ? last.shown : undefined;
}
