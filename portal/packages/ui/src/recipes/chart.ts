import { tv } from './tv';

export const chart = tv({
  slots: {
    root: 'flex min-w-0 flex-col gap-3',
    bar: 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2',
    legend: 'flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2',
    swatch: 'inline-block size-2.5 shrink-0 rounded-sm',
    plot: 'relative w-full min-w-0',
    table: 'w-full border-collapse text-sm',
    th: 'border-b border-line px-2 py-1.5 text-left text-xs font-semibold text-fg-3',
    td: 'border-b border-line px-2 py-1.5 text-fg-2',
    num: 'text-right font-mono tabular-nums',
  },
});
