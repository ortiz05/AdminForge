import { useMemo } from 'react';
import { CaretRightIcon, Skeleton, StatusPill, useNow } from '@adminforge/ui';
import { hasExpression, useRowTemplates } from '../../lib/expr';
import { formatValue } from '../../lib/format';
import { asRows, getPath } from '../../lib/path';
import { mapStatus, type StatusEntry, type StatusMap } from '../../lib/status';
import { WidgetPanel } from '../../lib/WidgetPanel';
import type { WidgetProps } from '../../types';
import type { ListConfig } from './schema';

import { toText as text } from '../../lib/text';

/** A field path, or a template evaluated per row. */
function useFieldOrTemplate(
  rows: Record<string, unknown>[],
  spec: string | undefined,
  scope: Record<string, unknown>,
) {
  const templated = spec !== undefined && hasExpression(spec);
  const evaluated = useRowTemplates(rows, spec, scope, templated);
  return (row: Record<string, unknown>, i: number): unknown =>
    spec === undefined ? undefined : templated ? evaluated?.[i] : getPath(row, spec);
}

/** A short list (incidents, expiring items) with status and a drill-down per row. */
export function ListWidget({ config, data, runtime }: WidgetProps<ListConfig>) {
  const all = useMemo(() => asRows(data.value), [data.value]);
  const limit = config.limit ?? 8;
  const rows = useMemo(() => all.slice(0, limit), [all, limit]);
  const now = useNow(30_000);
  const primary = useFieldOrTemplate(rows, config.primary, runtime.scope);
  const secondary = useFieldOrTemplate(rows, config.secondary, runtime.scope);
  const hrefs = useRowTemplates(rows, config.href, runtime.scope, config.href !== undefined);
  const L = runtime.Link;
  const name = config.title ?? 'List';

  return (
    <WidgetPanel
      config={config}
      data={data}
      runtime={runtime}
      name={name}
      flush
      isEmpty={all.length === 0}
      emptyDefault={{ title: 'Nothing needs attention', body: 'Items appear here as soon as there are any.' }}
      skeleton={
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className={i % 2 ? 'w-2/3' : 'w-5/6'} />
          ))}
        </div>
      }
      footer={
        all.length > limit && (
          <span className="text-xs whitespace-nowrap text-fg-3">
            Showing {limit} of {all.length}
          </span>
        )
      }
    >
      <ul className="flex flex-col pb-1.5" aria-label={name}>
        {rows.map((row, i) => {
          const st = config.status
            ? mapStatus(
                getPath(row, config.status.field),
                config.status.map as StatusMap | undefined,
                config.status.default as StatusEntry | undefined,
              )
            : null;
          const p = text(primary(row, i)) || '—';
          const sRaw = secondary(row, i);
          // Plain text from data (message center bodies arrive as HTML) is stripped, never rendered as markup.
          const s =
            sRaw == null || sRaw === ''
              ? ''
              : typeof sRaw === 'string' && !config.secondaryFormat
                ? text(sRaw)
                : formatValue(sRaw, config.secondaryFormat, now);
          const href = typeof hrefs?.[i] === 'string' ? (hrefs[i] as string) : undefined;
          const content = (
            <>
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate font-medium text-fg">{p}</span>
                {s && <span className="truncate text-xs text-fg-3">{s}</span>}
              </span>
              {st && (
                <StatusPill status={st.tone} size="sm">
                  {st.label}
                </StatusPill>
              )}
              {href && <CaretRightIcon size={12} aria-hidden className="shrink-0 text-fg-3" />}
            </>
          );
          const cls =
            'flex min-h-(--af-row-h) items-center gap-3 border-t border-line px-(--af-pad-panel) py-1.5 first:border-t-0';
          return (
            <li key={text(row.id ?? i)}>
              {href ? (
                <L
                  href={href}
                  className={`${cls} transition-colors duration-(--af-motion-fast) hover:bg-hover`}
                >
                  {content}
                </L>
              ) : (
                <div className={cls}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </WidgetPanel>
  );
}
