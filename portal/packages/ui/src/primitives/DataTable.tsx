import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  CaretDownIcon,
  CaretUpDownIcon,
  CaretUpIcon,
  ColumnsIcon,
  FunnelSimpleIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createFilteredRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type Row,
  type RowData,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { formatNumber, formatRelative, formatTimestamp, toDate } from '../lib/format';
import { useCssVarPx, useNow } from '../lib/hooks';
import { STATUS_SEVERITY, type StatusTone } from '../lib/status';
import { cn } from '../recipes/tv';
import { Badge } from './Badge';
import { Button } from './Button';
import { TextField } from './Field';
import { FilterBar, type Facet, type FilterChip } from './FilterBar';
import { IdChip } from './IdChip';
import { Menu, MenuCheckboxItem, MenuContent, MenuLabel, MenuSeparator, MenuTrigger } from './Menu';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';
import { Skeleton } from './Skeleton';
import { EmptyState, ErrorState } from './States';
import { StatusPill } from './StatusPill';
import { Checkbox } from './Toggles';
import { dataTable } from '../recipes/data-table';

export type ColumnKind = 'text' | 'identity' | 'status' | 'relativeTime' | 'number' | 'id' | 'tags';
export interface IdentityValue {
  primary: string;
  secondary?: string;
}
export interface StatusValue {
  tone: StatusTone;
  label: string;
}

export interface DataColumn<T> {
  id: string;
  header: string;
  /**
   * How the value is rendered, sorted and filtered. `value` must return:
   * identity → IdentityValue · status → StatusValue · relativeTime → ISO string | null ·
   * number → number | null · tags → string[] · text / id → string.
   */
  kind?: ColumnKind;
  value: (row: T) => unknown;
  /** Custom cell; sorting and filtering still use `value`. */
  cell?: (row: T) => ReactNode;
  /** CSS grid track, e.g. "minmax(220px, 2fr)" or "120px". Defaults by kind. */
  width?: string;
  align?: 'start' | 'end';
  sortable?: boolean;
  /** "text" = contains; "facet" = pick values (also offered in the filter bar); "none". Defaults by kind. */
  filter?: 'text' | 'facet' | 'none';
  hideable?: boolean;
  /** Hidden until the user shows it from the Columns menu. */
  hidden?: boolean;
}

export interface DataTableError {
  title?: string;
  message: string;
  hint?: string;
  code?: string;
  correlationId?: string;
  onRetry?: () => void;
}

export interface DataTableProps<T extends RowData> {
  data: T[];
  columns: DataColumn<T>[];
  getRowId: (row: T) => string;
  /** Accessible name of the grid. */
  label: string;
  loading?: boolean;
  error?: DataTableError | null;
  empty?: { title: string; description?: ReactNode; action?: ReactNode };
  /** Row checkboxes + bulk-action bar. */
  selectable?: boolean;
  bulkActions?: (rows: T[], clear: () => void) => ReactNode;
  /** Global search box (default on). */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Hide the toolbar entirely (small embedded tables). */
  toolbar?: boolean;
  /** Extra controls on the right of the toolbar (export, refresh). */
  actions?: ReactNode;
  /** Enter / click on a row (open the inspector). */
  onRowActivate?: (row: T) => void;
  /** Highlights the row being inspected. */
  activeRowId?: string;
  /** Spoken name of a row for its checkbox ("Select Adele Vance"). Defaults to the first column. */
  rowLabel?: (row: T) => string;
  initialSort?: SortingState;
  maxHeight?: number;
  className?: string;
}

const DEFAULT_WIDTH: Record<ColumnKind, string> = {
  identity: 'minmax(220px, 2.2fr)',
  text: 'minmax(140px, 1fr)',
  status: 'minmax(130px, 0.9fr)',
  relativeTime: 'minmax(110px, 0.7fr)',
  number: 'minmax(96px, 0.6fr)',
  id: 'minmax(150px, 0.8fr)',
  tags: 'minmax(170px, 1.2fr)',
};

const DEFAULT_FILTER: Record<ColumnKind, 'text' | 'facet' | 'none'> = {
  identity: 'text',
  text: 'text',
  status: 'facet',
  relativeTime: 'none',
  number: 'none',
  id: 'text',
  tags: 'facet',
};

const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  columnVisibilityFeature,
  rowSelectionFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
});
type F = typeof features;

const asString = (v: unknown) => (v == null ? '' : String(v));

/** Text that search and "contains" filters match against. */
function searchText(kind: ColumnKind, v: unknown): string {
  if (v == null) return '';
  switch (kind) {
    case 'identity': {
      const id = v as IdentityValue;
      return `${id.primary} ${id.secondary ?? ''}`;
    }
    case 'status':
      return (v as StatusValue).label;
    case 'tags':
      return (v as string[]).join(' ');
    case 'relativeTime':
      return '';
    default:
      return asString(v);
  }
}

/** Values a facet filter matches against. */
function facetKeys(kind: ColumnKind, v: unknown): string[] {
  if (v == null) return [];
  if (kind === 'status') return [(v as StatusValue).label];
  if (kind === 'tags') return v as string[];
  if (kind === 'identity') return [(v as IdentityValue).primary];
  return [asString(v)];
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function compare(kind: ColumnKind, a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  switch (kind) {
    case 'number':
      return (a as number) - (b as number);
    case 'relativeTime':
      return toDate(a as string).getTime() - toDate(b as string).getTime();
    case 'status':
      return (
        STATUS_SEVERITY[(a as StatusValue).tone] - STATUS_SEVERITY[(b as StatusValue).tone] ||
        collator.compare((a as StatusValue).label, (b as StatusValue).label)
      );
    default:
      return collator.compare(searchText(kind, a), searchText(kind, b));
  }
}

function Cell<T extends RowData>({ col, row, now }: { col: DataColumn<T>; row: T; now: number }): ReactNode {
  if (col.cell) return col.cell(row);
  const v = col.value(row);
  const kind = col.kind ?? 'text';
  if (v == null || v === '') return <span className="text-fg-3">—</span>;
  switch (kind) {
    case 'identity': {
      const id = v as IdentityValue;
      return (
        <span className="flex min-w-0 flex-col leading-tight compact:flex-row compact:items-baseline compact:gap-2">
          <span className="truncate font-medium text-fg">{id.primary}</span>
          {id.secondary && <span className="truncate text-xs text-fg-3">{id.secondary}</span>}
        </span>
      );
    }
    case 'status': {
      const st = v as StatusValue;
      return (
        <StatusPill status={st.tone} size="sm">
          {st.label}
        </StatusPill>
      );
    }
    case 'relativeTime':
      return (
        <time
          dateTime={asString(v)}
          title={formatTimestamp(v as string)}
          className="truncate text-fg-2 tabular-nums"
        >
          {formatRelative(v as string, now)}
        </time>
      );
    case 'number':
      return (
        <span className="w-full truncate text-right font-mono tabular-nums">{formatNumber(v as number)}</span>
      );
    case 'id':
      return <IdChip value={asString(v)} label={col.header} showLabel={false} />;
    case 'tags': {
      const tags = v as string[];
      return (
        <span className="flex min-w-0 items-center gap-1 overflow-hidden">
          {tags.slice(0, 2).map((t) => (
            <Badge key={t} className="min-w-0 truncate">
              {t}
            </Badge>
          ))}
          {tags.length > 2 && (
            <span className="shrink-0 text-xs text-fg-3" title={tags.slice(2).join(', ')}>
              +{tags.length - 2}
            </span>
          )}
        </span>
      );
    }
    default:
      return <span className="truncate">{asString(v)}</span>;
  }
}

function ColumnFilter({
  label,
  kind,
  value,
  options,
  onChange,
}: {
  label: string;
  kind: 'text' | 'facet';
  value: unknown;
  options: Facet['options'];
  onChange: (v: unknown) => void;
}) {
  const active = Array.isArray(value) ? value.length > 0 : Boolean(value);
  const s = dataTable();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Filter ${label}`}
          className={s.filterButton({ className: active && 'text-accent opacity-100' })}
        >
          <FunnelSimpleIcon size={13} weight={active ? 'fill' : 'regular'} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-2" aria-label={`Filter ${label}`}>
        {kind === 'text' ? (
          <TextField
            label={`${label} contains`}
            placeholder="Contains…"
            autoFocus
            value={asString(value)}
            onChange={(e) => onChange(e.target.value || undefined)}
          />
        ) : (
          <div role="group" aria-label={label} className="flex max-h-64 flex-col gap-1 overflow-y-auto p-0.5">
            {options.map((o) => {
              const selected = Array.isArray(value) ? (value as string[]) : [];
              return (
                <Checkbox
                  key={o.value}
                  label={o.label ?? o.value}
                  checked={selected.includes(o.value)}
                  onCheckedChange={(on) => {
                    const next = on ? [...selected, o.value] : selected.filter((x) => x !== o.value);
                    onChange(next.length ? next : undefined);
                  }}
                />
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The admin list: TanStack Table + Virtual. Sorting, per-column and faceted filters, global search,
 * column visibility, row selection with a bulk-action bar, sticky header, density-aware rows,
 * keyboard row navigation (↑ ↓ Home End PgUp PgDn, Enter to open, Space to select), and
 * loading / error / empty states.
 */
export function DataTable<T extends RowData>({
  data,
  columns,
  getRowId,
  label,
  loading,
  error,
  empty,
  selectable,
  bulkActions,
  searchable = true,
  searchPlaceholder = 'Search…',
  toolbar = true,
  actions,
  onRowActivate,
  activeRowId,
  rowLabel,
  initialSort = [],
  maxHeight = 560,
  className,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSort);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>(() =>
    Object.fromEntries(columns.filter((c) => c.hidden).map((c) => [c.id, false])),
  );
  const now = useNow(30_000);
  const s = dataTable();

  const byId = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const kindOf = useCallback((id: string): ColumnKind => byId.get(id)?.kind ?? 'text', [byId]);

  const columnDefs = useMemo(
    () =>
      columns.map((c) => {
        const kind = c.kind ?? 'text';
        return {
          id: c.id,
          header: c.header,
          // null → undefined so `sortUndefined: 'last'` keeps blanks at the bottom in both directions.
          accessorFn: (row: T) => c.value(row) ?? undefined,
          sortUndefined: 'last' as const,
          enableSorting: c.sortable ?? true,
          enableHiding: c.hideable ?? true,
          enableColumnFilter: (c.filter ?? DEFAULT_FILTER[kind]) !== 'none',
          enableGlobalFilter: kind !== 'relativeTime' && kind !== 'number',
          sortFn: (a: Row<F, T>, b: Row<F, T>, id: string) => compare(kind, a.getValue(id), b.getValue(id)),
          filterFn: (row: Row<F, T>, id: string, filterValue: unknown) => {
            const v = row.getValue(id);
            if (Array.isArray(filterValue))
              return filterValue.length === 0 || facetKeys(kind, v).some((k) => filterValue.includes(k));
            return searchText(kind, v).toLowerCase().includes(asString(filterValue).trim().toLowerCase());
          },
        };
      }),
    [columns],
  );

  const t = useTable({
    features,
    columns: columnDefs,
    data,
    getRowId: (row: T) => getRowId(row),
    state: { sorting, columnFilters, globalFilter, rowSelection, columnVisibility },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    enableRowSelection: Boolean(selectable),
    isRowRangeSelectionEvent: (e: unknown) => Boolean((e as { shiftKey?: boolean }).shiftKey),
    globalFilterFn: (row: Row<F, T>, id: string, filterValue: unknown) =>
      searchText(kindOf(id), row.getValue(id))
        .toLowerCase()
        .includes(asString(filterValue).trim().toLowerCase()),
    getColumnCanGlobalFilter: (column: { id: string }) => {
      const kind = kindOf(column.id);
      return kind !== 'relativeTime' && kind !== 'number';
    },
  });

  const rows = t.getRowModel().rows;
  const visibleColumns = columns.filter((c) => columnVisibility[c.id] !== false);
  const template = [
    selectable ? '44px' : null,
    ...visibleColumns.map((c) => c.width ?? DEFAULT_WIDTH[c.kind ?? 'text']),
  ]
    .filter(Boolean)
    .join(' ');

  // Facet options with counts, from all rows (counts don't shift as you filter).
  const facets: Facet[] = useMemo(
    () =>
      columns
        .filter((c) => (c.filter ?? DEFAULT_FILTER[c.kind ?? 'text']) === 'facet')
        .map((c) => {
          const counts = new Map<string, number>();
          for (const row of data)
            for (const k of facetKeys(c.kind ?? 'text', c.value(row)))
              counts.set(k, (counts.get(k) ?? 0) + 1);
          return {
            id: c.id,
            label: c.header,
            options: [...counts.entries()]
              .sort((a, b) => collator.compare(a[0], b[0]))
              .map(([value, count]) => ({ value, count })),
          };
        }),
    [columns, data],
  );
  const facetValues = Object.fromEntries(
    columnFilters.filter((f) => Array.isArray(f.value)).map((f) => [f.id, f.value as string[]]),
  );
  const textChips: FilterChip[] = columnFilters
    .filter((f) => !Array.isArray(f.value))
    .map((f) => ({
      id: f.id,
      label: byId.get(f.id)?.header ?? f.id,
      value: `contains “${asString(f.value)}”`,
      onRemove: () => setColumnFilters((all) => all.filter((x) => x.id !== f.id)),
    }));
  const setFilter = (id: string, value: unknown) =>
    setColumnFilters((all) => {
      const rest = all.filter((f) => f.id !== id);
      return value == null || (Array.isArray(value) && value.length === 0) ? rest : [...rest, { id, value }];
    });
  const clearFilters = () => {
    setColumnFilters([]);
    setGlobalFilter('');
  };

  // Virtual rows; height follows the density token.
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useCssVarPx('--af-table-row-h', 40);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    getItemKey: (i) => rows[i]?.id ?? i,
    // A container that hasn't been laid out yet (hidden tab, first paint, jsdom) still renders a screenful.
    initialRect: { width: 0, height: maxHeight },
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => cb(rect.height > 0 ? rect : { ...rect, height: maxHeight })),
  });
  useEffect(() => virtualizer.measure(), [rowHeight, virtualizer]);

  // Roving focus across rows.
  const [focusIndex, setFocusIndex] = useState(0);
  const pendingFocus = useRef(false);
  const safeFocus = Math.min(focusIndex, Math.max(0, rows.length - 1));
  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    scrollRef.current?.querySelector<HTMLElement>(`[data-row-index="${safeFocus}"]`)?.focus();
  });

  const moveFocus = (next: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, next));
    setFocusIndex(clamped);
    pendingFocus.current = true;
    virtualizer.scrollToIndex(clamped, { align: 'auto' });
  };

  const pageSize = Math.max(1, Math.floor(maxHeight / rowHeight) - 2);
  const onRowKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number, row: Row<F, T>) => {
    if (e.target !== e.currentTarget) return;
    const keys: Record<string, () => void> = {
      ArrowDown: () => moveFocus(index + 1),
      ArrowUp: () => moveFocus(index - 1),
      Home: () => moveFocus(0),
      End: () => moveFocus(rows.length - 1),
      PageDown: () => moveFocus(index + pageSize),
      PageUp: () => moveFocus(index - pageSize),
      Enter: () => onRowActivate?.(row.original),
      ' ': () => selectable && row.toggleSelected(),
    };
    const action = keys[e.key];
    if (action) {
      e.preventDefault();
      action();
    }
  };

  const onRowClick = (e: MouseEvent<HTMLDivElement>, index: number, row: Row<F, T>) => {
    setFocusIndex(index);
    if ((e.target as HTMLElement).closest('button, a, input, [role="checkbox"]')) return;
    onRowActivate?.(row.original);
  };

  const selectedRows = t.getSelectedRowModel().rows.map((r) => r.original);
  const clearSelection = () => setRowSelection({});
  const allSelected = t.getIsAllRowsSelected();
  const someSelected = t.getIsSomeRowsSelected();
  const labelFor = (row: T) =>
    rowLabel?.(row) ?? searchText(columns[0]?.kind ?? 'text', columns[0]?.value(row)).trim();

  const hideableColumns = columns.filter((c) => c.hideable !== false);
  const filtered = rows.length;
  const total = data.length;
  const showStates = loading || error || total === 0;
  const colCount = visibleColumns.length + (selectable ? 1 : 0);

  return (
    <div className={s.root({ className })} style={{ '--af-dt-cols': template } as CSSProperties}>
      {toolbar && (
        <div className={s.toolbar()}>
          <FilterBar
            facets={facets}
            values={facetValues}
            onValuesChange={setFilter}
            search={searchable ? globalFilter : undefined}
            onSearchChange={searchable ? setGlobalFilter : undefined}
            searchPlaceholder={searchPlaceholder}
            extraChips={textChips}
            onClear={clearFilters}
          >
            {!loading && !error && (
              <span className={s.count()} aria-live="polite">
                {filtered === total
                  ? `${formatNumber(total)} rows`
                  : `${formatNumber(filtered)} of ${formatNumber(total)} rows`}
              </span>
            )}
            {actions}
            {hideableColumns.length > 1 && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="sm" intent="ghost">
                    <ColumnsIcon size={14} aria-hidden />
                    Columns
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuLabel>Show columns</MenuLabel>
                  <MenuSeparator />
                  {hideableColumns.map((c) => (
                    <MenuCheckboxItem
                      key={c.id}
                      checked={columnVisibility[c.id] !== false}
                      disabled={visibleColumns.length === 1 && columnVisibility[c.id] !== false}
                      onCheckedChange={(on) => setColumnVisibility((v) => ({ ...v, [c.id]: on }))}
                      onSelect={(e) => e.preventDefault()}
                    >
                      {c.header}
                    </MenuCheckboxItem>
                  ))}
                </MenuContent>
              </Menu>
            )}
          </FilterBar>
        </div>
      )}

      {selectable && selectedRows.length > 0 && (
        <div className={s.bulk()} role="region" aria-label="Bulk actions">
          <span className={s.bulkCount()} aria-live="polite">
            {formatNumber(selectedRows.length)} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {bulkActions?.(selectedRows, clearSelection)}
          </div>
          <Button size="sm" intent="ghost" className="ml-auto" onClick={clearSelection}>
            <XIcon size={12} weight="bold" aria-hidden />
            Clear selection
          </Button>
        </div>
      )}

      <div
        ref={scrollRef}
        role="grid"
        aria-label={label}
        aria-rowcount={showStates ? undefined : filtered + 1}
        aria-colcount={colCount}
        aria-multiselectable={selectable || undefined}
        aria-busy={loading || undefined}
        className={s.scroller()}
        style={{ maxHeight }}
      >
        <div className={s.inner()}>
          <div role="rowgroup" className={s.head()}>
            <div role="row" aria-rowindex={1} className={s.headRow()}>
              {selectable && (
                <div role="columnheader" className={s.th()}>
                  <Checkbox
                    aria-label="Select all rows"
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(on) => t.toggleAllRowsSelected(on)}
                    disabled={!filtered}
                  />
                </div>
              )}
              {visibleColumns.map((c) => {
                const column = t.getColumn(c.id);
                const sorted = column?.getIsSorted();
                const canSort = column?.getCanSort();
                const filterKind = c.filter ?? DEFAULT_FILTER[c.kind ?? 'text'];
                const SortGlyph =
                  sorted === 'asc' ? CaretUpIcon : sorted === 'desc' ? CaretDownIcon : CaretUpDownIcon;
                return (
                  <div
                    key={c.id}
                    role="columnheader"
                    aria-sort={
                      canSort
                        ? sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                            ? 'descending'
                            : 'none'
                        : undefined
                    }
                    className={s.th({
                      className: c.align === 'end' || c.kind === 'number' ? 'justify-end' : undefined,
                    })}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        className={s.sortButton()}
                        onClick={(e) => column?.toggleSorting(undefined, e.shiftKey)}
                      >
                        <span className="truncate">{c.header}</span>
                        <SortGlyph
                          size={12}
                          weight="bold"
                          aria-hidden
                          className={sorted ? 'text-accent' : 'opacity-60'}
                        />
                      </button>
                    ) : (
                      <span className="truncate">{c.header}</span>
                    )}
                    {filterKind !== 'none' && column && (
                      <ColumnFilter
                        label={c.header}
                        kind={filterKind}
                        value={column.getFilterValue()}
                        options={facets.find((f) => f.id === c.id)?.options ?? []}
                        onChange={(v) => setFilter(c.id, v)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {loading ? (
            <div role="rowgroup">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} role="row" className={cn(s.row(), 'static hover:bg-transparent')}>
                  {Array.from({ length: colCount }, (_, j) => (
                    <div key={j} role="gridcell" className={s.td()}>
                      <Skeleton className={j === 0 && selectable ? 'size-4' : 'w-3/4'} />
                    </div>
                  ))}
                </div>
              ))}
              <span className="sr-only">Loading {label}</span>
            </div>
          ) : error ? (
            <div role="rowgroup">
              <div role="row">
                <div role="gridcell" aria-colspan={colCount}>
                  <ErrorState
                    compact
                    title={error.title ?? `Couldn't load ${label.toLowerCase()}`}
                    message={error.message}
                    hint={error.hint}
                    code={error.code}
                    correlationId={error.correlationId}
                    action={
                      error.onRetry && (
                        <Button size="sm" onClick={error.onRetry}>
                          Try again
                        </Button>
                      )
                    }
                  />
                </div>
              </div>
            </div>
          ) : total === 0 || filtered === 0 ? (
            <div role="rowgroup">
              <div role="row">
                <div role="gridcell" aria-colspan={colCount}>
                  {total === 0 ? (
                    <EmptyState compact title={empty?.title ?? 'Nothing here yet'} action={empty?.action}>
                      {empty?.description}
                    </EmptyState>
                  ) : (
                    <EmptyState
                      compact
                      title="No rows match these filters"
                      action={
                        <Button size="sm" onClick={clearFilters}>
                          Clear filters
                        </Button>
                      }
                    >
                      Remove a filter or change the search to see more.
                    </EmptyState>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div role="rowgroup" className={s.body()} style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index]!;
                const selected = row.getIsSelected();
                const id = row.id;
                return (
                  <div
                    key={id}
                    role="row"
                    aria-rowindex={item.index + 2}
                    aria-selected={selectable ? selected : undefined}
                    data-row-index={item.index}
                    tabIndex={item.index === safeFocus ? 0 : -1}
                    onKeyDown={(e) => onRowKeyDown(e, item.index, row)}
                    onClick={(e) => onRowClick(e, item.index, row)}
                    onFocus={(e) => e.target === e.currentTarget && setFocusIndex(item.index)}
                    className={s.row({
                      selected,
                      active: activeRowId === id,
                      clickable: Boolean(onRowActivate),
                    })}
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {selectable && (
                      <div role="gridcell" className={s.td()}>
                        <Checkbox
                          aria-label={`Select ${labelFor(row.original) || 'row'}`}
                          checked={selected}
                          onClick={(e) => {
                            e.preventDefault();
                            row.getToggleSelectedHandler()({
                              target: { checked: !selected },
                              shiftKey: e.shiftKey,
                            });
                          }}
                        />
                      </div>
                    )}
                    {visibleColumns.map((c) => (
                      <div
                        key={c.id}
                        role="gridcell"
                        className={s.td({
                          className: c.align === 'end' || c.kind === 'number' ? 'justify-end' : undefined,
                        })}
                      >
                        <Cell col={c} row={row.original} now={now} />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
