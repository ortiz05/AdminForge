import { tv } from './tv';

/**
 * `layout: list` (list pages, where the first rows should be above the fold): the actions sit on the title row and
 * the description is a one-line summary with "More", so the header is three short lines however wide the window.
 */
export const pageHeader = tv({
  slots: {
    root: 'flex flex-col gap-3 pb-6',
    crumbs: 'flex flex-wrap items-center gap-1 text-xs text-fg-3',
    crumb: 'rounded-sm hover:text-fg hover:underline underline-offset-2',
    current: 'text-fg-2',
    row: 'flex flex-wrap items-end justify-between gap-x-6 gap-y-3',
    heading: 'flex min-w-0 flex-col gap-2',
    eyebrow: 'af-eyebrow',
    titleRow: 'flex min-w-0 flex-wrap items-center gap-3',
    title: 'af-page-title min-w-0',
    description: 'max-w-3xl text-fg-2',
    meta: 'flex flex-wrap items-center gap-2',
    actions: 'flex min-w-0 max-w-full flex-wrap items-center gap-2',
    /** list layout: the title row with the actions at its end. */
    titleBar: 'flex flex-wrap items-center justify-between gap-x-6 gap-y-2',
    /** list layout: the one-line description and its More / Less. */
    summary: 'flex min-w-0 max-w-3xl items-baseline gap-2',
    summaryText: 'min-w-0 text-fg-2',
    more: 'shrink-0 rounded-sm text-sm font-semibold text-accent underline-offset-2 hover:underline',
  },
  variants: {
    layout: {
      default: {},
      list: { root: 'gap-2 pb-4' },
    },
  },
  defaultVariants: { layout: 'default' },
});
