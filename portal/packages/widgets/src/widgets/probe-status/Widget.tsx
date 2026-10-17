import { useId, useMemo, useState } from 'react';
import {
  CaretDownIcon,
  STATUS_SEVERITY,
  Skeleton,
  Sparkline,
  StatusPill,
  cn,
  formatDuration,
  formatNumber,
  formatRelative,
  formatTimestamp,
  useNow,
  type StatusTone,
} from '@adminforge/ui';
import { WidgetPanel } from '../../lib/WidgetPanel';
import type { ProbeHealth, ProbeSummary, WidgetData, WidgetProps } from '../../types';
import type { ProbeStatusConfig } from './schema';

const TONE: Record<ProbeHealth, StatusTone> = {
  ok: 'ok',
  warn: 'warn',
  crit: 'crit',
  error: 'crit',
  unknown: 'neutral',
};
const LABEL: Record<ProbeHealth, string> = {
  ok: 'Passing',
  warn: 'Degraded',
  crit: 'Failing',
  error: 'Error',
  unknown: 'No result',
};

function metricText(p: ProbeSummary): string {
  if (p.metric == null) return '—';
  if (p.unit === 'ms') return formatDuration(p.metric);
  const n = Number.isInteger(p.metric) ? formatNumber(p.metric) : p.metric.toFixed(1);
  return p.unit ? `${n} ${p.unit}` : n;
}

function ProbeRow({ probe, now }: { probe: ProbeSummary; now: number }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const points = (probe.history ?? []).map((h) => h.metric).filter((m): m is number => typeof m === 'number');
  return (
    <li className="border-t border-line first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-(--af-row-h) w-full items-center gap-3 px-(--af-pad-panel) py-1.5 text-left transition-colors duration-(--af-motion-fast) hover:bg-hover"
      >
        <StatusPill status={TONE[probe.status]} size="sm" className="w-24 shrink-0">
          {LABEL[probe.status]}
        </StatusPill>
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{probe.title}</span>
        {points.length > 1 && (
          <Sparkline
            data={points}
            label={`${probe.title}, last ${points.length} results`}
            width={64}
            height={20}
            className="hidden shrink-0 sm:block"
          />
        )}
        <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums text-fg-2">
          {metricText(probe)}
        </span>
        <span className="hidden w-16 shrink-0 text-right text-xs text-fg-3 md:inline">
          {probe.lastRunAt ? formatRelative(probe.lastRunAt, now) : 'never'}
        </span>
        <CaretDownIcon
          size={12}
          weight="bold"
          aria-hidden
          className={cn(
            'shrink-0 text-fg-3 transition-transform duration-(--af-motion-fast)',
            open && 'rotate-180',
          )}
        />
      </button>
      <div
        id={detailId}
        hidden={!open}
        className="border-t border-line bg-sunken px-(--af-pad-panel) py-3 text-sm"
      >
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-fg-3">Last run</dt>
            <dd className="m-0 text-fg-2 tabular-nums">
              {probe.lastRunAt ? formatTimestamp(probe.lastRunAt) : 'Not run yet'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-fg-3">Took</dt>
            <dd className="m-0 text-fg-2 tabular-nums">
              {probe.durationMs != null ? formatDuration(probe.durationMs) : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-fg-3">Probe</dt>
            <dd className="m-0 truncate font-mono text-xs text-fg-2">{probe.key}</dd>
          </div>
        </dl>
        <p className={cn('mt-2', probe.status === 'ok' ? 'text-fg-2' : 'text-fg')}>
          {probe.message || (probe.status === 'ok' ? 'Within thresholds.' : 'No message was recorded.')}
        </p>
      </div>
    </li>
  );
}

/** Latest result + recent trend per synthetic probe; a row expands to the last message (the error, when failing). */
export function ProbeStatusWidget({ config, runtime }: WidgetProps<ProbeStatusConfig>) {
  const state = runtime.useProbes(config.probes);
  const now = useNow(30_000);
  const probes = useMemo(() => {
    const picked = config.group ? state.probes.filter((p) => p.group === config.group) : state.probes;
    if (config.probes) {
      const order = new Map(config.probes.map((k, i) => [k, i]));
      return [...picked].sort((a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999));
    }
    return [...picked].sort(
      (a, b) =>
        STATUS_SEVERITY[TONE[b.status]] - STATUS_SEVERITY[TONE[a.status]] || a.title.localeCompare(b.title),
    );
  }, [state.probes, config.probes, config.group]);
  const data: WidgetData = {
    status: state.status,
    value: probes,
    error: state.error,
    provenance: state.provenance,
    retry: state.retry,
  };
  const failing = probes.filter((p) => p.status === 'crit' || p.status === 'error').length;
  const degraded = probes.filter((p) => p.status === 'warn').length;
  // "All passing" only when something has passed: probes that haven't run yet say so.
  const passing = probes.filter((p) => p.status === 'ok').length;
  return (
    <WidgetPanel
      config={config}
      data={data}
      runtime={runtime}
      name={config.title ?? 'Probes'}
      flush
      isEmpty={probes.length === 0}
      emptyDefault={{
        title: 'No probe results yet',
        body: 'Probes report here after their first scheduled run. Add one with `pnpm adminforge new probe`.',
      }}
      actions={
        state.status === 'ready' &&
        probes.length > 0 && (
          <StatusPill status={failing ? 'crit' : degraded ? 'warn' : passing ? 'ok' : 'neutral'} size="sm">
            {failing
              ? `${failing} failing`
              : degraded
                ? `${degraded} degraded`
                : passing === probes.length
                  ? 'All passing'
                  : passing
                    ? `${passing} of ${probes.length} passing`
                    : 'No results yet'}
          </StatusPill>
        )
      }
      skeleton={
        <div className="flex flex-col gap-3">
          {Array.from({ length: Math.min(config.probes?.length ?? 4, 6) }, (_, i) => (
            <Skeleton key={i} className={i % 2 ? 'w-4/5' : 'w-full'} />
          ))}
        </div>
      }
    >
      <ul className="flex flex-col pb-1" aria-label={config.title ?? 'Probes'}>
        {probes.map((p) => (
          <ProbeRow key={p.key} probe={p} now={now} />
        ))}
      </ul>
    </WidgetPanel>
  );
}
