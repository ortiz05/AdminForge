import { useQuery } from '@tanstack/react-query';
import { ArrowSquareOutIcon, Badge, Drawer, formatRelative, formatTimestamp, Skeleton } from '@adminforge/ui';
import { Callout, Facts, QueryError } from '../ops/ui';
import { newsItemQuery } from './api';
import { AREA_LABEL, deadlineOf, formatDay, KIND_META, type NewsItem } from './model';
import { Citation, citationHref, KindBadge, SeverityPill } from './parts';

const when = (iso: string | null, now: number) =>
  iso ? (
    <time dateTime={iso} title={formatTimestamp(iso)}>
      {formatDay(iso)} <span className="text-fg-3">· {formatRelative(iso, now)}</span>
    </time>
  ) : null;

function Body({ item, now }: { item: NewsItem; now: number }) {
  const deadline = deadlineOf(item.actionRequiredBy, now);
  const href = citationHref(item.url);
  return (
    <div className="flex flex-col gap-6">
      {deadline && item.actionRequiredBy && deadline.state !== 'past' && (
        <Callout
          tone={deadline.state === 'soon' ? 'warn' : 'info'}
          title={`Action required by ${formatDay(item.actionRequiredBy)}`}
        >
          {deadline.days <= 1 ? 'Due within a day.' : `Due in ${deadline.days} days.`} Read the source for
          what to change before then.
        </Callout>
      )}
      {item.summary ? (
        <p className="text-sm whitespace-pre-line text-fg-2">{item.summary}</p>
      ) : (
        <p className="text-sm text-fg-3">The source has no summary for this item. Open it for the details.</p>
      )}
      <Facts
        items={[
          ['Kind', KIND_META[item.kind].label],
          ['Status', item.status],
          ['Published', when(item.publishedAt, now)],
          ['Updated', when(item.updatedAt, now)],
          ['First seen', when(item.firstSeenAt, now)],
          ['Action required by', item.actionRequiredBy ? formatDay(item.actionRequiredBy) : null],
          ['Areas', item.areas.length ? item.areas.map((a) => AREA_LABEL[a]).join(', ') : null],
          [
            'Tags',
            item.tags.length ? (
              <span key="tags" className="flex flex-wrap gap-1">
                {item.tags.map((t) => (
                  <Badge key={t} tone="outline" mono>
                    #{t}
                  </Badge>
                ))}
              </span>
            ) : null,
          ],
          [
            'Source id',
            item.externalId ? (
              <code key="id" className="font-mono text-xs">
                {item.externalId}
              </code>
            ) : null,
          ],
          ...item.facts.map((f): [string, string] => [f.label, f.value]),
        ]}
      />
      <section aria-label="Citation" className="flex flex-col gap-2 border-t border-line pt-4">
        <Citation item={item} compact />
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-(--af-control-h) w-fit items-center gap-2 rounded-(--af-button-radius) border border-line bg-raised px-3 text-sm font-semibold text-fg hover:border-line-strong hover:bg-hover"
          >
            Read at the source
            <ArrowSquareOutIcon size={14} aria-hidden />
          </a>
        )}
        <p className="text-xs text-fg-3">
          AdminForge keeps the headline and a short excerpt; the source has the full text.
        </p>
      </section>
    </div>
  );
}

/**
 * Detail panel for one item (`?item=<id>`): the item from the loaded feed when it's there, otherwise read from
 * GET /api/news/:id (a shared link, an item outside the current filters).
 */
export function NewsDetail({
  id,
  known,
  now,
  onClose,
}: {
  id: string;
  known: NewsItem | undefined;
  now: number;
  onClose: () => void;
}) {
  const q = useQuery({ ...newsItemQuery(id), enabled: !known });
  const item = known ?? q.data;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      modal={false}
      docked
      className="w-160"
      eyebrow={item ? `${KIND_META[item.kind].label} · ${item.feedTitle}` : 'News and changes'}
      title={item?.title ?? (q.isError ? 'Item not available' : 'Loading…')}
      description={
        item ? (
          <span className="flex flex-wrap items-center gap-2">
            <KindBadge kind={item.kind} />
            <SeverityPill severity={item.severity} />
            {item.breaking && (
              <Badge tone="crit" className="uppercase">
                Breaking
              </Badge>
            )}
          </span>
        ) : undefined
      }
    >
      {item ? (
        <Body item={item} now={now} />
      ) : q.isError ? (
        <QueryError compact title="This item didn’t load" error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <Skeleton shape="block" className="h-48 w-full" />
      )}
    </Drawer>
  );
}
