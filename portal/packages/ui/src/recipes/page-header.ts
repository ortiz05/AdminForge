import { tv } from './tv';

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
    actions: 'flex shrink-0 flex-wrap items-center gap-2',
  },
});
