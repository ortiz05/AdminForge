import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { NewsArea, NewsKind } from '@adminforge/schemas';
import {
  ArrowClockwiseIcon,
  Button,
  CheckIcon,
  cn,
  EmptyState,
  formatRelative,
  formatTimestamp,
  IconButton,
  MagnifyingGlassIcon,
  NewspaperIcon,
  PageHeader,
  Panel,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  TextField,
  useNow,
  useToast,
  XIcon,
} from '@adminforge/ui';
import { errorDescription } from '../lib/errors';
import { updatePrefs } from '../lib/prefs';
import { useMe } from '../lib/session';
import { QueryError, useDocumentTitle } from '../ops/ui';
import { markAllRead, newsListQuery, newsSummaryQuery, type NewsFilter } from './api';
import { BreakingStrip } from './BreakingStrip';
import {
  AREA_LABEL,
  AREAS,
  countText,
  DEFAULT_DAYS,
  KIND_META,
  KINDS,
  RANGES,
  type RangeDays,
} from './model';
import { NewsDetail } from './NewsDetail';
import { NewsFeed } from './NewsFeed';
import { SourcesMenu } from './SourcesMenu';

/** URL state of /news (validated in routes/news.tsx). */
export interface NewsSearch {
  area?: NewsArea;
  kind?: NewsKind;
  feed?: string;
  tag?: string;
  q?: string;
  days?: RangeDays;
  breaking?: boolean;
  unread?: boolean;
  /** Item open in the detail panel. */
  item?: string;
}

const ALL = 'all';

function AreaFilter({ value, onChange }: { value?: NewsArea; onChange: (a: NewsArea | undefined) => void }) {
  const chip = (active: boolean) =>
    cn(
      'inline-flex h-7 items-center rounded-pill border px-3 text-xs font-medium whitespace-nowrap',
      'transition-colors duration-(--af-motion-fast)',
      active
        ? 'border-accent bg-accent-subtle text-accent'
        : 'border-line bg-panel text-fg-2 hover:border-line-strong hover:text-fg',
    );
  return (
    <div role="group" aria-label="Area" className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        className={chip(!value)}
        aria-pressed={!value}
        onClick={() => onChange(undefined)}
      >
        All areas
      </button>
      {AREAS.map((a) => (
        <button
          key={a}
          type="button"
          className={chip(value === a)}
          aria-pressed={value === a}
          onClick={() => onChange(value === a ? undefined : a)}
        >
          {AREA_LABEL[a]}
        </button>
      ))}
    </div>
  );
}

/** Search box that writes to the URL after a short pause (and at once on Enter). */
function SearchBox({ value, onChange }: { value?: string; onChange: (q: string | undefined) => void }) {
  const [draft, setDraft] = useState(value ?? '');
  // The URL changed from elsewhere (Reset filters, back button): show it. Adjusting state during render, not in an effect.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value ?? '');
  }
  useEffect(() => {
    const next = draft.trim() || undefined;
    if (next === (value ?? undefined)) return;
    const t = window.setTimeout(() => onChange(next), 350);
    return () => window.clearTimeout(t);
  }, [draft, value, onChange]);
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onChange(draft.trim() || undefined);
      }}
      className="w-full sm:w-64"
    >
      <TextField
        label="Search changes"
        hideLabel
        type="search"
        placeholder="Search titles and summaries"
        value={draft}
        maxLength={200}
        onChange={(e) => setDraft(e.target.value)}
        leading={<MagnifyingGlassIcon size={14} />}
        inputClassName="pl-8"
      />
    </form>
  );
}

/**
 * News and changes: what Microsoft changed, announced or broke in the services AdminForge manages — breaking items
 * first, then the wire, grouped by day, every item cited to its first-party source.
 */
export function NewsPage({ search }: { search: NewsSearch }) {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const now = useNow(30_000);
  useDocumentTitle('News and changes');
  const operator = me.roles.includes('Portal.Operator') || me.roles.includes('Portal.Admin');

  const filter: NewsFilter = {
    area: search.area,
    kind: search.kind,
    feed: search.feed,
    tag: search.tag,
    q: search.q,
    days: search.days ?? DEFAULT_DAYS,
    breaking: search.breaking,
    unread: search.unread,
  };
  const anyFilter = Boolean(
    filter.area ||
    filter.kind ||
    filter.feed ||
    filter.tag ||
    filter.q ||
    filter.breaking ||
    filter.unread ||
    search.days,
  );

  const summary = useQuery(newsSummaryQuery);
  const list = useInfiniteQuery(newsListQuery(filter));
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const feeds = summary.data?.feeds ?? [];
  const breaking = summary.data?.breaking ?? [];
  const unread = summary.data?.unread ?? 0;
  const neverCollected =
    summary.isSuccess && (feeds.length === 0 || feeds.every((f) => f.status === 'never'));

  const setSearch = (patch: Partial<NewsSearch>) =>
    void navigate({ to: '/news', search: (prev: NewsSearch) => ({ ...prev, ...patch }), replace: true });
  const open = (id: string) => setSearch({ item: id });
  const selected = search.item
    ? (items.find((i) => i.id === search.item) ?? breaking.find((i) => i.id === search.item))
    : undefined;

  const [marking, setMarking] = useState(false);
  const markRead = async () => {
    setMarking(true);
    try {
      const newsSeenAt = await markAllRead(new Date(now));
      updatePrefs({ newsSeenAt }, { save: false });
      await queryClient.invalidateQueries({ queryKey: ['news'] });
      toast({ tone: 'ok', title: 'Marked all as read' });
    } catch (e) {
      toast({ tone: 'crit', title: 'Couldn’t mark the news as read', description: errorDescription(e) });
    } finally {
      setMarking(false);
    }
  };

  const lastUpdated = summary.data?.lastUpdatedAt;

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="News and changes"
        description="Changes announced for the services AdminForge manages — your tenant’s Message Center and service health, Azure, Microsoft 365, Microsoft Graph and the PowerShell modules — each linked to its source."
        meta={
          lastUpdated ? (
            <span className="text-xs text-fg-3">
              Updated{' '}
              <time dateTime={lastUpdated} title={formatTimestamp(lastUpdated)}>
                {formatRelative(lastUpdated, now)}
              </time>
            </span>
          ) : summary.isSuccess ? (
            <span className="text-xs text-fg-3">Not collected yet</span>
          ) : null
        }
        actions={
          <>
            <SourcesMenu feeds={feeds} now={now} />
            <Button
              intent="secondary"
              onClick={() => void markRead()}
              pending={marking}
              disabled={!unread}
              aria-label={unread ? `Mark all as read (${countText(unread)} unread)` : 'Nothing unread'}
            >
              <CheckIcon size={15} aria-hidden />
              {/* Icon only on phones: the header's actions must fit a 390 px window. */}
              <span className="hidden sm:inline">Mark all as read</span>
            </Button>
            <IconButton
              label="Refresh"
              icon={<ArrowClockwiseIcon size={16} />}
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['news'] })}
            />
          </>
        }
      />
      <div className="flex flex-col gap-6">
        {summary.isError ? null : (
          <BreakingStrip
            items={breaking}
            now={now}
            onOpen={open}
            loading={summary.isPending}
            showAllHref={!search.breaking && (summary.data?.breakingUnread ?? 0) > breaking.length}
          />
        )}

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <AreaFilter value={filter.area} onChange={(area) => setSearch({ area })} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
            <Select
              label="Kind"
              hideLabel
              aria-label="Kind"
              className="w-44"
              value={filter.kind ?? ALL}
              onValueChange={(v) => setSearch({ kind: v === ALL ? undefined : (v as NewsKind) })}
              options={[
                { value: ALL, label: 'All kinds' },
                ...KINDS.map((k) => ({ value: k, label: KIND_META[k].plural })),
              ]}
            />
            <Select
              label="Source"
              hideLabel
              aria-label="Source"
              className="w-56"
              value={filter.feed ?? ALL}
              onValueChange={(v) => setSearch({ feed: v === ALL ? undefined : v })}
              options={[
                { value: ALL, label: 'All sources' },
                ...feeds.map((f) => ({ value: f.key, label: f.title })),
                // A source in the URL that the summary doesn't list (yet) stays selectable.
                ...(filter.feed && !feeds.some((f) => f.key === filter.feed)
                  ? [{ value: filter.feed, label: filter.feed }]
                  : []),
              ]}
            />
            <SegmentedControl
              aria-label="Time range"
              value={String(filter.days)}
              onValueChange={(v) => {
                const days = Number(v) as RangeDays;
                setSearch({ days: days === DEFAULT_DAYS ? undefined : days });
              }}
              options={RANGES.map((r) => ({
                value: String(r.days),
                label: r.label,
                'aria-label': r.days === 1 ? 'Last 24 hours' : `Last ${r.days} days`,
              }))}
            />
            <SearchBox value={filter.q} onChange={(q) => setSearch({ q })} />
            <Switch
              label="Unread only"
              checked={!!filter.unread}
              onCheckedChange={(v) => setSearch({ unread: v || undefined })}
            />
          </div>
          {(filter.tag || filter.breaking || anyFilter) && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-3">
              {filter.breaking && (
                <ActiveChip label="Breaking only" onClear={() => setSearch({ breaking: undefined })} />
              )}
              {filter.tag && (
                <ActiveChip label={`#${filter.tag}`} onClear={() => setSearch({ tag: undefined })} />
              )}
              {anyFilter && (
                <Button
                  intent="ghost"
                  size="sm"
                  onClick={() => void navigate({ to: '/news', search: {}, replace: true })}
                >
                  Reset filters
                </Button>
              )}
            </div>
          )}
        </div>

        {list.isError ? (
          <Panel>
            <QueryError title="News didn’t load" error={list.error} onRetry={() => void list.refetch()} />
          </Panel>
        ) : list.isPending ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading news">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} shape="block" className="h-32" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <Panel>
            {neverCollected && !anyFilter ? (
              <EmptyState
                title="Nothing collected yet"
                icon={<NewspaperIcon size={20} />}
                action={
                  operator ? (
                    <Link
                      to="/schedules"
                      className="text-sm font-semibold text-accent underline-offset-2 hover:underline"
                    >
                      Open Schedules
                    </Link>
                  ) : undefined
                }
              >
                The first collection runs on the hour.
                {operator
                  ? ' Operators can run the News refresh schedule now from Schedules.'
                  : ' Check back after the next hour, or ask an operator to run the News refresh schedule.'}
              </EmptyState>
            ) : anyFilter ? (
              <EmptyState
                title="No changes match these filters"
                action={
                  <Button size="sm" onClick={() => void navigate({ to: '/news', search: {}, replace: true })}>
                    Reset filters
                  </Button>
                }
              >
                Try a wider time range, another area, or clear the search.
              </EmptyState>
            ) : (
              <EmptyState
                title={`No changes in the last ${filter.days === 1 ? '24 hours' : `${filter.days} days`}`}
              >
                Choose a longer time range to see earlier announcements.
              </EmptyState>
            )}
          </Panel>
        ) : (
          <>
            <NewsFeed
              items={items}
              now={now}
              onOpen={open}
              onTag={(tag) => setSearch({ tag: filter.tag === tag ? undefined : tag })}
              activeTag={filter.tag}
            />
            {list.hasNextPage && (
              <div className="flex justify-center">
                <Button
                  intent="secondary"
                  pending={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      {search.item && (
        <NewsDetail
          key={search.item}
          id={search.item}
          known={selected}
          now={now}
          onClose={() => setSearch({ item: undefined })}
        />
      )}
    </>
  );
}

function ActiveChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-pill border border-accent bg-accent-subtle pr-1 pl-2.5 text-xs font-medium text-accent">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remove filter ${label}`}
        className="inline-flex size-4 items-center justify-center rounded-pill hover:bg-accent-subtle"
      >
        <XIcon size={10} weight="bold" aria-hidden />
      </button>
    </span>
  );
}
