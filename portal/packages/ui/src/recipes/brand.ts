import { tv } from './tv';

export const brand = tv({
  slots: {
    root: 'inline-flex items-center gap-2 select-none',
    mark: 'shrink-0 text-accent',
    word: 'af-wordmark',
    admin: 'font-medium text-fg-2',
    forge: 'font-bold text-fg',
  },
  variants: {
    size: {
      sm: { root: 'gap-1.5', word: 'text-md' },
      md: { word: 'text-lg' },
      lg: { root: 'gap-2.5', word: 'text-2xl' },
    },
    /** Mark only (collapsed navigation, favicons). */
    compact: { true: { word: 'sr-only' } },
    /** In the session rail: follows the rail's ink when it glows ember (armed). */
    rail: {
      true: { mark: 'armed:text-on-armed', admin: 'armed:text-on-armed', forge: 'armed:text-on-armed' },
    },
  },
  defaultVariants: { size: 'md' },
});
