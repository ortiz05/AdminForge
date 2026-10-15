import { tv } from './tv';

export const kpi = tv({
  slots: {
    root: 'flex min-w-0 flex-col gap-2 p-(--af-pad-panel)',
    label: 'truncate text-sm font-medium text-fg-2',
    valueRow: 'flex min-h-8 items-end justify-between gap-3',
    value: 'af-kpi-value flex min-w-0 items-baseline gap-1.5 text-fg',
    unit: 'font-body text-sm font-medium text-fg-3',
    foot: 'flex min-h-5 min-w-0 items-center gap-2 text-xs text-fg-3',
    status: 'inline-flex min-w-0 shrink-0 items-center gap-1 font-medium',
    delta: 'inline-flex shrink-0 items-center gap-1 font-medium',
  },
  variants: {
    variant: {
      tile: { root: 'rounded-(--af-panel-radius) border border-line bg-panel' },
      cell: { root: 'bg-panel' },
    },
    tone: {
      ok: { status: 'text-ok' },
      warn: { status: 'text-warn' },
      crit: { status: 'text-crit' },
      info: { status: 'text-info' },
      neutral: { status: 'text-fg-3' },
    },
    trend: { good: { delta: 'text-ok' }, bad: { delta: 'text-crit' }, flat: { delta: 'text-fg-2' } },
  },
  defaultVariants: { variant: 'tile' },
});

export const kpiStrip = tv({
  base: 'grid grid-cols-2 gap-px overflow-hidden rounded-(--af-panel-radius) border border-line bg-line md:grid-cols-3 xl:grid-cols-6',
});
