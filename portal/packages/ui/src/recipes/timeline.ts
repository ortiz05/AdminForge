import { tv } from './tv';

export const timeline = tv({
  slots: {
    list: 'relative flex flex-col',
    item: 'relative flex gap-3 pb-5 last:pb-0',
    rail: 'absolute top-6 bottom-0 left-2.5 w-px bg-line',
    node: 'relative z-1 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-pill bg-panel',
    body: 'flex min-w-0 flex-1 flex-col gap-0.5',
    head: 'flex flex-wrap items-baseline justify-between gap-x-3',
    title: 'font-medium text-fg',
    time: 'font-mono text-2xs whitespace-nowrap text-fg-3',
    description: 'text-sm text-fg-2',
  },
  variants: {
    tone: {
      ok: { node: 'text-ok' },
      warn: { node: 'text-warn' },
      crit: { node: 'text-crit' },
      info: { node: 'text-info' },
      neutral: { node: 'text-fg-3' },
    },
  },
});
