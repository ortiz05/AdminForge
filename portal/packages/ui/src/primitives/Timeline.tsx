import type { ReactNode } from 'react';
import { formatRelative, formatTimestamp } from '../lib/format';
import { useNow } from '../lib/hooks';
import { STATUS_ICON, type StatusTone } from '../lib/status';
import { timeline } from '../recipes/timeline';

export interface TimelineItem {
  id: string;
  title: ReactNode;
  /** ISO timestamp. */
  time: string;
  description?: ReactNode;
  status?: StatusTone;
  /** Spoken status, e.g. "Succeeded". Defaults to the tone name. */
  statusLabel?: string;
}

/** Ordered events (run steps, audit trail). Each node's glyph shape carries the state. */
export function Timeline({
  items,
  label,
  className,
}: {
  items: TimelineItem[];
  label: string;
  className?: string;
}) {
  const now = useNow(30_000);
  const s = timeline();
  return (
    <ol className={s.list({ className })} aria-label={label}>
      {items.map((item, i) => {
        const tone = item.status ?? 'neutral';
        const Glyph = STATUS_ICON[tone];
        const c = timeline({ tone });
        return (
          <li key={item.id} className={c.item()}>
            {i < items.length - 1 && <span className={c.rail()} aria-hidden />}
            <span className={c.node()}>
              <Glyph size={18} weight="fill" aria-hidden />
            </span>
            <div className={c.body()}>
              <div className={c.head()}>
                <span className={c.title()}>
                  <span className="sr-only">{item.statusLabel ?? tone}: </span>
                  {item.title}
                </span>
                <time dateTime={item.time} title={formatTimestamp(item.time)} className={c.time()}>
                  {formatRelative(item.time, now)}
                </time>
              </div>
              {item.description && <div className={c.description()}>{item.description}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
