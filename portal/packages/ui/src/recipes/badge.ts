import { tv } from './tv';

export const badge = tv({
  base: 'inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-2xs font-semibold leading-none whitespace-nowrap',
  variants: {
    tone: {
      neutral: 'border-line bg-raised text-fg-2',
      accent: 'border-transparent bg-accent-subtle text-accent',
      ok: 'border-transparent bg-ok-subtle text-ok',
      warn: 'border-transparent bg-warn-subtle text-warn',
      crit: 'border-transparent bg-crit-subtle text-crit',
      outline: 'border-line-strong bg-transparent text-fg-2',
    },
    mono: { true: 'font-mono font-medium' },
  },
  defaultVariants: { tone: 'neutral' },
});
