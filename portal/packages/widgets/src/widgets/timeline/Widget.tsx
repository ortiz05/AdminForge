import { useMemo } from 'react';
import { Skeleton, Timeline, type TimelineItem } from '@adminforge/ui';
import { hasExpression, useRowTemplates } from '../../lib/expr';
import { asRows, getPath } from '../../lib/path';
import { mapStatus, type StatusEntry, type StatusMap } from '../../lib/status';
import { WidgetPanel } from '../../lib/WidgetPanel';
import type { WidgetProps } from '../../types';
import type { TimelineConfig } from './schema';

import { toText as text } from '../../lib/text';

/** Events newest first (audit, sign-ins, run history); each node's glyph shape carries the state. */
export function TimelineWidget({ config, data, runtime }: WidgetProps<TimelineConfig>) {
  const rows = useMemo(() => {
    const all = asRows(data.value).filter((r) => getPath(r, config.ts) != null);
    all.sort((a, b) => new Date(text(getPath(b, config.ts))).getTime() - new Date(text(getPath(a, config.ts))).getTime());
    return all.slice(0, config.limit ?? 20);
  }, [data.value, config.ts, config.limit]);
  const titleTemplated = hasExpression(config.title);
  const detailTemplated = config.detail !== undefined && hasExpression(config.detail);
  const titles = useRowTemplates(rows, config.title, runtime.scope, titleTemplated);
  const details = useRowTemplates(rows, config.detail, runtime.scope, detailTemplated);

  const items: TimelineItem[] = rows.map((row, i) => {
    const st = config.status
      ? mapStatus(getPath(row, config.status.field), config.status.map as StatusMap | undefined, config.status.default as StatusEntry | undefined)
      : null;
    const title = titleTemplated ? text(titles?.[i]) : text(getPath(row, config.title));
    const detail = config.detail === undefined ? '' : detailTemplated ? text(details?.[i]) : text(getPath(row, config.detail));
    return {
      id: text(row.id ?? `${text(getPath(row, config.ts))}-${i}`),
      title: title || '—',
      time: text(getPath(row, config.ts)),
      description: detail || undefined,
      status: st?.tone,
      statusLabel: st?.label,
    };
  });

  return (
    <WidgetPanel
      config={{ ...config, title: config.heading }}
      data={data}
      runtime={runtime}
      name={config.heading ?? 'Activity'}
      isEmpty={rows.length === 0}
      emptyDefault={{ title: 'No activity in this period', body: 'Widen the time range to see older events.' }}
      skeleton={
        <div className="flex flex-col gap-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-4 rounded-pill" />
              <Skeleton className="w-2/3" />
            </div>
          ))}
        </div>
      }
    >
      <Timeline items={items} label={config.heading ?? 'Activity'} />
    </WidgetPanel>
  );
}
