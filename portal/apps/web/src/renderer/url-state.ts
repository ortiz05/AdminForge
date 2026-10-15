import type { TableViewState } from '@adminforge/widgets';

/**
 * Everything the renderer keeps in the URL besides page params:
 *
 *   view=<saved view id>                      the saved view the page was opened from
 *   tab=<tab id>                              entity / settings tab
 *   <table>.sort=-field,other                 sort (leading "-" = descending)
 *   <table>.cols=a,b,c                        visible columns in display order (absent = defaults)
 *   <table>.density=compact|comfortable       row density for that table
 *   <table>.q=text                            search within loaded rows
 *   <table>.f={"col":["A"],"time":"past:7d"}  client-side column filters
 *   inspect=page:<key>&i.<param>=…            the inspector (entity page + its params), see app/Inspector.tsx
 *   playbook=…&inputs=…&items=…               the playbook drawer (playbooks/url.ts)
 *
 * `<table>` is the table block's `id` (or `table<index>`). Names with a dot can never collide with page params,
 * which are plain identifiers.
 */

export const RESERVED = new Set(['view', 'tab', 'inspect', 'itab', 'playbook', 'inputs', 'items', 'preview']);
export { INSPECT_PREFIX, readInspect, sanitizeSearch, withInspect, withoutInspect, type InspectState } from './inspect-url';
import { INSPECT_PREFIX } from './inspect-url';

const TABLE_KEYS = ['sort', 'cols', 'density', 'q', 'f'] as const;

/** Page-param part of the search (no reserved or dotted keys). */
export function pageSearch(search: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(search)) if (!RESERVED.has(k) && !k.includes('.')) out[k] = v;
  return out;
}

/** Table-state part of the search. */
export function tableSearch(search: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(search)) if (k.includes('.') && !k.startsWith(INSPECT_PREFIX)) out[k] = v;
  return out;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function readTableView(search: Record<string, unknown>, ns: string, columnIds?: readonly string[]): TableViewState | undefined {
  const sort = str(search[`${ns}.sort`]);
  const cols = str(search[`${ns}.cols`]);
  const density = search[`${ns}.density`];
  const q = str(search[`${ns}.q`]);
  const f = search[`${ns}.f`];
  if (!sort && !cols && !density && !q && !f) return undefined;
  const view: TableViewState = {};
  if (sort)
    view.sorting = sort
      .split(',')
      .filter(Boolean)
      .map((s) => (s.startsWith('-') ? { id: s.slice(1), desc: true } : { id: s, desc: false }));
  if (cols) {
    const order = cols.split(',').filter(Boolean);
    view.columnOrder = order;
    if (columnIds) view.columnVisibility = Object.fromEntries(columnIds.map((id) => [id, order.includes(id)]));
  }
  if (density === 'compact' || density === 'comfortable') view.density = density;
  if (q) view.globalFilter = q;
  if (f && typeof f === 'object' && !Array.isArray(f))
    view.columnFilters = Object.entries(f as Record<string, unknown>).map(([id, value]) => ({ id, value }));
  return view;
}

/**
 * Search patch for a table's state (undefined removes a key). `cols` is written only when visibility or order
 * differ from the defaults.
 */
export function tableViewToSearch(
  ns: string,
  view: TableViewState,
  defaults: { visible: readonly string[]; all: readonly string[] },
): Record<string, unknown> {
  const sort = (view.sorting ?? []).map((s) => `${s.desc ? '-' : ''}${s.id}`).join(',');
  const visibility = view.columnVisibility ?? {};
  const isVisible = (id: string) => visibility[id] ?? defaults.visible.includes(id);
  const order = view.columnOrder?.length ? [...view.columnOrder, ...defaults.all.filter((id) => !view.columnOrder!.includes(id))] : [...defaults.all];
  const cols = order.filter((id) => defaults.all.includes(id) && isVisible(id));
  const defaultCols = defaults.all.filter((id) => defaults.visible.includes(id));
  const filters = Object.fromEntries((view.columnFilters ?? []).map((f) => [f.id, f.value]));
  return {
    [`${ns}.sort`]: sort || undefined,
    [`${ns}.cols`]: cols.join(',') === defaultCols.join(',') ? undefined : cols.join(','),
    [`${ns}.density`]: view.density,
    [`${ns}.q`]: view.globalFilter || undefined,
    [`${ns}.f`]: Object.keys(filters).length ? filters : undefined,
  };
}

/** Keys of every table namespace in a search object. */
export function tableNamespaces(search: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const k of Object.keys(search)) {
    const i = k.lastIndexOf('.');
    if (i > 0 && (TABLE_KEYS as readonly string[]).includes(k.slice(i + 1)) && !k.startsWith(INSPECT_PREFIX)) out.add(k.slice(0, i));
  }
  return [...out];
}

