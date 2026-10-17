import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ClockIcon, cn, control, FieldShell, Popover, PopoverAnchor, PopoverContent } from '@adminforge/ui';
import { browserZone, timeZoneList, zoneOffset } from './cron';

/** How many matches the list shows at once (there are ~420 zones). */
const SHOWN = 60;

const label = (zone: string) => zone.replace(/_/g, ' ');
const words = (zone: string) => zone.replace(/[/_]/g, ' ').toLowerCase();

/** Offsets change twice a year at most: work each one out once an hour, not on every keystroke. */
const offsets = new Map<string, string>();
const offsetOf = (zone: string) => {
  const key = `${zone}@${Math.floor(Date.now() / 3_600_000)}`;
  let o = offsets.get(key);
  if (o === undefined) {
    if (offsets.size > 2_000) offsets.clear();
    o = zoneOffset(zone);
    offsets.set(key, o);
  }
  return o;
};

/**
 * Searchable list of every IANA time zone the browser knows (ARIA combobox). Focus selects the current zone so typing
 * replaces it; typing part of a city or region ("york", "london", "kolkata") or the arrow keys open the list with the
 * current zone highlighted. Enter picks only after typing or arrowing — otherwise it closes the list and leaves Enter
 * to the form; Escape and leaving the field keep the current zone. UTC and the browser's own zone come first, each
 * with its current offset. Used by the schedule editor and the report schedule form.
 */
export function TimeZoneField({
  value,
  onChange,
  label: fieldLabel = 'Time zone',
  hint,
  className,
}: {
  value: string;
  onChange: (zone: string) => void;
  label?: string;
  hint?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  /** What was typed since the list opened; null = nothing yet (the input shows the current zone). */
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  /** Typed or arrowed since opening: only then does Enter pick. */
  const [moved, setMoved] = useState(false);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const zones = useMemo(() => timeZoneList(value), [value]);
  const browser = browserZone();
  const q = (query ?? '').trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return zones;
    const terms = q.split(/[\s/_]+/).filter(Boolean);
    return zones.filter((z) => {
      const w = words(z);
      return terms.every((t) => w.includes(t));
    });
  }, [zones, q]);
  const shown = matches.slice(0, SHOWN);

  // The highlighted option stays in view while the arrow keys move it.
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, listId]);

  const openList = () => {
    if (open) return;
    setOpen(true);
    setQuery(null);
    setMoved(false);
    setActive(Math.max(0, zones.indexOf(value)));
  };
  const close = () => {
    setOpen(false);
    setQuery(null);
    setMoved(false);
  };
  const pick = (zone: string) => {
    onChange(zone);
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return openList();
      setMoved(true);
      setActive((i) =>
        e.key === 'ArrowDown' ? Math.min(i + 1, Math.max(0, shown.length - 1)) : Math.max(0, i - 1),
      );
    } else if (e.key === 'Enter' && open) {
      const zone = shown[active];
      // Enter right after focusing doesn't quietly choose the highlighted zone: it closes the list (and submits).
      if (moved && zone) {
        e.preventDefault();
        pick(zone);
      } else close();
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
      inputRef.current?.select();
    }
  };

  const status = !open
    ? ''
    : !shown.length
      ? `No time zone matches “${query?.trim()}”. Try a city (“london”) or a region (“america”).`
      : query === null || !q
        ? 'Type a city or region to narrow the list.'
        : matches.length > SHOWN
          ? `${matches.length} zones match; showing the first ${SHOWN}. Type more of the name.`
          : `${matches.length} zone${matches.length === 1 ? '' : 's'} match.`;

  return (
    <FieldShell
      label={fieldLabel}
      hint={hint ?? (browser === value ? 'Your browser’s time zone.' : `Your browser: ${label(browser)}.`)}
      className={className}
    >
      {({ id, describedBy }) => (
        <Popover open={open} onOpenChange={(o) => !o && close()}>
          <PopoverAnchor asChild>
            <div className="relative flex items-center">
              <span className="pointer-events-none absolute left-2.5 flex text-fg-3">
                <ClockIcon size={14} aria-hidden />
              </span>
              <input
                ref={inputRef}
                id={id}
                role="combobox"
                aria-expanded={open && shown.length > 0}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
                aria-describedby={describedBy}
                autoComplete="off"
                spellCheck={false}
                value={query ?? label(value)}
                placeholder="Type a city or region"
                // Selected, so typing replaces the zone; after the click that focused it, too.
                onFocus={(e) => {
                  const input = e.currentTarget;
                  window.setTimeout(() => input.select(), 0);
                }}
                onClick={openList}
                onChange={(e) => {
                  const typed = e.target.value;
                  const current = label(value);
                  // With nothing typed yet and the caret after the zone, only the new characters are the search.
                  setQuery(query === null && typed.startsWith(current) ? typed.slice(current.length) : typed);
                  setOpen(true);
                  setMoved(true);
                  setActive(0);
                }}
                onBlur={() => window.setTimeout(close, 0)}
                onKeyDown={onKeyDown}
                className={control({ kind: 'input', className: 'pl-8' })}
              />
            </div>
          </PopoverAnchor>
          <PopoverContent
            aria-label="Time zones"
            className="w-(--radix-popover-trigger-width) min-w-72"
            onOpenAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => {
              if (inputRef.current?.contains(e.target as Node)) e.preventDefault();
            }}
          >
            {shown.length > 0 && (
              <ul
                id={listId}
                role="listbox"
                aria-label={`${fieldLabel} choices`}
                className="flex max-h-72 flex-col overflow-y-auto p-1"
              >
                {shown.map((z, i) => (
                  <li
                    key={z}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(z)}
                    className={cn(
                      'flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-sm',
                      i === active ? 'bg-accent-subtle text-fg' : 'text-fg-2',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{label(z)}</span>
                    {z === browser && z !== 'UTC' && (
                      <span className="shrink-0 text-xs text-fg-3">your browser</span>
                    )}
                    {z === value && <span className="shrink-0 text-xs text-fg-3">current</span>}
                    <span
                      className={cn(
                        'shrink-0 font-mono text-2xs tabular-nums',
                        i === active ? 'text-fg-2' : 'text-fg-3',
                      )}
                    >
                      {offsetOf(z)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p
              className={cn('px-3 py-2 text-xs text-fg-3', shown.length > 0 && 'border-t border-line')}
              role="status"
            >
              {status}
            </p>
          </PopoverContent>
        </Popover>
      )}
    </FieldShell>
  );
}
