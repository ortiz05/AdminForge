import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  CaretDownIcon,
  Checkbox,
  filterBar,
  formatNumber,
  MagnifyingGlassIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  TextField,
  XIcon,
} from '@adminforge/ui';
import type { ScheduledFilter } from './catalog';

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

/** A multi-select facet: trigger with the selection count, checkboxes with counts, a finder for long lists. */
function Facet({
  label,
  options,
  selected,
  onChange,
  help,
}: {
  label: string;
  options: FacetOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  /** One line under the list, e.g. how several choices combine. */
  help?: string;
}) {
  const s = filterBar();
  const [find, setFind] = useState('');
  const shown = useMemo(() => {
    const q = find.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, find]);
  const toggle = (value: string, on: boolean) =>
    onChange(on ? [...selected, value] : selected.filter((v) => v !== value));
  return (
    <Popover onOpenChange={(open) => !open && setFind('')}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          intent={selected.length ? 'secondary' : 'ghost'}
          className={selected.length ? 'border-accent' : 'border-line'}
          aria-label={selected.length ? `${label}, ${selected.length} selected` : label}
        >
          {label}
          {selected.length > 0 && (
            <span className={s.facetCount()} aria-hidden>
              {selected.length}
            </span>
          )}
          <CaretDownIcon size={12} weight="bold" aria-hidden className="text-fg-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64" aria-label={`Filter by ${label.toLowerCase()}`}>
        {options.length > 8 && (
          <div className="border-b border-line p-2">
            <TextField
              label={`Find ${label.toLowerCase()}`}
              hideLabel
              placeholder={`Find ${label.toLowerCase()}…`}
              value={find}
              onChange={(e) => setFind(e.target.value)}
              leading={<MagnifyingGlassIcon size={14} />}
            />
          </div>
        )}
        <div role="group" aria-label={label} className="flex max-h-72 flex-col gap-0.5 overflow-y-auto p-1.5">
          {shown.map((o) => (
            <div
              key={o.value}
              className="flex items-center justify-between gap-3 rounded-md px-1.5 py-1 hover:bg-hover"
            >
              <Checkbox
                label={o.label}
                checked={selected.includes(o.value)}
                onCheckedChange={(on) => toggle(o.value, on)}
                className="min-w-0 flex-1"
              />
              <span className="font-mono text-2xs text-fg-3 tabular-nums">{formatNumber(o.count)}</span>
            </div>
          ))}
          {shown.length === 0 && (
            <p className="px-2 py-3 text-sm text-fg-3">No {label.toLowerCase()} match.</p>
          )}
        </div>
        {(help || selected.length > 0) && (
          <div className="flex items-center justify-between gap-2 border-t border-line p-1.5 pl-2.5">
            <span className="text-2xs text-fg-3">{help}</span>
            {selected.length > 0 && (
              <Button size="sm" intent="ghost" onClick={() => onChange([])}>
                Clear {label.toLowerCase()}
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Search box that writes to the URL after a short pause (and at once on Enter). */
function SearchBox({ value, onChange }: { value?: string; onChange: (q: string | undefined) => void }) {
  const s = filterBar();
  const [draft, setDraft] = useState(value ?? '');
  // The URL changed from elsewhere (Clear, the back button): show it. Adjusting state during render, not in an effect.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value ?? '');
  }
  useEffect(() => {
    const next = draft.trim() || undefined;
    if (next === (value?.trim() || undefined)) return;
    const t = window.setTimeout(() => onChange(next), 300);
    return () => window.clearTimeout(t);
  }, [draft, value, onChange]);
  return (
    <TextField
      label="Search reports"
      hideLabel
      type="search"
      className={s.search()}
      placeholder="Search titles, summaries, tags…"
      value={draft}
      maxLength={200}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onChange(draft.trim() || undefined);
      }}
      leading={<MagnifyingGlassIcon size={14} />}
      inputClassName="h-7"
    />
  );
}

export interface ReportFiltersProps {
  q?: string;
  areas: { options: FacetOption[]; selected: string[] };
  tags: { options: FacetOption[]; selected: string[] };
  scheduled?: ScheduledFilter;
  onSearch: (q: string | undefined) => void;
  onAreas: (areas: string[]) => void;
  onTags: (tags: string[]) => void;
  onScheduled: (scheduled: ScheduledFilter | undefined) => void;
  onClear: () => void;
  /** "12 of 58 reports". */
  count: string | null;
}

/**
 * One filter row above the catalogue, in the content renderer's filter-bar style: search, Area and Tags facets, the
 * schedule state, Clear, and the result count; active area and tag filters below as removable chips.
 */
export function ReportFilters({
  q,
  areas,
  tags,
  scheduled,
  onSearch,
  onAreas,
  onTags,
  onScheduled,
  onClear,
  count,
}: ReportFiltersProps) {
  const s = filterBar();
  const active = Boolean(q || areas.selected.length || tags.selected.length || scheduled);
  const label = (opts: FacetOption[], v: string) => opts.find((o) => o.value === v)?.label ?? v;
  const chips = [
    ...areas.selected.map((v) => ({
      id: `area:${v}`,
      key: 'Area',
      value: label(areas.options, v),
      remove: () => onAreas(areas.selected.filter((x) => x !== v)),
    })),
    ...tags.selected.map((v) => ({
      id: `tag:${v}`,
      key: 'Tag',
      value: v,
      remove: () => onTags(tags.selected.filter((x) => x !== v)),
    })),
  ];
  return (
    <div className={s.root()} role="search" aria-label="Filter reports">
      <div className={s.row()}>
        <SearchBox value={q} onChange={onSearch} />
        <Facet label="Area" options={areas.options} selected={areas.selected} onChange={onAreas} />
        <Facet
          label="Tags"
          options={tags.options}
          selected={tags.selected}
          onChange={onTags}
          help={tags.options.length > 1 ? 'Reports with every tag you pick' : undefined}
        />
        <SegmentedControl
          aria-label="Schedule"
          size="sm"
          value={scheduled ?? 'any'}
          onValueChange={(v) => onScheduled(v === 'yes' || v === 'no' ? v : undefined)}
          options={[
            { value: 'any', label: 'Any', 'aria-label': 'Scheduled or not' },
            { value: 'yes', label: 'Scheduled' },
            { value: 'no', label: 'Not scheduled' },
          ]}
        />
        {active && (
          <Button size="sm" intent="ghost" onClick={onClear}>
            Clear
          </Button>
        )}
        {count && (
          <div className={s.spacer()}>
            <span className="font-mono text-2xs whitespace-nowrap text-fg-3 tabular-nums" aria-live="polite">
              {count}
            </span>
          </div>
        )}
      </div>
      {chips.length > 0 && (
        <ul className={s.chips()} aria-label="Active filters">
          {chips.map((c) => (
            <li key={c.id} className={s.chip()}>
              <span className={s.chipKey()}>{c.key}:</span>
              <span className="truncate">{c.value}</span>
              <button
                type="button"
                className={s.chipRemove()}
                aria-label={`Remove filter ${c.key}: ${c.value}`}
                onClick={c.remove}
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
