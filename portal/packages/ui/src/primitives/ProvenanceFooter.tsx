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
  /** Served by a Microsoft Graph beta (preview) endpoint. */
  preview?: boolean;
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
  preview,
  className,
}: ProvenanceFooterProps) {
  const now = useNow(15_000);
  const took = ms != null ? formatDuration(ms) : null;
  // One line that never pushes past its box (a phone, a narrow panel). The path is cut off first: it takes no room
  // when the line is laid out (`basis-0`) and grows into what's left, up to its own width. On a phone the request time
  // is left out (it stays in the hover text). A part that still doesn't fit moves to a second line, which the fixed
  // height hides — whole parts drop from the end instead of being clipped mid-word or widening the page.
  const parts: Array<{ text: string; className?: string }> = [
    { text: service },
    { text: path, className: 'min-w-0 max-w-max grow basis-0 truncate' },
    ...(took ? [{ text: took, className: 'max-sm:hidden' }] : []),
    { text: cachedAt ? `cached ${formatRelative(cachedAt, now)}` : 'live' },
  ];
  const title = [
    preview ? 'Microsoft Graph beta: a preview API that can change without notice' : null,
    took ? `Took ${took}` : null,
    cachedAt ? `Fetched ${formatTimestamp(cachedAt)}` : null,
    requestId ? `Request ID ${requestId}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <p
      className={cn(
        'flex h-4 min-w-0 flex-wrap items-center overflow-hidden font-mono text-2xs leading-tight text-fg-3',
        className,
      )}
      title={title || undefined}
    >
      <span className="sr-only">Data source: </span>
      {preview && (
        <span className="mr-1.5 shrink-0 rounded-sm border border-warn px-1 whitespace-nowrap text-warn">
          preview API
        </span>
      )}
      {parts
        .filter((p) => Boolean(p.text))
        .map((p, i) => (
          <span key={i} className={cn('whitespace-nowrap', p.className)}>
            {i > 0 && (
              <span aria-hidden className="mx-1.5">
                ·
              </span>
            )}
            {p.text}
          </span>
        ))}
    </p>
  );
}
