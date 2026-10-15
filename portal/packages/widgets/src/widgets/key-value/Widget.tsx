import { useMemo, type ReactNode } from 'react';
import { Badge, IdChip, StatusPill, cn, formatRelative, formatTimestamp, useNow } from '@adminforge/ui';
import { isExternal } from '../../lib/actions';
import { useTemplate } from '../../lib/expr';
import { formatValue } from '../../lib/format';
import { getPath, isRecord } from '../../lib/path';
import { mapStatus, type StatusMap } from '../../lib/status';
import { WidgetPanel } from '../../lib/WidgetPanel';
import { tagList } from '../table/Widget';
import type { WidgetProps, WidgetRuntime } from '../../types';
import type { KeyValueConfig, KeyValueFieldConfig } from './schema';

const Dash = () => <span className="text-fg-3">—</span>;

function LinkValue({
  field,
  value,
  row,
  runtime,
}: {
  field: KeyValueFieldConfig;
  value: unknown;
  row: unknown;
  runtime: WidgetRuntime;
}) {
  const scope = useMemo(() => ({ ...runtime.scope, row, value }), [runtime.scope, row, value]);
  const href = useTemplate<unknown>(field.href ?? (typeof value === 'string' ? value : undefined), scope);
  const target = typeof href.value === 'string' ? href.value : undefined;
  const label = value == null ? '' : String(value);
  if (!label) return <Dash />;
  if (!target) return <span className="break-words">{label}</span>;
  const cls = 'break-all text-accent underline-offset-2 hover:underline';
  if (isExternal(target))
    return (
      <a href={target} target="_blank" rel="noreferrer" className={cls}>
        {label}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  const L = runtime.Link;
  return (
    <L href={target} className={cls}>
      {label}
    </L>
  );
}

function FieldValue({
  field,
  row,
  runtime,
  now,
}: {
  field: KeyValueFieldConfig;
  row: unknown;
  runtime: WidgetRuntime;
  now: number;
}): ReactNode {
  const value = getPath(row, field.field);
  const blank = value === undefined || value === null || value === '';
  switch (field.kind) {
    case 'id':
      return blank ? <Dash /> : <IdChip value={String(value)} label={field.label} showLabel={false} />;
    case 'status': {
      const st = mapStatus(value, field.map as StatusMap | undefined);
      return st ? (
        <StatusPill status={st.tone} size="sm">
          {st.label}
        </StatusPill>
      ) : (
        <Dash />
      );
    }
    case 'boolean':
      return blank ? <Dash /> : <span>{value ? 'Yes' : 'No'}</span>;
    case 'datetime':
    case 'date':
    case 'relativeTime':
      return blank ? (
        <Dash />
      ) : (
        <time dateTime={String(value)} title={formatTimestamp(value as string)} className="tabular-nums">
          {field.kind === 'relativeTime'
            ? formatRelative(value as string, now)
            : formatValue(value, field.kind === 'date' ? 'date' : 'datetime')}
        </time>
      );
    case 'tags': {
      const list = tagList(value);
      return list.length ? (
        <span className="flex flex-wrap gap-1">
          {list.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </span>
      ) : (
        <Dash />
      );
    }
    case 'link':
      return <LinkValue field={field} value={value} row={row} runtime={runtime} />;
    case 'code':
      return blank ? (
        <Dash />
      ) : (
        <code className="font-mono text-xs break-all text-fg-2">{String(value)}</code>
      );
    case 'number':
    case 'bytes':
    case 'percent':
      return blank ? (
        <Dash />
      ) : (
        <span className="font-mono tabular-nums">{formatValue(value, field.format ?? field.kind)}</span>
      );
    default:
      return blank ? <Dash /> : <span className="break-words">{formatValue(value, field.format, now)}</span>;
  }
}

const COLS = { 1: '', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-2 xl:grid-cols-3' } as const;

/** One object's properties as label/value pairs (an entity's overview). */
export function KeyValueWidget({ config, data, runtime, variant }: WidgetProps<KeyValueConfig>) {
  const now = useNow(30_000);
  const row = isRecord(data.value) ? data.value : undefined;
  const cols = variant === 'inspector' ? 1 : (config.columns ?? 2);
  return (
    <WidgetPanel
      config={config}
      data={data}
      runtime={runtime}
      name={config.title ?? 'Details'}
      isEmpty={!row}
      emptyDefault={{
        title: 'No details to show',
        body: 'The object may have been deleted, or you may not have access to it.',
      }}
    >
      {/* Hairlines between rows; the first row's top line is clipped so the list starts clean. */}
      <div className="overflow-hidden">
        <dl className={cn('-mt-px grid grid-cols-1 gap-x-8', COLS[cols])}>
          {config.fields.map((f) => (
            <div
              key={f.field + f.label}
              className={cn(
                'flex min-w-0 border-t border-line py-2.5',
                variant === 'inspector' ? 'flex-row items-baseline gap-3' : 'flex-col gap-1',
              )}
            >
              <dt className={cn('text-xs font-medium text-fg-3', variant === 'inspector' && 'w-36 shrink-0')}>
                {f.label}
              </dt>
              <dd className="m-0 min-w-0 text-fg">
                <FieldValue field={f} row={row} runtime={runtime} now={now} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </WidgetPanel>
  );
}
