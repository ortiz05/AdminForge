import { Link } from '@tanstack/react-router';
import { CheckCircleIcon, cn, formatRelative, formatTimestamp, STATUS_ICON } from '@adminforge/ui';
import { breakingTone, formatClock, activityOf, type NewsItem } from './model';
import { Citation, KindBadge, SeverityPill, UnreadDot } from './parts';

const TONE = {
  // The band's words are ink; the dot and glyph carry the tone (straw text is too faint on its fill in Daylight).
  crit: { frame: 'border-crit/45', band: 'bg-crit-subtle text-fg', dot: 'bg-crit', glyph: 'text-crit' },
  warn: { frame: 'border-warn/45', band: 'bg-warn-subtle text-fg', dot: 'bg-warn', glyph: 'text-warn' },
} as const;

/**
 * The wire at the top of News and changes: what needs attention now (active incidents, security advisories, critical
 * changes, deadlines inside two weeks). A calm line when nothing is breaking. Updates are announced politely.
 */
export function BreakingStrip({
  items,
  now,
  onOpen,
  showAllHref,
  loading,
}: {
  items: readonly NewsItem[];
  now: number;
  onOpen: (id: string) => void;
  /** Link to the feed filtered to breaking items (shown when there are more than the strip holds). */
  showAllHref?: boolean;
  loading?: boolean;
}) {
  if (loading) return null;
  if (!items.length)
    return (
      <p
        className="flex items-center gap-2 rounded-(--af-panel-radius) border border-line bg-panel px-4 py-2.5 text-sm text-fg-2"
        role="status"
      >
        <CheckCircleIcon size={16} weight="fill" aria-hidden className="shrink-0 text-ok" />
        Nothing breaking — no active incidents, urgent security advisories or deadlines in the next two weeks.
      </p>
    );
  const tone = breakingTone(items);
  const t = TONE[tone];
  const Glyph = STATUS_ICON[tone];
  return (
    <section
      aria-labelledby="news-breaking-heading"
      className={cn('overflow-hidden rounded-(--af-panel-radius) border bg-panel', t.frame)}
    >
      <header className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2', t.band)}>
        <span className="relative flex size-2.5 shrink-0" aria-hidden>
          <span
            className={cn(
              'absolute inline-flex size-full rounded-pill opacity-60 motion-safe:animate-ping',
              t.dot,
            )}
          />
          <span className={cn('relative inline-flex size-2.5 rounded-pill', t.dot)} />
        </span>
        <h2 id="news-breaking-heading" className="af-eyebrow flex items-center gap-1.5 text-current">
          <Glyph size={13} weight="fill" aria-hidden className={cn('shrink-0', t.glyph)} />
          Breaking
          <span className="font-mono tabular-nums">· {items.length}</span>
        </h2>
        <span className="text-xs text-fg-2">Needs attention now</span>
        {showAllHref && (
          <Link
            to="/news"
            search={{ breaking: true }}
            className="ml-auto text-xs font-semibold text-current underline-offset-2 hover:underline"
          >
            Show only breaking
          </Link>
        )}
      </header>
      <ol className="divide-y divide-line" aria-live="polite" aria-relevant="additions text">
        {items.map((item) => {
          const at = activityOf(item);
          return (
            <li key={item.id} className="flex gap-3 px-4 py-3">
              <time
                dateTime={at}
                title={formatTimestamp(at)}
                className="hidden w-14 shrink-0 pt-0.5 font-mono text-xs text-fg-3 tabular-nums sm:block"
              >
                {formatClock(at)}
              </time>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <UnreadDot unread={item.unread} />
                  <KindBadge kind={item.kind} />
                  <SeverityPill severity={item.severity} />
                  {item.status && <span className="text-xs text-fg-3">{item.status}</span>}
                  <span className="ml-auto text-xs text-fg-3">{formatRelative(at, now)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => onOpen(item.id)}
                  className="min-w-0 rounded-sm text-left font-semibold text-fg underline-offset-2 hover:underline"
                >
                  {item.title}
                </button>
                <Citation item={item} compact />
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
