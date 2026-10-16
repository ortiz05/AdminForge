import { Badge, cn, formatRelative, formatTimestamp } from '@adminforge/ui';
import { activityOf, groupByDay, type NewsItem } from './model';
import { AreaChips, Citation, Deadline, KindBadge, SeverityPill, UnreadDot, UpdatedBadge } from './parts';

/** One item on the wire: what, how urgent, why it matters to which area, and where it came from. */
export function NewsCard({
  item,
  now,
  onOpen,
  onTag,
  activeTag,
}: {
  item: NewsItem;
  now: number;
  onOpen: (id: string) => void;
  onTag: (tag: string) => void;
  activeTag?: string;
}) {
  const at = activityOf(item);
  const titleId = `news-item-${item.id}`;
  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        'flex gap-3 px-4 py-4 transition-colors duration-(--af-motion-fast) hover:bg-hover/40',
        item.unread && 'bg-accent-subtle/40',
      )}
    >
      <span className="flex pt-2">
        <UnreadDot unread={item.unread} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <KindBadge kind={item.kind} />
          <SeverityPill severity={item.severity} />
          {item.breaking && (
            <Badge tone="crit" className="uppercase">
              Breaking
            </Badge>
          )}
          <UpdatedBadge item={item} />
          {item.status && <span className="text-xs text-fg-3">{item.status}</span>}
          <time dateTime={at} title={formatTimestamp(at)} className="ml-auto text-xs text-fg-3 tabular-nums">
            {formatRelative(at, now)}
          </time>
        </div>
        <h3 id={titleId} className="min-w-0 text-base leading-snug font-semibold text-fg">
          <button
            type="button"
            onClick={() => onOpen(item.id)}
            className="rounded-sm text-left underline-offset-2 hover:underline"
          >
            {item.title}
          </button>
        </h3>
        {item.summary && (
          // Plain text from the API, rendered as text: markup in a source can never become HTML here.
          <p className="line-clamp-3 max-w-prose text-sm whitespace-pre-line text-fg-2">{item.summary}</p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Deadline iso={item.actionRequiredBy} now={now} />
          <AreaChips areas={item.areas} />
          {item.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => onTag(tag)}
              aria-pressed={activeTag === tag}
              aria-label={`Show only ${tag}`}
              className={cn(
                'inline-flex h-5 items-center rounded-sm border px-1.5 font-mono text-2xs text-fg-2',
                'transition-colors duration-(--af-motion-fast) hover:border-line-strong hover:text-fg',
                activeTag === tag ? 'border-accent bg-accent-subtle text-accent' : 'border-line',
              )}
            >
              #{tag}
            </button>
          ))}
        </div>
        <Citation item={item} />
      </div>
    </article>
  );
}

/** The feed, grouped by day of the source's last activity (newest first). */
export function NewsFeed({
  items,
  now,
  onOpen,
  onTag,
  activeTag,
}: {
  items: readonly NewsItem[];
  now: number;
  onOpen: (id: string) => void;
  onTag: (tag: string) => void;
  activeTag?: string;
}) {
  const groups = groupByDay(items, now);
  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`news-day-${g.key}`} className="flex flex-col gap-2">
          <h2
            id={`news-day-${g.key}`}
            className="af-eyebrow sticky top-(--af-layout-rail-h) z-1 flex items-center gap-2 bg-canvas py-1.5"
          >
            {g.label}
            <span className="font-normal normal-case tracking-normal text-fg-3">
              · {g.items.length} {g.items.length === 1 ? 'change' : 'changes'}
            </span>
          </h2>
          <ol className="divide-y divide-line overflow-hidden rounded-(--af-panel-radius) border border-line bg-panel">
            {g.items.map((item) => (
              <li key={item.id}>
                <NewsCard item={item} now={now} onOpen={onOpen} onTag={onTag} activeTag={activeTag} />
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
