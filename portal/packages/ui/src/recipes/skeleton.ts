import { tv } from './tv';

export const skeleton = tv({
  base: 'af-skeleton block rounded-sm',
  variants: {
    shape: { line: 'h-3.5 w-full', block: 'h-24 w-full rounded-md', circle: 'size-8 rounded-pill' },
  },
  defaultVariants: { shape: 'line' },
});
