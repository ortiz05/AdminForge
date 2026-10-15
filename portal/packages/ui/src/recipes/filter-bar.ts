import { tv } from './tv';

export const filterBar = tv({
  slots: {
    root: 'flex flex-col gap-2',
    row: 'flex flex-wrap items-center gap-2',
    search: 'w-64 max-w-full',
    facetCount:
      'ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-pill bg-accent px-1 text-2xs font-semibold text-on-accent',
    chips: 'flex flex-wrap items-center gap-1.5',
    chip: 'inline-flex h-6 max-w-72 items-center gap-1 rounded-pill border border-line bg-raised pr-0.5 pl-2.5 text-xs text-fg',
    chipKey: 'text-fg-3',
    chipRemove:
      'inline-flex size-5 items-center justify-center rounded-pill text-fg-3 hover:bg-hover hover:text-fg',
    spacer: 'ml-auto flex items-center gap-2',
  },
});
