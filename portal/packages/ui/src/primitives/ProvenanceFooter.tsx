import { formatDuration, formatRelative, formatTimestamp } from '../lib/format';
import { useNow } from '../lib/hooks';
import { cn } from '../recipes/tv';

export interface Provenance {
  /** Service family: graph, arm, exchange, fixtures… */
  service: string;
  /** Endpoint path, without host or query secrets. */
  path: string;
  /** Round-trip time of the upstream call. */
  ms?: number;
  /** When the data was fetched, if it came from cache. */
  cachedAt?: string;
  /** Microsoft request-id, for support tickets. */
  requestId?: string;
}

export type ProvenanceFooterProps = Provenance & { className?: string };

/**
 * `graph · /users · 1.2 s · cached 30 s ago` — where a number came from, how long it took, how fresh it is.
 * Muted mono 11 px so it stays out of the way; the relative time refreshes every 15 s.
 */
export function ProvenanceFooter({
  service,
  path,
  ms,
  cachedAt,
  requestId,
  className,
}: ProvenanceFooterProps) {
  const now = useNow(15_000);
  const parts = [
    service,
    path,
    ms != null ? formatDuration(ms) : null,
    cachedAt ? `cached ${formatRelative(cachedAt, now)}` : 'live',
  ];
  const title = [
    cachedAt ? `Fetched ${formatTimestamp(cachedAt)}` : null,
    requestId ? `Request ID ${requestId}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <p
      className={cn('flex min-w-0 items-center font-mono text-2xs leading-tight text-fg-3', className)}
      title={title || undefined}
    >
      <span className="sr-only">Data source: </span>
      {parts
        .filter((p): p is string => Boolean(p))
        .map((p, i) => (
          <span key={i} className={cn('whitespace-nowrap', i === 1 && 'min-w-0 truncate')}>
            {i > 0 && (
              <span aria-hidden className="mx-1.5">
                ·
              </span>
            )}
            {p}
          </span>
        ))}
    </p>
  );
}
