import type { NewsKind } from '@adminforge/schemas';
import {
  ArrowSquareOutIcon,
  Badge,
  ClockCountdownIcon,
  cn,
  FlaskIcon,
  HourglassSimpleIcon,
  InfoIcon,
  MegaphoneIcon,
  PackageIcon,
  safeUrl,
  ShieldWarningIcon,
  SirenIcon,
  SparkleIcon,
  StatusPill,
  WarningIcon,
  WrenchIcon,
  type IconComponent,
} from '@adminforge/ui';
import {
  AREA_LABEL,
  deadlineOf,
  formatDay,
  KIND_META,
  SEVERITY_META,
  wasUpdated,
  type NewsItem,
} from './model';

/** Small pieces of a news item, shared by the feed, the breaking strip and the detail panel. */

const KIND_ICON: Record<NewsKind, IconComponent> = {
  incident: SirenIcon,
  advisory: WarningIcon,
  maintenance: WrenchIcon,
  security: ShieldWarningIcon,
  change: MegaphoneIcon,
  retirement: HourglassSimpleIcon,
  feature: SparkleIcon,
  preview: FlaskIcon,
  release: PackageIcon,
  info: InfoIcon,
};

/**
 * Kind as glyph + word (never colour alone). Straw (warn) text on its subtle fill is too faint at badge size in
 * Daylight, so warn kinds keep the straw glyph and set the word in ink.
 */
export function KindBadge({ kind, className }: { kind: NewsKind; className?: string }) {
  const meta = KIND_META[kind];
  const Glyph = KIND_ICON[kind];
  const warn = meta.tone === 'warn';
  return (
    <Badge tone={warn ? 'neutral' : meta.tone} className={cn(warn && 'border-warn/50', className)}>
      <Glyph size={11} weight="bold" aria-hidden className={warn ? 'text-warn' : undefined} />
      {meta.label}
    </Badge>
  );
}

/** Critical / High only; normal and low say nothing. High: straw glyph and outline, ink word (see KindBadge). */
export function SeverityPill({ severity }: { severity: NewsItem['severity'] }) {
  const meta = SEVERITY_META[severity];
  if (!meta) return null;
  if (meta.tone !== 'warn')
    return (
      <StatusPill status={meta.tone} size="sm">
        {meta.label}
      </StatusPill>
    );
  return (
    <span
      className="inline-flex h-5 items-center gap-1 rounded-(--af-pill-radius) border border-warn/50 px-1.5 text-2xs font-medium whitespace-nowrap text-fg"
      data-status="warn"
    >
      <WarningIcon size={12} weight="fill" aria-hidden className="shrink-0 text-warn" />
      {meta.label}
    </span>
  );
}

/** A small accent dot (temper blue, never ember) with words for screen readers. */
export function UnreadDot({ unread }: { unread: boolean }) {
  return unread ? (
    <span className="inline-flex size-2 shrink-0 rounded-pill bg-accent" role="img" aria-label="Unread" />
  ) : (
    <span className="inline-flex size-2 shrink-0" aria-hidden />
  );
}

/** A citation link the portal may render: https only, through the portal's link rule (no javascript:, no controls). */
export function citationHref(url: string): string | null {
  const safe = safeUrl(url);
  return safe?.external && /^https:\/\//i.test(safe.href) ? safe.href : null;
}

/**
 * "Source: Azure Updates · Microsoft ↗". The link opens the source in a new tab; a target the portal may not render
 * (anything but http(s), control characters, …) shows the attribution without a link.
 */
export function Citation({
  item,
  className,
  compact,
}: {
  item: Pick<NewsItem, 'url' | 'feedTitle' | 'publisher' | 'externalId'>;
  className?: string;
  compact?: boolean;
}) {
  const link = citationHref(item.url);
  const source = (
    <>
      <span className="font-medium text-fg-2">{item.feedTitle}</span>
      {item.publisher && <span className="text-fg-3"> · {item.publisher}</span>}
    </>
  );
  return (
    <p className={cn('flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-fg-3', className)}>
      <span>Source:</span>
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="group/cite inline-flex min-w-0 items-center gap-1 rounded-sm underline-offset-2 hover:underline"
          aria-label={`${item.feedTitle}${item.publisher ? `, ${item.publisher}` : ''} (opens in a new tab)`}
        >
          <span className="min-w-0 truncate">{source}</span>
          <ArrowSquareOutIcon
            size={12}
            aria-hidden
            className="shrink-0 text-fg-3 group-hover/cite:text-fg-2"
          />
        </a>
      ) : (
        <span className="min-w-0 truncate">{source}</span>
      )}
      {!compact && item.externalId && <span className="font-mono text-2xs text-fg-3">{item.externalId}</span>}
    </p>
  );
}

/** "Action required by 24 Oct 2026" — straw within 14 days, quiet later, past due says so. */
export function Deadline({ iso, now }: { iso: string | null; now: number }) {
  const d = deadlineOf(iso, now);
  if (!d || !iso) return null;
  if (d.state === 'past')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-3">
        <ClockCountdownIcon size={12} aria-hidden />
        Action was due {formatDay(iso)}
      </span>
    );
  const soon = d.state === 'soon';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        soon ? 'rounded-sm bg-warn-subtle px-1.5 font-semibold text-fg' : 'text-fg-2',
      )}
    >
      <ClockCountdownIcon
        size={12}
        weight={soon ? 'bold' : 'regular'}
        aria-hidden
        className={soon ? 'text-warn' : undefined}
      />
      Action required by {formatDay(iso)}
      {soon && <span className="font-normal">· {d.days <= 1 ? 'within a day' : `in ${d.days} days`}</span>}
    </span>
  );
}

export function UpdatedBadge({ item }: { item: NewsItem }) {
  return wasUpdated(item) ? <Badge tone="outline">Updated</Badge> : null;
}

/** Area chips (Identity, Azure, …). */
export function AreaChips({ areas }: { areas: NewsItem['areas'] }) {
  if (!areas.length) return null;
  return (
    <>
      {areas.map((a) => (
        <Badge key={a} tone="neutral">
          {AREA_LABEL[a]}
        </Badge>
      ))}
    </>
  );
}
