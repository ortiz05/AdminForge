import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
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
import { useHtmlAttribute, useNow } from '../lib/hooks';
import { STATUS_SEVERITY, type StatusTone } from '../lib/status';
import { cn } from '../recipes/tv';
import { Badge } from './Badge';
import { Button } from './Button';
import { TextField } from './Field';
import { FilterBar, type Facet, type FilterChip } from './FilterBar';
import { IdChip } from './IdChip';
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from './Menu';
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

/**
 * Column filter kinds: "text" = contains; "facet" = pick values (also offered in the filter bar);
 * "date" = relative-time presets (last 7 days, more than 90 days ago, never…); "range" = min/max for numbers.
 */
export type ColumnFilterKind = 'text' | 'facet' | 'date' | 'range' | 'none';

/** Value of a `range` filter. */
export interface RangeFilterValue {
  min?: number;
  max?: number;
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
  /** Defaults by kind (text-like → text, status/tags → facet, time/number → none). */
  filter?: ColumnFilterKind;
  hideable?: boolean;
  /** Hidden until the user shows it from the Columns menu. */
  hidden?: boolean;
  /** Keep the header text for screen readers only (row-action columns). */
  headerHidden?: boolean;
  /** Keep the column at the start or end; pinned columns are never reordered. */
  pin?: 'start' | 'end';
}

export interface DataTableError {
  title?: string;
  message: string;
  hint?: string;
  code?: string;
  correlationId?: string;
  onRetry?: () => void;
}

/** The parts of a table's state worth keeping in a URL or a saved view. */
export interface DataTableView {
  sorting?: SortingState;
  columnFilters?: ColumnFiltersState;
  globalFilter?: string;
  columnVisibility?: ColumnVisibilityState;
  /** Column ids in display order (unknown ids are ignored; missing columns keep their declared order). */
  columnOrder?: string[];
}

export type TableDensity = 'comfortable' | 'compact';

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
  /**
   * Controlled view state (sort, filters, search, visible columns, column order). When set, every change is
   * reported through `onViewChange` and the table renders exactly `view`. Without it the table keeps its own state
   * (and still reports changes when `onViewChange` is given).
   */
  view?: DataTableView;
  onViewChange?: (view: DataTableView) => void;
  /** Row density for this table only (defaults to the user's density). */
  density?: TableDensity;
  /** Offers a density choice in the Columns menu. */
  onDensityChange?: (density: TableDensity) => void;
  /** Called when the user scrolls near the last loaded row (no filters active) — load the next page. */
  onEndReached?: () => void;
  /** The next page is loading (a status line shows under the grid). */
  loadingMore?: boolean;
  /** Toolbar row count text; default "12 rows" / "3 of 12 rows". */
  rowCountLabel?: (shown: number, loaded: number) => string;
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

const DEFAULT_FILTER: Record<ColumnKind, ColumnFilterKind> = {
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

/** Relative-time presets for `date` filters. Values are stable strings so they survive URLs and saved views. */
export const DATE_FILTER_PRESETS = [
  { value: 'past:1d', label: 'In the last 24 hours', when: 'past' },
  { value: 'past:7d', label: 'In the last 7 days', when: 'past' },
  { value: 'past:30d', label: 'In the last 30 days', when: 'past' },
  { value: 'older:30d', label: 'More than 30 days ago', when: 'past' },
  { value: 'older:90d', label: 'More than 90 days ago', when: 'past' },
  { value: 'overdue', label: 'Already passed', when: 'future' },
  { value: 'next:7d', label: 'In the next 7 days', when: 'future' },
  { value: 'next:30d', label: 'In the next 30 days', when: 'future' },
  { value: 'next:90d', label: 'In the next 90 days', when: 'future' },
  { value: 'blank', label: 'Never / not set', when: 'blank' },
] as const;

const UNIT_MS = { h: 3_600_000, d: 86_400_000 } as const;

/** Whether an ISO date matches a `date` filter preset (see DATE_FILTER_PRESETS). */
export function matchesDateFilter(spec: string, value: unknown, now: number = Date.now()): boolean {
  if (spec === 'blank') return value == null || value === '';
  if (value == null || value === '') return false;
  const t = toDate(value as string).getTime();
  if (Number.isNaN(t)) return false;
  if (spec === 'overdue') return t < now;
  const m = /^(past|older|next):(\d+)([hd])$/.exec(spec);
  if (!m) return true;
  const ms = Number(m[2]) * UNIT_MS[m[3] as 'h' | 'd'];
  if (m[1] === 'past') return t <= now && t >= now - ms;
  if (m[1] === 'older') return t < now - ms;
  return t >= now && t <= now + ms;
}

function matchesRange(range: RangeFilterValue, v: unknown): boolean {
  if (typeof v !== 'number' || Number.isNaN(v)) return false;
  if (range.min != null && v < range.min) return false;
  if (range.max != null && v > range.max) return false;
  return true;
}

const isRange = (v: unknown): v is RangeFilterValue =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && ('min' in v || 'max' in v);

function rangeLabel(r: RangeFilterValue): string {
  if (r.min != null && r.max != null) return `${formatNumber(r.min)} – ${formatNumber(r.max)}`;
  if (r.min != null) return `≥ ${formatNumber(r.min)}`;
  return `≤ ${formatNumber(r.max ?? 0)}`;
}

const dateLabel = (spec: string) => DATE_FILTER_PRESETS.find((p) => p.value === spec)?.label ?? spec;

/** Muted cell text; one step brighter on the selected-row fill so it keeps AA contrast. */
export const MUTED = 'text-fg-3 group-aria-selected/row:text-fg-2 group-data-active/row:text-fg-2';

function Cell<T extends RowData>({ col, row, now }: { col: DataColumn<T>; row: T; now: number }): ReactNode {
  if (col.cell) return col.cell(row);
  const v = col.value(row);
  const kind = col.kind ?? 'text';
  if (v == null || v === '') return <span className={MUTED}>—</span>;
  switch (kind) {
    case 'identity': {
      const id = v as IdentityValue;
      return (
        <span className="flex min-w-0 flex-col leading-tight compact:flex-row compact:items-baseline compact:gap-2">
          <span className="truncate font-medium text-fg">{id.primary}</span>
          {id.secondary && <span className={cn('truncate text-xs', MUTED)}>{id.secondary}</span>}
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
            <span className={cn('shrink-0 text-xs', MUTED)} title={tags.slice(2).join(', ')}>
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
  datePresets,
  onChange,
}: {
  label: string;
  kind: Exclude<ColumnFilterKind, 'none'>;
  value: unknown;
  options: Facet['options'];
  datePresets: ReadonlyArray<{ value: string; label: string }>;
  onChange: (v: unknown) => void;
}) {
  const active = Array.isArray(value) ? value.length > 0 : value != null && value !== '';
  const s = dataTable();
  const range = isRange(value) ? value : {};
  const setRange = (key: 'min' | 'max', raw: string) => {
    const n = raw.trim() === '' ? undefined : Number(raw);
    const next: RangeFilterValue = { ...range, [key]: n != null && Number.isFinite(n) ? n : undefined };
    onChange(next.min == null && next.max == null ? undefined : next);
  };
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
        ) : kind === 'range' ? (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <TextField
                label="Minimum"
                type="number"
                inputMode="decimal"
                autoFocus
                value={range.min ?? ''}
                onChange={(e) => setRange('min', e.target.value)}
              />
              <TextField
                label="Maximum"
                type="number"
                inputMode="decimal"
                value={range.max ?? ''}
                onChange={(e) => setRange('max', e.target.value)}
              />
            </div>
            {active && (
              <Button size="sm" intent="ghost" className="self-end" onClick={() => onChange(undefined)}>
                Clear {label.toLowerCase()}
              </Button>
            )}
          </div>
        ) : kind === 'date' ? (
          <div role="group" aria-label={label} className="flex flex-col gap-0.5">
            {datePresets.map((p) => {
              const on = value === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange(on ? undefined : p.value)}
                  className={cn(
                    'flex h-8 items-center justify-between gap-2 rounded-md px-2 text-left text-sm text-fg-2 hover:bg-hover hover:text-fg',
                    on && 'bg-selected font-medium text-fg',
                  )}
                >
                  {p.label}
                  {on && <span className="text-2xs text-accent">On</span>}
                </button>
              );
            })}
          </div>
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

const resolveUpdater = <V,>(updater: V | ((old: V) => V), old: V): V =>
  typeof updater === 'function' ? (updater as (old: V) => V)(old) : updater;

/** Reads `--af-table-row-h` from the table itself, so a per-table density takes effect. */
function useRowHeight(
  element: HTMLElement | null,
  density: TableDensity | undefined,
  fallback: number,
): number {
  const htmlDensity = useHtmlAttribute('data-density');
  return useMemo(() => {
    if (typeof document === 'undefined') return fallback;
    const value = parseFloat(
      getComputedStyle(element ?? document.documentElement).getPropertyValue('--af-table-row-h'),
    );
    return Number.isFinite(value) && value > 0 ? value : fallback;
    // `density` and `htmlDensity` are the triggers: the variable's value changes with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, density, htmlDensity, fallback]);
}

/**
 * The admin list: TanStack Table + Virtual. Sorting, per-column (text, facet, date, range) and faceted filters,
 * global search, column visibility and order (drag a header, or Alt+Shift+←/→ on it), per-table density, row
 * selection with a bulk-action bar, sticky header, keyboard row navigation (↑ ↓ Home End PgUp PgDn, Enter to
 * open, Space to select), incremental loading, and loading / error / empty states. State can be controlled
 * (`view` + `onViewChange`) so pages keep it in the URL.
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
  view,
  onViewChange,
  density,
  onDensityChange,
  onEndReached,
  loadingMore,
  rowCountLabel,
}: DataTableProps<T>) {
  const defaultVisibility = useMemo<ColumnVisibilityState>(
    () => Object.fromEntries(columns.filter((c) => c.hidden).map((c) => [c.id, false])),
    [columns],
  );
  const controlled = view !== undefined;
  const [inner, setInner] = useState<Required<DataTableView>>(() => ({
    sorting: initialSort,
    columnFilters: [],
    globalFilter: '',
    columnVisibility: defaultVisibility,
    columnOrder: [],
  }));
  const current: Required<DataTableView> = controlled
    ? {
        sorting: view.sorting ?? [],
        columnFilters: view.columnFilters ?? [],
        globalFilter: view.globalFilter ?? '',
        columnVisibility: view.columnVisibility ?? defaultVisibility,
        columnOrder: view.columnOrder ?? [],
      }
    : inner;
  const { sorting, columnFilters, globalFilter, columnVisibility, columnOrder } = current;
  // Several setters can fire in one event (clear = filters + search); each builds on the last.
  const latest = useRef(current);
  latest.current = current;
  const update = useCallback(
    (patch: Partial<DataTableView>) => {
      const next = { ...latest.current, ...patch };
      latest.current = next;
      if (!controlled) setInner(next);
      onViewChange?.(next);
    },
    [controlled, onViewChange],
  );
  const setSorting = (u: SortingState | ((old: SortingState) => SortingState)) =>
    update({ sorting: resolveUpdater(u, latest.current.sorting) });
  const setColumnFilters = (u: ColumnFiltersState | ((old: ColumnFiltersState) => ColumnFiltersState)) =>
    update({ columnFilters: resolveUpdater(u, latest.current.columnFilters) });
  const setGlobalFilter = (u: string | ((old: string) => string)) =>
    update({ globalFilter: resolveUpdater(u, latest.current.globalFilter) });
  const setColumnVisibility = (
    u: ColumnVisibilityState | ((old: ColumnVisibilityState) => ColumnVisibilityState),
  ) => update({ columnVisibility: resolveUpdater(u, latest.current.columnVisibility) });

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const now = useNow(30_000);
  const s = dataTable();

  const byId = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const kindOf = useCallback((id: string): ColumnKind => byId.get(id)?.kind ?? 'text', [byId]);
  const filterKindOf = useCallback(
    (id: string): ColumnFilterKind => {
      const c = byId.get(id);
      return c ? (c.filter ?? DEFAULT_FILTER[c.kind ?? 'text']) : 'none';
    },
    [byId],
  );

  // Display order: pinned start, then the user's order (declared order for anything not listed), then pinned end.
  const orderedColumns = useMemo(() => {
    const index = new Map(columnOrder.map((id, i) => [id, i]));
    const free = columns
      .map((c, declared) => ({ c, declared }))
      .filter(({ c }) => !c.pin)
      .sort(
        (a, b) =>
          (index.get(a.c.id) ?? columnOrder.length + a.declared) -
          (index.get(b.c.id) ?? columnOrder.length + b.declared),
      )
      .map(({ c }) => c);
    return [...columns.filter((c) => c.pin === 'start'), ...free, ...columns.filter((c) => c.pin === 'end')];
  }, [columns, columnOrder]);

  const columnDefs = useMemo(
    () =>
      columns.map((c) => {
        const kind = c.kind ?? 'text';
        const filterKind = c.filter ?? DEFAULT_FILTER[kind];
        return {
          id: c.id,
          header: c.header,
          // null → undefined so `sortUndefined: 'last'` keeps blanks at the bottom in both directions.
          accessorFn: (row: T) => c.value(row) ?? undefined,
          sortUndefined: 'last' as const,
          // Names and labels sort A→Z first; numbers high→low first (the counts that matter most).
          sortDescFirst: kind === 'number',
          enableSorting: c.sortable ?? true,
          enableHiding: c.hideable ?? true,
          enableColumnFilter: filterKind !== 'none',
          enableGlobalFilter: kind !== 'relativeTime' && kind !== 'number',
          sortFn: (a: Row<F, T>, b: Row<F, T>, id: string) => compare(kind, a.getValue(id), b.getValue(id)),
          filterFn: (row: Row<F, T>, id: string, filterValue: unknown) => {
            const v = row.getValue(id);
            if (filterKind === 'date' && typeof filterValue === 'string')
              return matchesDateFilter(filterValue, v ?? null);
            if (filterKind === 'range' && isRange(filterValue)) return matchesRange(filterValue, v);
            if (Array.isArray(filterValue))
              return filterValue.length === 0 || facetKeys(kind, v).some((k) => filterValue.includes(k));
            return searchText(kind, v).toLowerCase().includes(asString(filterValue).trim().toLowerCase());
          },
        };
      }),
    [columns],
  );

  // Filters on columns this table doesn't have (an old URL or saved view) are dropped instead of hiding every row.
  const knownFilters = useMemo(
    () => columnFilters.filter((f) => byId.has(f.id) && filterKindOf(f.id) !== 'none'),
    [columnFilters, byId, filterKindOf],
  );

  const t = useTable({
    features,
    columns: columnDefs,
    data,
    getRowId: (row: T) => getRowId(row),
    state: { sorting, columnFilters: knownFilters, globalFilter, rowSelection, columnVisibility },
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
  const visibleColumns = orderedColumns.filter((c) => columnVisibility[c.id] !== false);
  const template = [
    selectable ? '44px' : null,
    ...visibleColumns.map((c) => c.width ?? DEFAULT_WIDTH[c.kind ?? 'text']),
  ]
    .filter(Boolean)
    .join(' ');

  // Facet options with counts, from all rows (counts don't shift as you filter).
  const facets: Facet[] = useMemo(
    () =>
      orderedColumns
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
    [orderedColumns, data],
  );
  // Which date presets make sense for each date-filtered column (past, future, blank values present).
  const datePresets = useMemo(() => {
    const out = new Map<string, Array<{ value: string; label: string }>>();
    for (const c of columns) {
      if ((c.filter ?? DEFAULT_FILTER[c.kind ?? 'text']) !== 'date') continue;
      const seen = { past: false, future: false, blank: false };
      const t0 = Date.now();
      for (const row of data) {
        const v = c.value(row);
        if (v == null || v === '') seen.blank = true;
        else if (toDate(v as string).getTime() > t0) seen.future = true;
        else seen.past = true;
      }
      if (!seen.past && !seen.future) seen.past = true;
      out.set(
        c.id,
        DATE_FILTER_PRESETS.filter((p) => seen[p.when]),
      );
    }
    return out;
  }, [columns, data]);

  const facetValues = Object.fromEntries(
    knownFilters
      .filter((f) => filterKindOf(f.id) === 'facet' && Array.isArray(f.value))
      .map((f) => [f.id, f.value as string[]]),
  );
  const otherChips: FilterChip[] = knownFilters
    .filter((f) => filterKindOf(f.id) !== 'facet')
    .map((f) => {
      const fk = filterKindOf(f.id);
      return {
        id: f.id,
        label: byId.get(f.id)?.header ?? f.id,
        value:
          fk === 'date'
            ? dateLabel(asString(f.value))
            : fk === 'range' && isRange(f.value)
              ? rangeLabel(f.value)
              : `contains “${asString(f.value)}”`,
        onRemove: () => setColumnFilters((all) => all.filter((x) => x.id !== f.id)),
      };
    });
  const setFilter = (id: string, value: unknown) =>
    setColumnFilters((all) => {
      const rest = all.filter((f) => f.id !== id);
      return value == null || value === '' || (Array.isArray(value) && value.length === 0)
        ? rest
        : [...rest, { id, value }];
    });
  const clearFilters = () => update({ columnFilters: [], globalFilter: '' });

  // Column order: drag a header onto another, or Alt+Shift+←/→ on a header.
  const reorderable = orderedColumns.filter((c) => !c.pin);
  const moveColumn = (id: string, target: string | number) => {
    const ids = reorderable.map((c) => c.id);
    const visibleIds = ids.filter((x) => columnVisibility[x] !== false);
    const from = visibleIds.indexOf(id);
    const targetId = typeof target === 'number' ? visibleIds[from + target] : target;
    if (from < 0 || !targetId || targetId === id) return;
    const after = visibleIds.indexOf(targetId) > from;
    const without = ids.filter((x) => x !== id);
    const at = without.indexOf(targetId) + (after ? 1 : 0);
    const next = [...without.slice(0, at), id, ...without.slice(at)];
    update({ columnOrder: next });
    const position = next.filter((x) => columnVisibility[x] !== false).indexOf(id) + 1;
    setAnnouncement(`${byId.get(id)?.header ?? id} moved to position ${position} of ${visibleIds.length}`);
  };
  const customised =
    columnOrder.length > 0 ||
    Object.keys({ ...columnVisibility, ...defaultVisibility }).some(
      (k) => (columnVisibility[k] ?? true) !== (defaultVisibility[k] ?? true),
    );
  const resetColumns = () => {
    update({ columnOrder: [], columnVisibility: defaultVisibility });
    setAnnouncement('Columns reset to the default order and visibility');
  };
  const onHeaderDrop = (e: DragEvent<HTMLDivElement>, targetId: string) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragging;
    setDragging(null);
    setDropTarget(null);
    if (id && byId.has(id)) moveColumn(id, targetId);
  };

  // Virtual rows; height follows the density token (the table's own when `density` is set).
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useRowHeight(rootEl, density, 40);
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

  // Incremental loading: near the end of the loaded rows (only when nothing filters them).
  const virtualItems = virtualizer.getVirtualItems();
  const lastRendered = virtualItems.length ? virtualItems[virtualItems.length - 1]!.index : -1;
  const unfiltered = knownFilters.length === 0 && !globalFilter;
  useEffect(() => {
    if (!onEndReached || loading || loadingMore || error || !unfiltered || rows.length === 0) return;
    if (lastRendered >= rows.length - 8) onEndReached();
  }, [lastRendered, rows.length, onEndReached, loading, loadingMore, error, unfiltered]);

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
    if ((e.target as HTMLElement).closest('button, a, input, [role="checkbox"], [role="menu"]')) return;
    onRowActivate?.(row.original);
  };

  const selectedRows = t.getSelectedRowModel().rows.map((r) => r.original);
  const clearSelection = () => setRowSelection({});
  const allSelected = t.getIsAllRowsSelected();
  const someSelected = t.getIsSomeRowsSelected();
  const labelFor = (row: T) =>
    rowLabel?.(row) ?? searchText(columns[0]?.kind ?? 'text', columns[0]?.value(row)).trim();

  const hideableColumns = orderedColumns.filter((c) => c.hideable !== false);
  const filtered = rows.length;
  const total = data.length;
  const showStates = loading || error || total === 0;
  const colCount = visibleColumns.length + (selectable ? 1 : 0);
  const countText = rowCountLabel
    ? rowCountLabel(filtered, total)
    : filtered === total
      ? `${formatNumber(total)} rows`
      : `${formatNumber(filtered)} of ${formatNumber(total)} rows`;

  return (
    <div
      ref={setRootEl}
      data-density={density}
      className={s.root({ className })}
      style={{ '--af-dt-cols': template } as CSSProperties}
    >
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
      {toolbar && (
        <div className={s.toolbar()}>
          <FilterBar
            facets={facets}
            values={facetValues}
            onValuesChange={setFilter}
            search={searchable ? globalFilter : undefined}
            onSearchChange={searchable ? setGlobalFilter : undefined}
            searchPlaceholder={searchPlaceholder}
            extraChips={otherChips}
            onClear={clearFilters}
          >
            {!loading && !error && (
              <span className={s.count()} aria-live="polite">
                {countText}
              </span>
            )}
            {actions}
            {(hideableColumns.length > 1 || onDensityChange) && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="sm" intent="ghost">
                    <ColumnsIcon size={14} aria-hidden />
                    Columns
                  </Button>
                </MenuTrigger>
                <MenuContent className="max-h-(--radix-dropdown-menu-content-available-height) min-w-56 overflow-y-auto">
                  {hideableColumns.length > 1 && (
                    <>
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
                      <p className="px-2 pt-1.5 pb-1 text-2xs text-fg-3">
                        Drag a header to reorder, or press Alt+Shift+← / → on it.
                      </p>
                    </>
                  )}
                  {onDensityChange && (
                    <>
                      <MenuSeparator />
                      <MenuLabel>Row density</MenuLabel>
                      <MenuRadioGroup
                        value={density ?? 'comfortable'}
                        onValueChange={(v) => onDensityChange(v as TableDensity)}
                      >
                        <MenuRadioItem value="comfortable" onSelect={(e) => e.preventDefault()}>
                          Comfortable
                        </MenuRadioItem>
                        <MenuRadioItem value="compact" onSelect={(e) => e.preventDefault()}>
                          Compact
                        </MenuRadioItem>
                      </MenuRadioGroup>
                    </>
                  )}
                  {customised && (
                    <>
                      <MenuSeparator />
                      <MenuItem onSelect={resetColumns}>Reset columns</MenuItem>
                    </>
                  )}
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
                const movable = !c.pin;
                const SortGlyph =
                  sorted === 'asc' ? CaretUpIcon : sorted === 'desc' ? CaretDownIcon : CaretUpDownIcon;
                const onHeaderKey = (e: KeyboardEvent<HTMLElement>) => {
                  if (!movable || !e.altKey || !e.shiftKey) return;
                  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                  e.preventDefault();
                  moveColumn(c.id, e.key === 'ArrowLeft' ? -1 : 1);
                };
                const headerText = (
                  <span className={cn('truncate', c.headerHidden && 'sr-only')}>{c.header}</span>
                );
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
                    draggable={movable || undefined}
                    onDragStart={
                      movable
                        ? (e) => {
                            e.dataTransfer.setData('text/plain', c.id);
                            e.dataTransfer.effectAllowed = 'move';
                            setDragging(c.id);
                          }
                        : undefined
                    }
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTarget(null);
                    }}
                    onDragOver={
                      movable && dragging
                        ? (e) => {
                            e.preventDefault();
                            if (dropTarget !== c.id) setDropTarget(c.id);
                          }
                        : undefined
                    }
                    onDragLeave={() => dropTarget === c.id && setDropTarget(null)}
                    onDrop={movable ? (e) => onHeaderDrop(e, c.id) : undefined}
                    className={s.th({
                      className: cn(
                        (c.align === 'end' || c.kind === 'number') && 'justify-end',
                        dragging === c.id && 'opacity-60',
                        dropTarget === c.id && dragging !== c.id && 'bg-selected',
                      ),
                    })}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        className={s.sortButton()}
                        onClick={(e) => column?.toggleSorting(undefined, e.shiftKey)}
                        onKeyDown={onHeaderKey}
                        aria-keyshortcuts={movable ? 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight' : undefined}
                      >
                        {headerText}
                        <SortGlyph
                          size={12}
                          weight="bold"
                          aria-hidden
                          className={sorted ? 'text-accent' : 'opacity-60'}
                        />
                      </button>
                    ) : (
                      headerText
                    )}
                    {filterKind !== 'none' && column && (
                      <ColumnFilter
                        label={c.header}
                        kind={filterKind}
                        value={knownFilters.find((f) => f.id === c.id)?.value}
                        options={facets.find((f) => f.id === c.id)?.options ?? []}
                        datePresets={datePresets.get(c.id) ?? DATE_FILTER_PRESETS}
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
              {virtualItems.map((item) => {
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
                    data-active={activeRowId === id || undefined}
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
      {loadingMore && !loading && (
        <p
          role="status"
          className="flex items-center gap-2 border-t border-line px-(--af-pad-panel) py-2 text-xs text-fg-3"
        >
          <Skeleton className="h-2 w-16" />
          Loading more rows…
        </p>
      )}
    </div>
  );
}
