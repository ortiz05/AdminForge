import { useMemo, useState, type ReactNode } from 'react';
import type { BulkAction, RowAction } from '@adminforge/schemas';
import {
  ArrowSquareOutIcon,
  Button,
  DataTable,
  DotsThreeVerticalIcon,
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Panel,
  ProvenanceFooter,
  TABLE_MUTED_TEXT,
  formatNumber,
  formatTimestamp,
  type ColumnFilterKind,
  type ColumnKind,
  type DataColumn,
  type DataTableView,
  type TableDensity,
} from '@adminforge/ui';
import { isExternal, launchPlaybook, playbookLabel } from '../../lib/actions';
import { evaluateTemplate, tryResolveSync, useWhen } from '../../lib/expr';
import { formatBytes, formatDate, formatPercentValue } from '../../lib/format';
import { asRows, getPath } from '../../lib/path';
import { mapStatus, type StatusMap } from '../../lib/status';
import type { WidgetProps, WidgetRuntime } from '../../types';
import type { TableColumnConfig, TableConfig } from './schema';

type Row = Record<string, unknown>;

/** Tags from an array (`['a', 'b']`) or an object (Azure tags `{ env: 'prod' }` → `env: prod`). */
export function tagList(v: unknown): string[] {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => (x != null && typeof x === 'object' ? JSON.stringify(x) : String(x))).filter(Boolean);
  if (typeof v === 'object') return Object.entries(v).map(([k, val]) => (val == null || val === '' ? k : `${k}: ${String(val)}`));
  return [String(v)];
}

/** Display text of a raw value. */
const str = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** "2026-10-15 14:03" (UTC) for datetime cells; the title carries the full timestamp. */
const shortTimestamp = (v: unknown) => {
  const full = formatTimestamp(v as string);
  return full === '—' ? full : full.slice(0, 16);
};

function TimeCell({ value, kind }: { value: unknown; kind: 'date' | 'datetime' }) {
  if (value == null || value === '') return <span className={TABLE_MUTED_TEXT}>—</span>;
  return (
    <time dateTime={str(value)} title={formatTimestamp(value as string)} className="truncate text-fg-2 tabular-nums">
      {kind === 'date' ? formatDate(value) : shortTimestamp(value)}
    </time>
  );
}

function NumberCell({ text }: { text: string }) {
  return <span className="w-full truncate text-right font-mono tabular-nums">{text}</span>;
}

/** Column filter from content: `text|facet|range|date`, or `{ type, param }` (server-side, so not on the table). */
function filterOf(col: TableColumnConfig): ColumnFilterKind | undefined {
  if (!col.filter) return undefined;
  if (typeof col.filter === 'string') return col.filter;
  return col.filter.param ? 'none' : col.filter.type;
}

function LinkCell({ col, row, runtime }: { col: TableColumnConfig; row: Row; runtime: WidgetRuntime }) {
  const value = getPath(row, col.field);
  const text = str(value);
  if (!text) return <span className={TABLE_MUTED_TEXT}>—</span>;
  const cls = 'truncate font-medium text-accent underline-offset-2 hover:underline';
  if (col.link) {
    const params = tryResolveSync(col.link.params ?? {}, { ...runtime.scope, row });
    if (params.resolved) {
      const L = runtime.Link;
      return (
        <L href={runtime.hrefFor(col.link.page, params.value as Record<string, unknown>)} className={cls}>
          {text}
        </L>
      );
    }
    return (
      <button
        type="button"
        className={`${cls} text-left`}
        onClick={() =>
          void evaluateTemplate<Record<string, unknown>>(col.link!.params ?? {}, { ...runtime.scope, row }).then((p) =>
            runtime.navigate(runtime.hrefFor(col.link!.page, p)),
          )
        }
      >
        {text}
      </button>
    );
  }
  if (isExternal(text))
    return (
      <a href={text} target="_blank" rel="noreferrer" className={cls}>
        {text}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  return <span className="truncate">{text}</span>;
}

/** Content column → DataTable column. Extra kinds render through custom cells but sort/filter on raw values. */
export function toDataColumn(col: TableColumnConfig, id: string, runtime: WidgetRuntime): DataColumn<Row> {
  const get = (row: Row) => getPath(row, col.field);
  // Number headers carry a sort glyph and a filter button; give them room for a two-word label.
  const numeric = col.kind === 'number' || col.kind === 'percent' || col.kind === 'bytes';
  const width = col.width ? `${col.width}px` : numeric ? 'minmax(116px, 0.6fr)' : undefined;
  const base = {
    id,
    header: col.label,
    sortable: col.sortable,
    hidden: col.hidden,
    width,
    align: col.align === 'end' ? ('end' as const) : undefined,
  };
  const filter = filterOf(col);
  const withFilter = (kind: ColumnKind, extra: Pick<DataColumn<Row>, 'value'> & Partial<DataColumn<Row>>): DataColumn<Row> => ({
    ...base,
    kind,
    ...(filter ? { filter } : {}),
    ...extra,
  });
  switch (col.kind) {
    case 'identity':
      return withFilter('identity', {
        value: (row) => {
          const primary = get(row);
          if (primary == null || primary === '') return null;
          const secondary = col.secondary ? getPath(row, col.secondary) : undefined;
          return { primary: str(primary), ...(secondary != null && secondary !== '' ? { secondary: str(secondary) } : {}) };
        },
      });
    case 'status':
      return withFilter('status', { value: (row) => mapStatus(get(row), col.map as StatusMap | undefined) });
    case 'relativeTime':
      return withFilter('relativeTime', { value: (row) => (get(row) as string | null | undefined) ?? null });
    case 'date':
    case 'datetime': {
      const k = col.kind;
      return withFilter('relativeTime', {
        value: (row) => (get(row) as string | null | undefined) ?? null,
        cell: (row) => <TimeCell value={get(row)} kind={k} />,
        width: width ?? (k === 'date' ? 'minmax(112px, 0.7fr)' : 'minmax(150px, 0.8fr)'),
      });
    }
    case 'number':
      return withFilter('number', { value: (row) => (typeof get(row) === 'number' ? get(row) : null) });
    case 'percent':
      return withFilter('number', {
        value: (row) => (typeof get(row) === 'number' ? get(row) : null),
        cell: (row) => {
          const v = get(row);
          return typeof v === 'number' ? <NumberCell text={formatPercentValue(v)} /> : <span className={TABLE_MUTED_TEXT}>—</span>;
        },
      });
    case 'bytes':
      return withFilter('number', {
        value: (row) => (typeof get(row) === 'number' ? get(row) : null),
        cell: (row) => {
          const v = get(row);
          return typeof v === 'number' ? <NumberCell text={formatBytes(v)} /> : <span className={TABLE_MUTED_TEXT}>—</span>;
        },
      });
    case 'boolean':
      return withFilter('text', {
        filter: filter ?? 'facet',
        value: (row) => {
          const v = get(row);
          return v === true ? 'Yes' : v === false ? 'No' : null;
        },
        cell: (row) => {
          const v = get(row);
          if (v == null) return <span className={TABLE_MUTED_TEXT}>—</span>;
          return <span className={v ? 'text-fg' : TABLE_MUTED_TEXT}>{v ? 'Yes' : 'No'}</span>;
        },
        width: width ?? 'minmax(96px, 0.5fr)',
      });
    case 'guid':
      return withFilter('id', { value: (row) => (get(row) == null ? null : str(get(row))) });
    case 'tags':
      return withFilter('tags', {
        value: (row) => {
          const list = tagList(get(row));
          return list.length ? list : null;
        },
      });
    case 'link':
      return withFilter('text', {
        value: (row) => (get(row) == null ? null : str(get(row))),
        cell: (row) => <LinkCell col={col} row={row} runtime={runtime} />,
      });
    case 'code':
      return withFilter('text', {
        value: (row) => (get(row) == null ? null : str(get(row))),
        cell: (row) => {
          const v = get(row);
          return v == null || v === '' ? (
            <span className={TABLE_MUTED_TEXT}>—</span>
          ) : (
            <code className="truncate font-mono text-xs text-fg-2">{str(v)}</code>
          );
        },
      });
    default:
      return withFilter('text', { value: (row) => (get(row) == null || get(row) === '' ? null : str(get(row))) });
  }
}

/** One menu per row: the row's actions whose `when` holds, evaluated when the menu opens. */
function RowActionsMenu({ row, actions, runtime, label }: { row: Row; actions: RowAction[]; runtime: WidgetRuntime; label: string }) {
  const [visible, setVisible] = useState<RowAction[] | null>(null);
  const scope = { ...runtime.scope, row };
  const onOpenChange = (open: boolean) => {
    if (!open) return;
    setVisible(null);
    void Promise.all(
      actions.map((a) =>
        a.when === undefined
          ? true
          : typeof a.when === 'boolean'
            ? a.when
            : evaluateTemplate(a.when, scope).then(Boolean, () => false),
      ),
    ).then((flags) => setVisible(actions.filter((_, i) => flags[i])));
  };
  const run = (a: RowAction) => {
    if (a.playbook) return void launchPlaybook(runtime, a.playbook, a.inputs, scope);
    if (a.href)
      void evaluateTemplate<unknown>(a.href, scope).then((href) => {
        if (typeof href !== 'string' || !href) return;
        if (isExternal(href)) window.open(href, '_blank', 'noopener,noreferrer');
        else runtime.navigate(href);
      });
  };
  return (
    <Menu onOpenChange={onOpenChange}>
      <MenuTrigger asChild>
        <Button size="icon-sm" intent="ghost" aria-label={`Actions for ${label}`}>
          <DotsThreeVerticalIcon size={16} weight="bold" aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent className="min-w-56">
        {visible === null ? (
          <MenuItem disabled>Checking what applies…</MenuItem>
        ) : visible.length === 0 ? (
          <MenuItem disabled>No actions apply to this row</MenuItem>
        ) : (
          visible.map((a, i) => {
            const external = Boolean(a.href && /^https?:/i.test(a.href));
            return (
              <MenuItem
                key={`${a.playbook ?? a.href}-${i}`}
                icon={a.icon ? <Icon name={a.icon} size={15} /> : undefined}
                onSelect={() => run(a)}
                shortcut={external ? <ArrowSquareOutIcon size={12} aria-label="Opens in a new tab" /> : undefined}
              >
                {a.label ?? (a.playbook ? playbookLabel(a.playbook) : 'Open link')}
              </MenuItem>
            );
          })
        )}
      </MenuContent>
    </Menu>
  );
}

/** A bulk action for the selection: hidden while its `when` (scope `rows`) is false; capped at `maxItems`. */
/** Display-only key on bulk items: the playbook drawer lists items by it and strips it before running. */
export const ITEM_LABEL_KEY = '$label';

function BulkActionButton({ action, rows, runtime, labelOf }: { action: BulkAction; rows: Row[]; runtime: WidgetRuntime; labelOf: (row: Row) => string }) {
  const scope = useMemo(() => ({ ...runtime.scope, rows }), [runtime.scope, rows]);
  const visible = useWhen(action.when, scope);
  const [busy, setBusy] = useState(false);
  if (!visible) return null;
  const max = action.maxItems ?? 100;
  const tooMany = rows.length > max;
  const launch = async () => {
    setBusy(true);
    try {
      const items = await Promise.all(
        rows.map(async (row) => {
          const inputs = await evaluateTemplate<Record<string, unknown>>(action.forEach.inputs, { ...runtime.scope, row, item: row });
          const label = labelOf(row);
          return label ? { ...inputs, [ITEM_LABEL_KEY]: label } : inputs;
        }),
      );
      runtime.openPlaybook({ playbook: action.playbook, items });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="sm"
      intent="secondary"
      pending={busy}
      locked={tooMany ? `Select at most ${formatNumber(max)} rows for ${action.label.toLowerCase()}.` : undefined}
      onClick={() => void launch()}
    >
      {action.icon && <Icon name={action.icon} size={14} />}
      {action.label}
    </Button>
  );
}

function BulkActions({
  actions,
  rows,
  selectionKey: key,
  runtime,
  labelOf,
}: {
  actions: BulkAction[];
  rows: Row[];
  selectionKey: string;
  runtime: WidgetRuntime;
  labelOf: (row: Row) => string;
}) {
  // DataTable hands a new array every render; keep one per selection so `when` isn't re-evaluated endlessly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => rows, [key]);
  return (
    <>
      {actions.map((a, i) => (
        <BulkActionButton key={`${a.playbook}-${i}`} action={a} rows={stable} runtime={runtime} labelOf={labelOf} />
      ))}
    </>
  );
}

const sameParams = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (str(a[k]) !== str(b[k])) return false;
  return true;
};

/**
 * The admin list (R9): typed columns, client filters (text, facet, date, range), server-bound column filters (via the
 * page filter bar), sort/visibility/order/density kept in the URL, multi-select with bulk playbooks, per-row actions,
 * the inspector on Enter/click, and incremental loading for `paging: cursor` datasources.
 */
export function TableWidget({ config, data, runtime, instanceId, variant }: WidgetProps<TableConfig>) {
  const rowKey = config.rowKey;
  const getRowId = (row: Row) => {
    const v = rowKey ? getPath(row, rowKey) : row.id;
    return v == null ? JSON.stringify(row) : str(v);
  };
  // Pages of a cursor can overlap (items added while paging); keep the first copy of each row.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return asRows(data.value).filter((r) => {
      const v = rowKey ? getPath(r, rowKey) : r.id;
      const id = v == null ? JSON.stringify(r) : str(v);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [data.value, rowKey]);

  const columns = useMemo(() => {
    const seen = new Map<string, number>();
    const cols = config.columns.map((c) => {
      const n = seen.get(c.field) ?? 0;
      seen.set(c.field, n + 1);
      return toDataColumn(c, n ? `${c.field}~${n}` : c.field, runtime);
    });
    if (config.rowActions?.length) {
      const first = config.columns.find((c) => !c.hidden) ?? config.columns[0]!;
      cols.push({
        id: '__actions',
        header: 'Actions',
        headerHidden: true,
        pin: 'end',
        sortable: false,
        filter: 'none',
        hideable: false,
        width: '52px',
        value: () => null,
        cell: (row) => (
          <RowActionsMenu
            row={row}
            actions={config.rowActions!}
            runtime={runtime}
            label={str(getPath(row, first.field)) || 'this row'}
          />
        ),
      });
    }
    return cols;
  }, [config.columns, config.rowActions, runtime]);

  const firstText = config.columns.find((c) => !c.hidden && (c.kind === 'identity' || !c.kind || c.kind === 'text'));
  const rowLabel = (row: Row) => str(getPath(row, firstText?.field ?? config.columns[0]!.field));

  // Inspector: Enter/click opens the entity page; the inspected row keeps a temper-blue edge.
  const inspect = config.inspect;
  const onRowActivate =
    inspect && runtime.inspect
      ? (row: Row) =>
          void evaluateTemplate<Record<string, unknown>>(inspect.params ?? {}, { ...runtime.scope, row }).then((params) =>
            runtime.inspect!({ page: inspect.page, params }),
          )
      : undefined;
  const activeRowId = useMemo(() => {
    const target = runtime.inspecting;
    if (!inspect || !target || target.page !== inspect.page) return undefined;
    for (const row of rows) {
      const p = tryResolveSync(inspect.params ?? {}, { ...runtime.scope, row });
      if (p.resolved && sameParams(p.value as Record<string, unknown>, target.params)) return getRowId(row);
    }
    return undefined;
    // getRowId only depends on rowKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.inspecting, runtime.scope, inspect, rows, rowKey]);

  // URL-backed view (sort, filters, search, columns, order, density) when the page provides it.
  const stored = runtime.tableView(instanceId);
  const defaultSort = config.sort ? [{ id: config.sort.field, desc: Boolean(config.sort.desc) }] : [];
  const controlled = Boolean(runtime.setTableView);
  const view: DataTableView | undefined = controlled ? { ...stored, sorting: stored?.sorting ?? defaultSort } : undefined;
  const density = stored?.density;
  const onViewChange = controlled
    ? (next: DataTableView) => runtime.setTableView!(instanceId, { ...next, ...(density ? { density } : {}) })
    : undefined;
  const onDensityChange = controlled
    ? (d: TableDensity) => runtime.setTableView!(instanceId, { ...stored, density: d })
    : undefined;

  const empty = config.empty
    ? { title: config.empty.title, description: config.empty.body }
    : { title: config.emptyText ?? 'Nothing to show', description: 'Try different filters or a broader search.' };

  const label = config.title ?? 'Results';
  const loading = data.status === 'loading' || data.status === 'idle';
  const error =
    data.status === 'error'
      ? {
          title: `${label} didn’t load`,
          message: data.error?.message ?? 'The data source returned an error.',
          hint: data.error?.hint,
          code: data.error?.code,
          correlationId: data.error?.correlationId,
          onRetry: data.retry,
        }
      : null;

  const footer: ReactNode =
    data.provenance || data.hasMore ? (
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">{data.provenance && <ProvenanceFooter {...data.provenance} />}</div>
        {data.hasMore && data.status === 'ready' && (
          <Button size="sm" intent="ghost" pending={data.loadingMore} onClick={data.loadMore}>
            Load more
          </Button>
        )}
      </div>
    ) : undefined;

  return (
    <Panel title={config.title} description={config.description} flush footer={footer} aria-label={config.title ? undefined : label}>
      <DataTable
        label={label}
        data={rows}
        columns={columns}
        getRowId={getRowId}
        loading={loading}
        error={error}
        empty={empty}
        selectable={config.selection === 'multi' || (config.selection !== 'none' && Boolean(config.bulkActions?.length))}
        bulkActions={
          config.bulkActions?.length
            ? (selected) => (
                <BulkActions
                  actions={config.bulkActions!}
                  rows={selected}
                  selectionKey={selected.map(getRowId).join('|')}
                  runtime={runtime}
                  labelOf={rowLabel}
                />
              )
            : undefined
        }
        searchable={config.search ?? !runtime.hasServerSearch}
        searchPlaceholder={`Filter loaded ${label.toLowerCase()}…`}
        onRowActivate={onRowActivate}
        activeRowId={activeRowId}
        rowLabel={rowLabel}
        maxHeight={config.maxHeight ?? (variant === 'inspector' ? 360 : 560)}
        view={view}
        onViewChange={onViewChange}
        density={density}
        onDensityChange={onDensityChange}
        onEndReached={data.hasMore && !data.loadingMore ? data.loadMore : undefined}
        loadingMore={data.loadingMore}
        rowCountLabel={(shown, loaded) =>
          data.hasMore
            ? shown === loaded
              ? `${formatNumber(loaded)} loaded · more available`
              : `${formatNumber(shown)} of ${formatNumber(loaded)} loaded`
            : shown === loaded
              ? `${formatNumber(loaded)} ${loaded === 1 ? 'row' : 'rows'}`
              : `${formatNumber(shown)} of ${formatNumber(loaded)} rows`
        }
      />
    </Panel>
  );
}

