import type { ReactNode } from 'react';
import { ArrowDownRightIcon, ArrowRightIcon, ArrowUpRightIcon } from '@phosphor-icons/react';
import { formatNumber } from '../lib/format';
import { STATUS_ICON, type StatusTone } from '../lib/status';

import { Skeleton } from './Skeleton';
import { Sparkline } from './Sparkline';
import { kpi, kpiStrip } from '../recipes/kpi';

export interface KpiDelta {
  /** Signed, pre-formatted: "+2.1%", "−14". */
  value: string;
  direction: 'up' | 'down' | 'flat';
  /** Whether this direction is good news (drives the colour, never alone: the arrow and sign carry it too). */
  good?: boolean;
  /** "vs last week". */
  period?: string;
}

export interface KpiProps {
  label: string;
  value: number | string | null | undefined;
  unit?: string;
  /** Optional state shown as icon + short label. */
  status?: { tone: StatusTone; label: string };
  delta?: KpiDelta;
  /** 12-ish points; drawn muted with an accent end-dot. */
  trend?: number[];
  /** Context under the value, e.g. "of 500 seats". */
  hint?: ReactNode;
  /**
   * Shown between the label and the number (a figure that couldn't be shown: its reference and Try again). The number
   * and its foot keep their place at the bottom, in line with the other cells of a strip.
   */
  extra?: ReactNode;
  loading?: boolean;
  /** `cell` sits inside a KpiStrip (no border of its own). */
  variant?: 'tile' | 'cell';
  className?: string;
}

const ARROW = { up: ArrowUpRightIcon, down: ArrowDownRightIcon, flat: ArrowRightIcon } as const;

/** A stat tile: label, one number in Archivo, then status, delta or context on one quiet line. */
export function Kpi({
  label,
  value,
  unit,
  status,
  delta,
  trend,
  hint,
  extra,
  loading,
  variant,
  className,
}: KpiProps) {
  const s = kpi({
    variant,
    tone: status?.tone,
    trend: delta ? (delta.direction === 'flat' ? 'flat' : delta.good ? 'good' : 'bad') : undefined,
  });
  const display = typeof value === 'number' ? formatNumber(value) : (value ?? '—');
  const StatusGlyph = status ? STATUS_ICON[status.tone] : null;
  const Arrow = delta ? ARROW[delta.direction] : null;
  return (
    <div className={s.root({ className })} role="group" aria-label={label} aria-busy={loading || undefined}>
      <span className={s.label()}>{label}</span>
      {extra}
      <div className={s.valueRow()}>
        <div aria-live="polite" className="min-w-0">
          {loading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <p className={s.value()}>
              {display}
              {unit && <span className={s.unit()}>{unit}</span>}
            </p>
          )}
        </div>
        {trend && trend.length > 1 && !loading && (
          <Sparkline data={trend} label={`${label} trend`} width={72} height={24} className="mb-1" />
        )}
      </div>
      <div className={s.foot()}>
        {loading ? (
          <Skeleton className="h-2.5 w-20" />
        ) : (
          <>
            {status && StatusGlyph && (
              <span className={s.status()}>
                <StatusGlyph size={13} weight="fill" aria-hidden className="shrink-0" />
                <span className="truncate">{status.label}</span>
              </span>
            )}
            {delta && Arrow && (
              <span className={s.delta()}>
                <Arrow size={13} weight="bold" aria-hidden />
                {delta.value}
              </span>
            )}
            {(delta?.period || hint) && <span className={s.hint()}>{delta?.period ?? hint}</span>}
          </>
        )}
      </div>
    </div>
  );
}

/** A row of KPIs in one bordered strip, divided by hairlines — denser than separate tiles. */
export function KpiStrip({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={label} className={kpiStrip({ className })}>
      {children}
    </section>
  );
}
