import type { VariantProps } from 'tailwind-variants';
import { tv } from './tv';

export const button = tv({
  base: [
    'relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap select-none',
    'h-(--af-control-h) px-3 rounded-(--af-button-radius) border border-transparent font-semibold leading-none',
    'transition-colors duration-(--af-motion-fast) ease-(--af-motion-ease)',
    'disabled:opacity-55 aria-disabled:opacity-60',
  ],
  variants: {
    intent: {
      primary: 'bg-accent text-on-accent hover:not-aria-disabled:bg-accent-strong',
      secondary:
        'bg-raised text-fg border-line hover:not-aria-disabled:border-line-strong hover:not-aria-disabled:bg-hover',
      ghost: 'text-fg-2 hover:not-aria-disabled:bg-hover hover:not-aria-disabled:text-fg',
      danger: 'bg-crit text-fg-inverse hover:not-aria-disabled:opacity-90',
      armed: 'bg-armed text-on-armed hover:not-aria-disabled:opacity-90',
    },
    size: {
      sm: 'h-7 gap-1.5 px-2 text-xs',
      md: '',
      icon: 'w-(--af-control-h) px-0',
      'icon-sm': 'size-7 px-0',
    },
  },
  defaultVariants: { intent: 'secondary', size: 'md' },
});

export type ButtonVariants = VariantProps<typeof button>;
