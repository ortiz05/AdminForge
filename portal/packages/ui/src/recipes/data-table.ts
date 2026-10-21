import { tv } from './tv';

export const dataTable = tv({
  slots: {
    root: 'flex min-w-0 flex-col',
    toolbar: 'px-(--af-pad-panel) pb-3',
    count: 'font-mono text-2xs whitespace-nowrap tabular-nums text-fg-3',
    bulk: 'mx-(--af-pad-panel) mb-3 flex flex-wrap items-center gap-3 rounded-md border border-accent bg-selected px-3 py-1.5',
    bulkCount: 'text-sm font-semibold text-fg',
    scroller: 'relative min-w-0 overflow-auto border-t border-line',
    inner: 'w-full min-w-fit',
    head: 'sticky top-0 z-(--af-z-sticky) border-b border-line bg-panel',
    headRow: 'grid grid-cols-(--af-dt-cols)',
    th: 'group/th flex h-(--af-table-row-h) min-w-0 items-center gap-0.5 px-2 text-xs font-semibold text-fg-3 first:pl-(--af-pad-panel) last:pr-(--af-pad-panel)',
    sortButton: [
      // A header may wrap to two lines (its text clamps); the button grows with it.
      '-mx-1 inline-flex min-h-7 min-w-0 items-center gap-1 rounded-sm px-1 text-left font-semibold',
      'hover:bg-hover hover:text-fg',
    ],
    filterButton: [
      'inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg',
      'opacity-0 group-hover/th:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100',
    ],
    body: 'relative',
    row: [
      // The row's own surface (panel, hover, selected), which an end-pinned cell takes over the columns scrolling under it.
      'group/row absolute inset-x-0 top-0 grid h-(--af-table-row-h) grid-cols-(--af-dt-cols) items-center border-b border-line bg-panel text-fg',
      'transition-colors duration-(--af-motion-fast) hover:bg-hover focus-visible:-outline-offset-2',
    ],
    td: 'flex h-full min-w-0 items-center px-2 first:pl-(--af-pad-panel) last:pr-(--af-pad-panel)',
  },
  variants: {
    selected: { true: { row: 'bg-selected hover:bg-selected' } },
    active: { true: { row: 'af-row-active bg-selected' } },
    clickable: { true: { row: 'cursor-pointer' } },
  },
});
