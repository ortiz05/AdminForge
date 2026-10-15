import { tv } from './tv';

export const statusPill = tv({
  slots: {
    root: 'inline-flex max-w-full items-center gap-1.5 rounded-(--af-pill-radius) font-medium whitespace-nowrap',
    icon: 'shrink-0',
    label: 'truncate',
  },
  variants: {
    status: {
      ok: { root: 'bg-ok-subtle text-ok' },
      warn: { root: 'bg-warn-subtle text-warn' },
      crit: { root: 'bg-crit-subtle text-crit' },
      info: { root: 'bg-accent-subtle text-info' },
      neutral: { root: 'bg-hover text-fg-2' },
    },
    size: {
      sm: { root: 'h-5 px-1.5 text-2xs' },
      md: { root: 'h-6 px-2 text-xs' },
    },
  },
  defaultVariants: { status: 'neutral', size: 'md' },
});
