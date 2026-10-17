import { tv } from './tv';

/** Label + control + hint/error, shared by every form control. */
export const field = tv({
  slots: {
    root: 'flex min-w-0 flex-col gap-1.5',
    label: 'text-sm font-medium text-fg',
    optional: 'ml-1 font-normal text-fg-3',
    hint: 'text-xs text-fg-3',
    // Icon on the first line, full size, however many lines the message wraps to.
    error: 'flex items-start gap-1 text-xs font-medium text-crit',
    errorIcon: 'mt-0.5 shrink-0',
  },
});

/** Text-like controls: input, textarea, select trigger, search. */
export const control = tv({
  base: [
    'w-full min-w-0 rounded-(--af-input-radius) border border-line bg-sunken text-fg',
    'transition-colors duration-(--af-motion-fast) hover:border-line-strong',
    'focus-visible:border-accent focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-accent',
    'aria-invalid:border-crit disabled:cursor-not-allowed disabled:opacity-55',
  ],
  variants: {
    kind: {
      input: 'h-(--af-control-h) px-2.5',
      textarea: 'min-h-20 resize-y px-2.5 py-2 leading-normal',
      select: 'inline-flex h-(--af-control-h) items-center justify-between gap-2 px-2.5 text-left',
    },
  },
  defaultVariants: { kind: 'input' },
});
