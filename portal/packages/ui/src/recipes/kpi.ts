import { tv } from './tv';

export const kpi = tv({
  slots: {
    root: 'flex min-w-0 flex-col gap-2 p-(--af-pad-panel)',
    // Two lines before the ellipsis: a KPI label is the only words the number has (design review D-15).
    label: 'line-clamp-2 text-sm font-medium text-fg-2',
    // The number sits at the foot of the tile, so a two-line label beside one-line ones doesn't push it out of line.
    valueRow: 'mt-auto flex min-h-8 items-end justify-between gap-3',
    value: 'af-kpi-value flex min-w-0 items-baseline gap-1.5 text-fg',
    unit: 'font-body text-sm font-medium text-fg-3',
    foot: 'flex min-h-5 min-w-0 items-center gap-2 text-xs text-fg-3',
    // The status keeps its words and the hint gets what's left; only a status wider than the whole cell (a phone's two
    // columns) ends in an ellipsis instead of running out of the cell.
    status: 'inline-flex min-w-0 max-w-full shrink-0 items-center gap-1 font-medium',
    hint: 'min-w-0 truncate',
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
