import { useMemo, useState, type ReactNode } from 'react';
import { CaretDownIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import { formatNumber } from '../lib/format';

import { Button } from './Button';
import { TextField } from './Field';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';
import { Checkbox } from './Toggles';
import { filterBar } from '../recipes/filter-bar';

export interface FacetOption {
  value: string;
  label?: string;
  count?: number;
}

export interface Facet {
  id: string;
  label: string;
  options: FacetOption[];
}

export interface FilterChip {
  id: string;
  label: string;
  value: string;
  onRemove: () => void;
}

export interface FilterBarProps {
  facets?: Facet[];
  /** Selected option values per facet id. */
  values?: Record<string, string[]>;
  onValuesChange?: (facetId: string, values: string[]) => void;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** More active filters to show as chips (e.g. per-column text filters). */
  extraChips?: FilterChip[];
  onClear?: () => void;
  /** Right-aligned controls (column menu, export, counts). */
  children?: ReactNode;
  className?: string;
}

function FacetPicker({
  facet,
  selected,
  onChange,
}: {
  facet: Facet;
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const s = filterBar();
  const shown = useMemo(
    () =>
      facet.options.filter((o) => (o.label ?? o.value).toLowerCase().includes(query.trim().toLowerCase())),
    [facet.options, query],
  );
  const toggle = (value: string, on: boolean) =>
    onChange(on ? [...selected, value] : selected.filter((v) => v !== value));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          intent={selected.length ? 'secondary' : 'ghost'}
          className={selected.length ? 'border-accent' : 'border-line'}
          aria-label={selected.length ? `${facet.label}, ${selected.length} selected` : facet.label}
        >
          {facet.label}
          {selected.length > 0 && (
            <span className={s.facetCount()} aria-hidden>
              {selected.length}
            </span>
          )}
          <CaretDownIcon size={12} weight="bold" aria-hidden className="text-fg-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64" aria-label={`Filter by ${facet.label.toLowerCase()}`}>
        {facet.options.length > 8 && (
          <div className="border-b border-line p-2">
            <TextField
              label={`Find ${facet.label.toLowerCase()}`}
              hideLabel
              placeholder={`Find ${facet.label.toLowerCase()}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              leading={<MagnifyingGlassIcon size={14} />}
            />
          </div>
        )}
        <div
          role="group"
          aria-label={facet.label}
          className="flex max-h-72 flex-col gap-0.5 overflow-y-auto p-1.5"
        >
          {shown.map((o) => (
            <div
              key={o.value}
              className="flex items-center justify-between gap-3 rounded-md px-1.5 py-1 hover:bg-hover"
            >
              <Checkbox
                label={o.label ?? o.value}
                checked={selected.includes(o.value)}
                onCheckedChange={(on) => toggle(o.value, on)}
                className="min-w-0 flex-1"
              />
              {o.count != null && (
                <span className="font-mono text-2xs tabular-nums text-fg-3">{formatNumber(o.count)}</span>
              )}
            </div>
          ))}
          {shown.length === 0 && <p className="px-2 py-3 text-sm text-fg-3">No options match.</p>}
        </div>
        {selected.length > 0 && (
          <div className="flex justify-end border-t border-line p-1.5">
            <Button size="sm" intent="ghost" onClick={() => onChange([])}>
              Clear {facet.label.toLowerCase()}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Search + faceted multi-selects + removable chips + Clear — the standard filter row above every list (R9). */
export function FilterBar({
  facets = [],
  values = {},
  onValuesChange,
  search,
  onSearchChange,
  searchPlaceholder = 'Search…',
  extraChips = [],
  onClear,
  children,
  className,
}: FilterBarProps) {
  const s = filterBar();
  const facetChips: FilterChip[] = facets.flatMap((f) =>
    (values[f.id] ?? []).map((v) => ({
      id: `${f.id}:${v}`,
      label: f.label,
      value: f.options.find((o) => o.value === v)?.label ?? v,
      onRemove: () =>
        onValuesChange?.(
          f.id,
          (values[f.id] ?? []).filter((x) => x !== v),
        ),
    })),
  );
  const chips = [...facetChips, ...extraChips];
  const active = chips.length > 0 || Boolean(search);
  return (
    <div className={s.root({ className })}>
      <div className={s.row()}>
        {onSearchChange && (
          <TextField
            label="Search"
            hideLabel
            type="search"
            className={s.search()}
            placeholder={searchPlaceholder}
            value={search ?? ''}
            onChange={(e) => onSearchChange(e.target.value)}
            leading={<MagnifyingGlassIcon size={14} />}
            inputClassName="h-7"
          />
        )}
        {facets.map((f) => (
          <FacetPicker
            key={f.id}
            facet={f}
            selected={values[f.id] ?? []}
            onChange={(v) => onValuesChange?.(f.id, v)}
          />
        ))}
        {active && onClear && (
          <Button size="sm" intent="ghost" onClick={onClear}>
            Clear
          </Button>
        )}
        {children && <div className={s.spacer()}>{children}</div>}
      </div>
      {chips.length > 0 && (
        <ul className={s.chips()} aria-label="Active filters">
          {chips.map((c) => (
            <li key={c.id} className={s.chip()}>
              <span className={s.chipKey()}>{c.label}:</span>
              <span className="truncate">{c.value}</span>
              <button
                type="button"
                className={s.chipRemove()}
                aria-label={`Remove filter ${c.label}: ${c.value}`}
                onClick={c.onRemove}
              >
                <XIcon size={11} weight="bold" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
