import { useEffect, useMemo, useRef, useState } from 'react';
import type { Param, Params, TableWidgetConfig } from '@adminforge/schemas';
import {
  Button,
  CalendarBlankIcon,
  CaretDownIcon,
  Checkbox,
  MagnifyingGlassIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  TextField,
  WarningIcon,
  XIcon,
  cn,
  filterBar,
} from '@adminforge/ui';
import type { Block } from './blocks';
import {
  advancedParamOf,
  countConditions,
  encodeFilter,
  QueryBuilder,
  type AdvancedSpec,
  type WireGroup,
} from './QueryBuilder';
import {
  DATE_RANGE_PRESETS,
  dateRangeLabel,
  enumOptions,
  isDefault,
  isNeutralOption,
  literalDefault,
} from './params';

export interface FilterRegionProps {
  declared: Params;
  /** Search param bound to the text box. */
  searchParam?: string;
  /** Params shown as filters, in order. */
  filterParams: string[];
  values: Record<string, unknown>;
  issues: Record<string, string>;
  onChange: (patch: Record<string, unknown>) => void;
  /** The query builder (`filters.advanced`): the current structured filter and what the BFF rejected in it. */
  advanced?: { spec: AdvancedSpec; filter: WireGroup | undefined; issues: string[] };
  /** Right-aligned extras (row counts, refresh). */
  children?: React.ReactNode;
  /** List pages: the filter bar stays below the session rail while the list scrolls under it. */
  sticky?: boolean;
}

/** Whether a sticky element is stuck (scrolled to its `top`), checked once per frame while the window scrolls. */
function useStuck(ref: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const top = Number.parseFloat(getComputedStyle(el).top) || 0;
      setStuck(window.scrollY > 0 && el.getBoundingClientRect().top <= top + 0.5);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.cancelAnimationFrame(frame);
    };
  }, [ref, enabled]);
  return enabled && stuck;
}

/** Which params a list/dashboard page shows in its filter bar: `filters.facets`, `facet: true`, column-bound params, date ranges. */
export function filterParamsOf(
  def: { params?: Params; filters?: { search?: string; facets?: string[] } },
  blocks: readonly Block[],
): string[] {
  const params = def.params ?? {};
  const order: string[] = [...(def.filters?.facets ?? [])];
  for (const [name, p] of Object.entries(params))
    if ((p.facet || p.type === 'dateRange') && !p.hidden && !order.includes(name)) order.push(name);
  for (const b of blocks) {
    if (b.widget !== 'table') continue;
    for (const c of (b as unknown as TableWidgetConfig).columns ?? []) {
      const param = c && typeof c.filter === 'object' ? c.filter.param : undefined;
      if (param && params[param] && !params[param].hidden && !order.includes(param)) order.push(param);
    }
  }
  return order.filter((n) => n in params && n !== def.filters?.search);
}

const labelOf = (name: string, p: Param) => p.label ?? name;

function TriggerButton({
  label,
  active,
  count,
  ...rest
}: { label: string; active: boolean; count?: number } & React.ComponentProps<typeof Button>) {
  const s = filterBar();
  return (
    <Button
      size="sm"
      intent={active ? 'secondary' : 'ghost'}
      className={active ? 'border-accent' : 'border-line'}
      {...rest}
    >
      {label}
      {count ? (
        <span className={s.facetCount()} aria-hidden>
          {count}
        </span>
      ) : null}
      <CaretDownIcon size={12} weight="bold" aria-hidden className="text-fg-3" />
    </Button>
  );
}

/** Enum param: pick one (single) or several (multiple). Neutral defaults ("All") are the unselected state. */
function EnumFilter({
  name,
  p,
  value,
  onChange,
}: {
  name: string;
  p: Extract<Param, { type: 'enum' }>;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const options = enumOptions(p).filter((o) => !isNeutralOption(p, o.value));
  const selected = p.multiple
    ? Array.isArray(value)
      ? value
      : []
    : value === undefined || isNeutralOption(p, value)
      ? []
      : [value];
  const label = labelOf(name, p);
  const active =
    selected.length > 0 && !(p.multiple ? false : isDefault(p, value) && isNeutralOption(p, value));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <TriggerButton
          label={
            !p.multiple && active
              ? `${label}: ${options.find((o) => o.value === selected[0])?.label ?? String(selected[0])}`
              : label
          }
          active={active}
          count={p.multiple ? selected.length : undefined}
          aria-label={active ? `${label}, ${selected.length} selected` : label}
        />
      </PopoverTrigger>
      <PopoverContent className="w-64" aria-label={`Filter by ${label.toLowerCase()}`}>
        <div role="group" aria-label={label} className="flex max-h-72 flex-col gap-0.5 overflow-y-auto p-1.5">
          {options.map((o) => (
            <div key={String(o.value)} className="flex items-center rounded-md px-1.5 py-1 hover:bg-hover">
              <Checkbox
                label={o.label}
                checked={selected.includes(o.value)}
                className="min-w-0 flex-1"
                onCheckedChange={(on) => {
                  if (p.multiple)
                    onChange(on ? [...selected, o.value] : selected.filter((v) => v !== o.value));
                  else onChange(on ? o.value : undefined);
                }}
              />
            </div>
          ))}
        </div>
        {active && (
          <div className="flex justify-end border-t border-line p-1.5">
            <Button size="sm" intent="ghost" onClick={() => onChange(p.multiple ? [] : undefined)}>
              Clear {label.toLowerCase()}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Text-ish param (string, guid, entity id): "Department ▾" → an input. Applied on Enter or after a pause. */
function TextFilter({
  name,
  p,
  value,
  onChange,
}: {
  name: string;
  p: Param;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = labelOf(name, p);
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const [open, setOpen] = useState(false);
  const active = value !== undefined && value !== '';
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setDraft(value == null ? '' : String(value));
        else if (draft !== (value == null ? '' : String(value))) onChange(draft.trim() || undefined);
      }}
    >
      <PopoverTrigger asChild>
        <TriggerButton
          label={active ? `${label}: ${String(value)}` : label}
          active={active}
          aria-label={active ? `${label}: ${String(value)}` : label}
        />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" aria-label={`Filter by ${label.toLowerCase()}`}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onChange(draft.trim() || undefined);
            setOpen(false);
          }}
          className="flex flex-col gap-2"
        >
          <TextField
            label={p.type === 'string' ? `${label} equals` : label}
            placeholder={p.placeholder ?? `Exact ${label.toLowerCase()}`}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            {active && (
              <Button
                size="sm"
                intent="ghost"
                onClick={() => {
                  onChange(undefined);
                  setOpen(false);
                }}
              >
                Clear
              </Button>
            )}
            <Button size="sm" intent="primary" type="submit">
              Apply
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

const DEFAULT_PRESETS = ['P1D', 'P7D', 'P30D', 'P90D'];

/** Date range: presets (from the param, or 24 h / 7 / 30 / 90 days) plus a custom from–to. */
function DateRangeFilter({
  name,
  p,
  value,
  onChange,
}: {
  name: string;
  p: Extract<Param, { type: 'dateRange' }>;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = labelOf(name, p);
  const presets = p.presets?.length ? p.presets : DEFAULT_PRESETS;
  const custom = value && typeof value === 'object' ? (value as { from: string; to: string }) : undefined;
  const [from, setFrom] = useState(custom?.from.slice(0, 10) ?? '');
  const [to, setTo] = useState(custom?.to.slice(0, 10) ?? '');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          intent="secondary"
          className="border-line"
          aria-label={`${label}: ${dateRangeLabel(value)}`}
        >
          <CalendarBlankIcon size={14} aria-hidden className="text-fg-3" />
          {dateRangeLabel(value)}
          <CaretDownIcon size={12} weight="bold" aria-hidden className="text-fg-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" aria-label={label}>
        <div role="group" aria-label={`${label} presets`} className="flex flex-col gap-0.5">
          {presets.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={value === d}
              onClick={() => onChange(d)}
              className={cn(
                'flex h-8 items-center rounded-md px-2 text-left text-sm text-fg-2 hover:bg-hover hover:text-fg',
                value === d && 'bg-selected font-medium text-fg',
              )}
            >
              {DATE_RANGE_PRESETS[d] ?? d}
            </button>
          ))}
        </div>
        <form
          className="mt-2 grid grid-cols-2 gap-2 border-t border-line pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (from && to) onChange({ from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` });
          }}
        >
          <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button size="sm" type="submit" className="col-span-2" disabled={!from || !to || from > to}>
            Apply custom range
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function BooleanFilter({
  name,
  p,
  value,
  onChange,
}: {
  name: string;
  p: Param;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = labelOf(name, p);
  const options = [
    { value: true, label: 'Yes' },
    { value: false, label: 'No' },
  ];
  const active = typeof value === 'boolean' && !isDefault(p, value);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <TriggerButton
          label={typeof value === 'boolean' ? `${label}: ${value ? 'Yes' : 'No'}` : label}
          active={active}
        />
      </PopoverTrigger>
      <PopoverContent className="w-56" aria-label={label}>
        <div role="group" aria-label={label} className="flex flex-col gap-0.5 p-1.5">
          {options.map((o) => (
            <div key={String(o.value)} className="flex items-center rounded-md px-1.5 py-1 hover:bg-hover">
              <Checkbox
                label={o.label}
                checked={value === o.value}
                className="min-w-0 flex-1"
                onCheckedChange={(on) => onChange(on ? o.value : undefined)}
              />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function chipValue(p: Param, v: unknown): string {
  if (p.type === 'enum') {
    const opts = enumOptions(p);
    const one = (x: unknown) => opts.find((o) => o.value === x)?.label ?? String(x);
    return Array.isArray(v) ? v.map(one).join(', ') : one(v);
  }
  if (p.type === 'dateRange') return dateRangeLabel(v);
  if (p.type === 'boolean') return v ? 'Yes' : 'No';
  return Array.isArray(v) ? v.join(', ') : String(v);
}

/**
 * The page's server-side filter bar (R9): free-text search bound to a param, facets for enum/boolean params, text
 * filters for string params, a date-range picker. Every change goes to the URL and re-queries the BFF; tables refine
 * the loaded rows further with their own column filters.
 */
export function FilterRegion({
  declared,
  searchParam,
  filterParams,
  values,
  issues,
  onChange,
  advanced,
  children,
  sticky = false,
}: FilterRegionProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stuck = useStuck(rootRef, sticky);
  const advParam = advanced ? advancedParamOf(advanced.spec) : undefined;
  const advCount = countConditions(advanced?.filter);
  // The URL carries the structured filter as base64url JSON; the server validates and compiles it.
  const applyAdvanced = (filter: WireGroup | undefined) => {
    if (advParam) onChange({ [advParam]: filter ? encodeFilter(filter) : undefined });
  };
  const s = filterBar();
  const serverSearch = searchParam ? ((values[searchParam] as string | undefined) ?? '') : '';
  const [text, setText] = useState(serverSearch);
  const [syncedFrom, setSyncedFrom] = useState(serverSearch);
  if (syncedFrom !== serverSearch) {
    setSyncedFrom(serverSearch);
    setText(serverSearch);
  }
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onText = (v: string) => {
    setText(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => searchParam && onChange({ [searchParam]: v.trim() || undefined }),
      350,
    );
  };

  const chips = useMemo(
    () =>
      filterParams.flatMap((name) => {
        const p = declared[name];
        const v = values[name];
        if (!p || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return [];
        if (
          isDefault(p, v) &&
          (isNeutralOption(p, v) || p.type === 'dateRange' || literalDefault(p) !== undefined)
        )
          return [];
        return [{ name, label: labelOf(name, p), value: chipValue(p, v) }];
      }),
    [filterParams, declared, values],
  );
  const issueList = Object.values(issues);
  const clearAll = () => {
    const patch: Record<string, unknown> = Object.fromEntries(filterParams.map((n) => [n, undefined]));
    if (searchParam) patch[searchParam] = undefined;
    if (advParam) patch[advParam] = undefined;
    setText('');
    onChange(patch);
  };

  return (
    <div
      ref={rootRef}
      // Sticky from lg (on a phone the wrapped filters would take the screen): full-bleed over the shell's px-8 so
      // rows don't show beside it, a hairline once it is stuck; the negative margin keeps the page's rhythm.
      className={cn(
        s.root(),
        sticky &&
          'lg:sticky lg:top-(--af-layout-rail-h) lg:z-(--af-z-sticky) lg:-mx-8 lg:-my-2 lg:border-b lg:border-transparent lg:bg-canvas lg:px-8 lg:py-2',
        stuck && 'lg:border-line',
      )}
      role="search"
      aria-label="Filters"
      data-sticky={sticky || undefined}
      data-stuck={stuck || undefined}
    >
      <div className={s.row()}>
        {searchParam && declared[searchParam] && (
          <TextField
            label={declared[searchParam]!.label ?? 'Search'}
            hideLabel
            type="search"
            className={cn(s.search(), 'w-72')}
            placeholder={declared[searchParam]!.placeholder ?? 'Search…'}
            value={text}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                window.clearTimeout(timer.current);
                onChange({ [searchParam]: text.trim() || undefined });
              }
            }}
            leading={<MagnifyingGlassIcon size={14} />}
            inputClassName="h-7"
          />
        )}
        {filterParams.map((name) => {
          const p = declared[name];
          if (!p) return null;
          const set = (v: unknown) => onChange({ [name]: v });
          if (p.type === 'enum')
            return <EnumFilter key={name} name={name} p={p} value={values[name]} onChange={set} />;
          if (p.type === 'dateRange')
            return <DateRangeFilter key={name} name={name} p={p} value={values[name]} onChange={set} />;
          if (p.type === 'boolean')
            return <BooleanFilter key={name} name={name} p={p} value={values[name]} onChange={set} />;
          return (
            <TextFilter
              key={`${name}:${String(values[name] ?? '')}`}
              name={name}
              p={p}
              value={values[name]}
              onChange={set}
            />
          );
        })}
        {advanced && (
          <QueryBuilder
            spec={advanced.spec}
            filter={advanced.filter}
            onApply={applyAdvanced}
            serverIssues={advanced.issues}
          />
        )}
        {(chips.length > 0 || serverSearch || advCount > 0) && (
          <Button size="sm" intent="ghost" onClick={clearAll}>
            Clear
          </Button>
        )}
        {children && <div className={s.spacer()}>{children}</div>}
      </div>
      {(chips.length > 0 || advCount > 0) && (
        <ul className={s.chips()} aria-label="Active filters">
          {advCount > 0 && (
            <li className={s.chip()}>
              <span className={s.chipKey()}>Advanced:</span>
              <span className="truncate">
                {advCount} {advCount === 1 ? 'condition' : 'conditions'}
              </span>
              <button
                type="button"
                className={s.chipRemove()}
                aria-label="Remove advanced filter"
                onClick={() => applyAdvanced(undefined)}
              >
                <XIcon size={11} weight="bold" aria-hidden />
              </button>
            </li>
          )}
          {chips.map((c) => (
            <li key={c.name} className={s.chip()}>
              <span className={s.chipKey()}>{c.label}:</span>
              <span className="truncate">{c.value}</span>
              <button
                type="button"
                className={s.chipRemove()}
                aria-label={`Remove filter ${c.label}: ${c.value}`}
                onClick={() => onChange({ [c.name]: undefined })}
              >
                <XIcon size={11} weight="bold" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {(advanced?.issues.length ?? 0) > 0 && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-crit">
          <WarningIcon size={13} weight="fill" aria-hidden />
          The advanced filter was rejected: {advanced!.issues.join('; ')}. Open Advanced to fix it.
        </p>
      )}
      {issueList.length > 0 && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-warn">
          <WarningIcon size={13} weight="fill" aria-hidden />
          Some filters in this link were ignored: {issueList.join('; ')}.
        </p>
      )}
    </div>
  );
}
