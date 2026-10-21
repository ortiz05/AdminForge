import { useMemo } from 'react';
import { Kpi, cn, safeUrl, type KpiDelta } from '@adminforge/ui';
import { useTemplate } from '../../lib/expr';
import { formatValue } from '../../lib/format';
import { getPath, isRecord } from '../../lib/path';
import { isTone, TONE_LABEL } from '../../lib/status';
import type { WidgetProps } from '../../types';
import type { KpiConfig } from './schema';

function numberOf(raw: unknown, field: string | undefined): unknown {
  if (isRecord(raw)) return getPath(raw, field ?? 'value');
  return raw;
}

/** Signed delta for the KPI foot: "+2.1%", "−14". */
function deltaOf(raw: unknown, config: KpiConfig): KpiDelta | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const direction = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  const text = formatValue(Math.abs(n), config.deltaFormat ?? config.format ?? 'number');
  const good = direction === 'flat' ? undefined : (config.deltaGood ?? 'up') === direction;
  return { value: `${n > 0 ? '+' : n < 0 ? '−' : ''}${text}`, direction, good, period: config.deltaPeriod };
}

/**
 * One number in Archivo with an optional status (icon + words), delta, trend and drill-down. Inside a KPI strip
 * the renderer draws the provenance line once for the strip.
 */
export function KpiWidget({ config, data, runtime, variant = 'tile' }: WidgetProps<KpiConfig>) {
  const value = data.status === 'ready' ? numberOf(data.value, config.field) : undefined;
  const scope = useMemo(() => ({ ...runtime.scope, value }), [runtime.scope, value]);
  const ready = data.status === 'ready';
  const status = useTemplate<unknown>(config.status, scope, ready && config.status !== undefined);
  const statusLabel = useTemplate<unknown>(
    config.statusLabel,
    scope,
    ready && config.statusLabel !== undefined,
  );
  const hint = useTemplate<unknown>(config.hint, scope, ready && config.hint !== undefined);
  const href = useTemplate<unknown>(config.href, scope, ready && config.href !== undefined);

  const hasValue = value !== undefined && value !== null && value !== '';
  const tone = ready && hasValue && isTone(status.value) ? status.value : undefined;
  const statusProp =
    data.status === 'error'
      ? { tone: 'neutral' as const, label: 'Unavailable' }
      : tone
        ? {
            tone,
            label:
              typeof statusLabel.value === 'string' && statusLabel.value
                ? statusLabel.value
                : TONE_LABEL[tone],
          }
        : undefined;
  const display =
    data.status === 'error'
      ? '—'
      : value === undefined || value === null
        ? ready
          ? '—'
          : undefined
        : typeof value === 'number' && (!config.format || config.format === 'number')
          ? value
          : formatValue(value, config.format);
  const delta = ready && config.delta ? deltaOf(runtime.resolve(config.delta), config) : undefined;
  const trendRaw = ready && config.trend ? runtime.resolve(config.trend) : undefined;
  const trend = Array.isArray(trendRaw)
    ? trendRaw.filter((n): n is number => typeof n === 'number')
    : undefined;

  const kpi = (
    <Kpi
      label={config.label}
      value={display}
      unit={config.unit}
      status={statusProp}
      delta={delta}
      trend={trend}
      hint={
        data.status === 'error'
          ? (data.error?.message ?? 'The data source returned an error.')
          : typeof hint.value === 'string' || typeof hint.value === 'number'
            ? String(hint.value)
            : undefined
      }
      loading={data.status === 'loading' || data.status === 'idle'}
      variant={variant === 'cell' ? 'cell' : 'tile'}
      className={cn(
        variant !== 'cell' && 'h-full',
        config.href && 'transition-colors duration-(--af-motion-fast) group-hover:bg-hover',
      )}
    />
  );
  // Templated from data: only a safe target makes the figure a link (never javascript:, //host or /\host).
  const target = typeof href.value === 'string' ? safeUrl(href.value)?.href : undefined;
  if (!target) return kpi;
  const L = runtime.Link;
  return (
    <L href={target} className="group block h-full -outline-offset-2">
      <span className="sr-only">Open {config.label}: </span>
      {kpi}
    </L>
  );
}
