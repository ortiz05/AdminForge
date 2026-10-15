import { tv } from './tv';

export const avatar = tv({
  base: 'inline-flex shrink-0 items-center justify-center rounded-pill border border-line-strong bg-raised font-semibold text-fg-2 select-none',
  variants: { size: { sm: 'size-6 text-2xs', md: 'size-8 text-xs' } },
  defaultVariants: { size: 'md' },
});
