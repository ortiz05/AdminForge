import { useMemo } from 'react';
import { STATUS_SEVERITY, Skeleton, StatusPill, cn } from '@adminforge/ui';
import { hasExpression, useRowTemplates } from '../../lib/expr';
import { asRows, getPath } from '../../lib/path';
import { mapStatus, type StatusEntry, type StatusMap } from '../../lib/status';
import { WidgetPanel } from '../../lib/WidgetPanel';
import type { WidgetProps } from '../../types';
import type { StatusGridConfig } from './schema';

const text = (v: unknown) => (v == null ? '' : String(v));

/** Named things and their state as tiles, worst first (service health, connections, probes). */
export function StatusGridWidget({ config, data, runtime, variant }: WidgetProps<StatusGridConfig>) {
  const rows = useMemo(() => {
    const all = asRows(data.value).map((row) => ({
      row,
      label: text(getPath(row, config.label)),
      status: mapStatus(getPath(row, config.status), config.map as StatusMap | undefined, config.default as StatusEntry | undefined) ?? {
        tone: 'neutral' as const,
        label: 'Unknown',
      },
    }));
    if (config.sort === 'none') return all;
    return all.sort((a, b) => STATUS_SEVERITY[b.status.tone] - STATUS_SEVERITY[a.status.tone] || a.label.localeCompare(b.label));
  }, [data.value, config.label, config.status, config.map, config.default, config.sort]);
  const plainRows = useMemo(() => rows.map((r) => r.row), [rows]);
  const detailTemplated = config.detail !== undefined && hasExpression(config.detail);
  const details = useRowTemplates(plainRows, config.detail, runtime.scope, detailTemplated);
  const hrefs = useRowTemplates(plainRows, config.href, runtime.scope, config.href !== undefined);
  const L = runtime.Link;
  const counts = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status.tone]: (acc[r.status.tone] ?? 0) + 1 }), {});
  const attention = (counts.crit ?? 0) + (counts.warn ?? 0);

  return (
    <WidgetPanel
      config={config}
      data={data}
      runtime={runtime}
      name={config.title ?? 'Status'}
      isEmpty={rows.length === 0}
      emptyDefault={{ title: 'Nothing reported yet', body: 'States appear here once the source reports any.' }}
      actions={
        data.status === 'ready' &&
        rows.length > 0 && (
          <StatusPill status={counts.crit ? 'crit' : counts.warn ? 'warn' : 'ok'} size="sm">
            {attention ? `${attention} need attention` : 'All healthy'}
          </StatusPill>
        )
      }
      skeleton={
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} shape="block" className="h-14" />
          ))}
        </div>
      }
    >
      <ul
        className={cn(
          'grid grid-cols-1 gap-2 sm:grid-cols-2',
          variant !== 'inspector' && 'xl:grid-cols-3',
        )}
        aria-label={config.title ?? 'Status'}
      >
        {rows.map((r, i) => {
          const detail = config.detail === undefined ? undefined : detailTemplated ? details?.[i] : getPath(r.row, config.detail);
          const href = typeof hrefs?.[i] === 'string' ? (hrefs[i] as string) : undefined;
          const inner = (
            <>
              <span className="truncate font-medium text-fg" title={r.label}>
                {r.label || '—'}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <StatusPill status={r.status.tone} size="sm" className="shrink-0">
                  {r.status.label}
                </StatusPill>
                {detail != null && detail !== '' && <span className="truncate text-xs text-fg-3">{String(detail)}</span>}
              </span>
            </>
          );
          const cls = 'flex h-full min-w-0 flex-col justify-center gap-1.5 rounded-md border border-line bg-panel px-3 py-2.5';
          return (
            <li key={`${r.label}-${i}`}>
              {href ? (
                <L href={href} className={cn(cls, 'transition-colors duration-(--af-motion-fast) hover:border-line-strong hover:bg-hover')}>
                  {inner}
                </L>
              ) : (
                <div className={cls}>{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    </WidgetPanel>
  );
}
