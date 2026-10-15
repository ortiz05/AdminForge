import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CircleNotchIcon,
  cn,
  control,
  FieldShell,
  IdChip,
  MagnifyingGlassIcon,
  Popover,
  PopoverAnchor,
  PopoverContent,
  shorten,
  XIcon,
} from '@adminforge/ui';
import { api } from '../lib/api';
import { query } from '../runs/json';
import { SearchResponse, type SearchResult } from './contracts';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const NOUN: Record<string, string> = {
  user: 'user',
  group: 'group',
  device: 'device',
  app: 'app',
  resource: 'resource',
  subscription: 'subscription',
};

/** Ids an engineer may paste directly (object id, UPN for users, resource id for resources). */
function pastedId(kind: string, text: string): string | null {
  const t = text.trim();
  if (GUID_RE.test(t)) return t.toLowerCase();
  if (kind === 'user' && EMAIL_RE.test(t)) return t;
  if (kind === 'resource' && /^\/subscriptions\/[^/]+\//i.test(t)) return t;
  return null;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

const searchQuery = (kind: string, q: string) => ({
  queryKey: ['search', kind, q] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api(`/api/search${query({ q, type: kind })}`, { schema: SearchResponse, signal }),
  staleTime: 30_000,
  retry: false,
});

/** Shows a chosen id with its display name when search can resolve it. */
function SelectedEntity({
  kind,
  id,
  known,
  onRemove,
  label,
}: {
  kind: string;
  id: string;
  known?: SearchResult;
  onRemove: () => void;
  label: string;
}) {
  const lookup = useQuery({ ...searchQuery(kind, id), enabled: !known });
  const match = known ?? lookup.data?.find((r) => r.id.toLowerCase() === id.toLowerCase());
  return (
    <span className="flex min-h-(--af-control-h) min-w-0 items-center gap-2 rounded-(--af-input-radius) border border-line bg-raised py-1 pr-1 pl-2.5">
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate font-medium text-fg">{match?.title ?? shorten(id, 8, 6)}</span>
        {match?.subtitle && <span className="truncate text-xs text-fg-3">{match.subtitle}</span>}
      </span>
      {GUID_RE.test(id) && <IdChip value={id} label="Object ID" showLabel={false} className="shrink-0" />}
      <button
        type="button"
        onClick={onRemove}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg"
        aria-label={`Remove ${match?.title ?? id} from ${label}`}
      >
        <XIcon size={13} weight="bold" aria-hidden />
      </button>
    </span>
  );
}

export interface EntityPickerProps {
  kind: string;
  label: string;
  value: string | string[] | undefined;
  onChange: (value: string | string[] | undefined) => void;
  multiple?: boolean;
  maxItems?: number;
  hint?: string;
  error?: string;
  optional?: boolean;
  placeholder?: string;
}

/**
 * Search-as-you-type picker over GET /api/search?type=… (ARIA combobox). The value is the object id; pasting an id
 * (or a UPN for users) works too. Chosen items show their display name, resolved through the same search.
 */
export function EntityPicker({
  kind,
  label,
  value,
  onChange,
  multiple,
  maxItems,
  hint,
  error,
  optional,
  placeholder,
}: EntityPickerProps) {
  const ids = useMemo(() => (Array.isArray(value) ? value : value ? [value] : []), [value]);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [known, setKnown] = useState<Record<string, SearchResult>>({});
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const q = useDebounced(text.trim(), 250);
  const results = useQuery({ ...searchQuery(kind, q), enabled: open && q.length >= 2 });
  const noun = NOUN[kind] ?? 'item';
  const pasted = pastedId(kind, text);

  const options: Array<{ key: string; result: SearchResult }> = [
    ...(pasted && !results.data?.some((r) => r.id.toLowerCase() === pasted.toLowerCase())
      ? [{ key: `paste:${pasted}`, result: { type: kind, id: pasted, title: `Use ${pasted}`, subtitle: `Paste as ${noun} id`, href: null } }]
      : []),
    ...(results.data ?? []).filter((r) => !ids.includes(r.id)).map((r) => ({ key: r.id, result: r })),
  ];
  const full = Boolean(multiple && maxItems !== undefined && ids.length >= maxItems);
  const showInput = multiple ? !full : ids.length === 0;

  const choose = ({ key, result: r }: { key: string; result: SearchResult }) => {
    if (!key.startsWith('paste:')) setKnown((k) => ({ ...k, [r.id]: r }));
    onChange(multiple ? [...ids, r.id] : r.id);
    setText('');
    setActive(0);
    setOpen(multiple ? true : false);
    if (multiple) inputRef.current?.focus();
  };
  const remove = (id: string) => {
    const next = ids.filter((x) => x !== id);
    onChange(multiple ? (next.length ? next : undefined) : undefined);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(0, options.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      const opt = options[active];
      if (open && opt) {
        e.preventDefault();
        choose(opt);
      }
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'Backspace' && text === '' && multiple && ids.length) {
      remove(ids[ids.length - 1]!);
    }
  };

  const status =
    q.length < 2
      ? `Type at least 2 characters to search for a ${noun}${kind === 'user' ? ', or paste an object id or UPN' : ', or paste its id'}.`
      : results.isFetching && !results.data
        ? 'Searching…'
        : results.isError
          ? `Search didn’t answer. Paste the ${noun}’s id instead.`
          : options.length === 0
            ? `No ${noun}s match “${q}”.`
            : `${options.length} result${options.length === 1 ? '' : 's'}`;

  return (
    <FieldShell label={label} hint={hint} error={error} optional={optional}>
      {({ id, describedBy, invalid }) => (
        <div className="flex flex-col gap-1.5">
          {ids.map((x) => (
            <SelectedEntity key={x} kind={kind} id={x} known={known[x]} onRemove={() => remove(x)} label={label} />
          ))}
          {showInput && (
            <Popover open={open && (q.length >= 2 || text.length > 0)} onOpenChange={setOpen}>
              <PopoverAnchor asChild>
                <div className="relative flex items-center">
                  <span className="pointer-events-none absolute left-2.5 flex text-fg-3">
                    {results.isFetching ? (
                      <CircleNotchIcon size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
                    ) : (
                      <MagnifyingGlassIcon size={14} aria-hidden />
                    )}
                  </span>
                  <input
                    ref={inputRef}
                    id={ids.length && !multiple ? undefined : id}
                    role="combobox"
                    aria-expanded={open && options.length > 0}
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    autoComplete="off"
                    spellCheck={false}
                    value={text}
                    placeholder={placeholder ?? (multiple && ids.length ? `Add another ${noun}…` : `Search ${noun}s by name or id…`)}
                    onChange={(e) => {
                      setText(e.target.value);
                      setActive(0);
                      setOpen(true);
                    }}
                    onFocus={() => text && setOpen(true)}
                    onKeyDown={onKeyDown}
                    className={control({ kind: 'input', className: 'pl-8' })}
                  />
                </div>
              </PopoverAnchor>
              <PopoverContent
                className="w-(--radix-popover-trigger-width) min-w-72"
                onOpenAutoFocus={(e) => e.preventDefault()}
                onInteractOutside={(e) => {
                  if (inputRef.current?.contains(e.target as Node)) e.preventDefault();
                }}
              >
                <ul id={listId} role="listbox" aria-label={`${label} results`} className="flex max-h-72 flex-col overflow-y-auto p-1">
                  {options.map((o, i) => (
                    <li
                      key={o.key}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === active}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(o)}
                      className={cn(
                        'flex cursor-pointer flex-col rounded-md px-2 py-1.5 text-left',
                        i === active ? 'bg-accent-subtle text-fg' : 'text-fg-2',
                      )}
                    >
                      <span className={cn('truncate font-medium', o.key.startsWith('paste:') && 'font-mono text-xs')}>
                        {o.result.title}
                      </span>
                      {o.result.subtitle && <span className="truncate text-xs text-fg-3">{o.result.subtitle}</span>}
                    </li>
                  ))}
                </ul>
                <p className="border-t border-line px-3 py-2 text-xs text-fg-3" role="status">
                  {status}
                </p>
              </PopoverContent>
            </Popover>
          )}
          {full && <p className="text-xs text-fg-3">Maximum of {maxItems} reached.</p>}
        </div>
      )}
    </FieldShell>
  );
}
