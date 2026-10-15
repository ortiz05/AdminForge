import { tv } from './tv';

export const meter = tv({
  slots: {
    root: 'flex min-w-0 items-center gap-2.5',
    track: 'relative h-1.5 min-w-12 flex-1 overflow-hidden rounded-pill',
    fill: 'absolute inset-y-0 left-0 rounded-pill transition-all duration-(--af-motion-base)',
    value: 'w-10 shrink-0 text-right font-mono text-xs tabular-nums text-fg-2',
  },
  variants: {
    level: {
      normal: { track: 'bg-accent-subtle', fill: 'bg-accent' },
      warn: { track: 'bg-warn-subtle', fill: 'bg-warn' },
      crit: { track: 'bg-crit-subtle', fill: 'bg-crit' },
    },
  },
});
