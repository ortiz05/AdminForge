import { tv } from './tv';

export const toggle = tv({
  slots: {
    row: 'flex items-start gap-2.5',
    text: 'flex min-w-0 flex-col gap-0.5',
    label: 'cursor-pointer text-fg select-none',
    description: 'text-xs text-fg-3',
    checkbox: [
      'mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-line-strong bg-sunken text-on-accent',
      'transition-colors duration-(--af-motion-fast) hover:border-fg-3',
      'state-checked:border-accent state-checked:bg-accent state-indeterminate:border-accent state-indeterminate:bg-accent',
      'disabled:cursor-not-allowed disabled:opacity-55',
    ],
    switchRoot: [
      'relative inline-flex h-5 w-9 shrink-0 items-center rounded-pill border border-line-strong bg-hover',
      'transition-colors duration-(--af-motion-fast) state-checked:border-accent state-checked:bg-accent',
      'disabled:cursor-not-allowed disabled:opacity-55',
    ],
    switchThumb: [
      'block size-3.5 translate-x-0.5 rounded-pill bg-fg-2 shadow-1',
      'transition-transform duration-(--af-motion-fast) ease-(--af-motion-ease) state-checked:translate-x-4.5 state-checked:bg-on-accent',
    ],
  },
});

export const segmented = tv({
  slots: {
    root: 'inline-flex h-(--af-control-h) items-stretch gap-0.5 rounded-(--af-input-radius) border border-line bg-sunken p-0.5',
    item: [
      'inline-flex items-center justify-center gap-1.5 rounded-sm px-2.5 text-sm font-medium whitespace-nowrap text-fg-3',
      'transition-colors duration-(--af-motion-fast) hover:text-fg',
      'state-on:bg-raised state-on:text-fg state-on:shadow-1 state-on:ring-1 state-on:ring-line-strong',
      'disabled:cursor-not-allowed disabled:opacity-55',
    ],
  },
  variants: { size: { sm: { root: 'h-7', item: 'px-2 text-xs' }, md: {} } },
});
