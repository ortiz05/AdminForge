import type { NewsFeedStatus } from '@adminforge/schemas';
import {
  ArrowSquareOutIcon,
  Badge,
  Button,
  formatRelative,
  formatTimestamp,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RssIcon,
  StatusPill,
  type StatusTone,
} from '@adminforge/ui';
import { formatDay } from './model';
import { citationHref } from './parts';

/** "every hour", "every 6 h", "daily". */
export function pollText(minutes: number): string {
  if (minutes < 60) return `every ${minutes} min`;
  if (minutes === 60) return 'every hour';
  if (minutes === 1440) return 'daily';
  const h = minutes / 60;
  return Number.isInteger(h) ? `every ${h} h` : `every ${minutes} min`;
}

const STATUS: Record<NewsFeedStatus['status'], { tone: StatusTone; label: string }> = {
  ok: { tone: 'ok', label: 'Collected' },
  error: { tone: 'crit', label: 'Last run failed' },
  stale: { tone: 'warn', label: 'Stale' },
  never: { tone: 'neutral', label: 'Not collected yet' },
};

/**
 * Where every item comes from: each feed, who publishes it, whether it's your tenant's or public, how often it's
 * checked, and its health. A quiet source (nothing new published for a while) is a note, not an error.
 */
export function SourcesMenu({ feeds, now }: { feeds: readonly NewsFeedStatus[]; now: number }) {
  const failing = feeds.filter((f) => f.status === 'error' || f.status === 'stale').length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          intent="secondary"
          aria-label={`Sources: ${feeds.length}${failing ? `, ${failing} need attention` : ''}`}
        >
          <RssIcon size={15} aria-hidden />
          Sources
          <span className="font-mono text-xs text-fg-3 tabular-nums">{feeds.length}</span>
          {failing > 0 && <span className="size-1.5 rounded-pill bg-warn" aria-hidden />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-(--radix-popover-content-available-width)">
        <div className="border-b border-line px-4 py-3">
          <p className="font-semibold text-fg">Sources</p>
          <p className="text-xs text-fg-3">
            Official sources, each checked on its own schedule. Your tenant’s announcements are read as the
            automation identity; public feeds keep a headline, a short excerpt and a link back.
          </p>
        </div>
        {feeds.length === 0 ? (
          <p className="px-4 py-3 text-sm text-fg-3">No sources are published yet.</p>
        ) : (
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {feeds.map((f) => {
              const s = STATUS[f.status];
              const home = citationHref(f.homepage);
              return (
                <li key={f.key} className="flex flex-col gap-1.5 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">{f.title}</p>
                      <p className="truncate text-xs text-fg-3">{f.publisher}</p>
                    </div>
                    <StatusPill status={s.tone} size="sm" className="shrink-0">
                      {s.label}
                    </StatusPill>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
                    <Badge tone="outline">{f.scope === 'tenant' ? 'Your tenant' : 'Public'}</Badge>
                    <span>
                      {f.items} {f.items === 1 ? 'item' : 'items'}
                    </span>
                    <span>Checked {pollText(f.pollMinutes)}</span>
                    {f.lastSuccessAt && (
                      <time dateTime={f.lastSuccessAt} title={formatTimestamp(f.lastSuccessAt)}>
                        last {formatRelative(f.lastSuccessAt, now)}
                      </time>
                    )}
                    {home && (
                      <a
                        href={home}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto inline-flex items-center gap-1 text-fg-2 underline-offset-2 hover:underline"
                        aria-label={`${f.title} home page (opens in a new tab)`}
                      >
                        Home page
                        <ArrowSquareOutIcon size={11} aria-hidden />
                      </a>
                    )}
                  </div>
                  {f.quiet && f.newestAt && (
                    <p className="text-xs text-fg-3">
                      No new posts from this source since{' '}
                      <time dateTime={f.newestAt} title={formatTimestamp(f.newestAt)}>
                        {formatDay(f.newestAt)}
                      </time>
                      .
                    </p>
                  )}
                  {f.error && (
                    <p className="rounded-sm bg-crit-subtle px-2 py-1 text-xs text-fg-2">
                      {f.error.message} <code className="font-mono text-2xs text-fg-3">{f.error.code}</code>
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
