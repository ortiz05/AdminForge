import { tv } from './tv';

export const panel = tv({
  slots: {
    root: 'flex min-w-0 flex-col rounded-(--af-panel-radius) border border-line bg-panel',
    header: 'flex min-h-12 items-start justify-between gap-3 px-(--af-pad-panel) pt-(--af-pad-panel)',
    heading: 'flex min-w-0 flex-col gap-1.5',
    eyebrow: 'af-eyebrow',
    title: 'truncate text-md leading-snug font-semibold text-fg',
    description: 'text-sm text-fg-3',
    actions: 'flex shrink-0 items-center gap-1 -mt-1 -mr-1.5',
    body: 'min-w-0 flex-1 p-(--af-pad-panel)',
    footer: 'border-t border-line px-(--af-pad-panel) py-2.5',
  },
  variants: {
    /** Body content runs edge to edge (tables, lists). */
    flush: { true: { body: 'px-0 pb-0' } },
    /** No header: the body gets its full padding. */
    headless: { true: {}, false: { body: 'pt-3' } },
  },
  compoundVariants: [{ flush: true, headless: false, class: { body: 'pt-3' } }],
  defaultVariants: { flush: false, headless: false },
});
