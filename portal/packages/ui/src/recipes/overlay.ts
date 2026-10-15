import { tv } from './tv';

/** Floating surfaces (menus, popovers, selects): raised, bordered, the only place shadows appear. */
export const floating = tv({
  base: [
    'af-pop z-(--af-z-overlay) min-w-44 overflow-hidden rounded-lg border border-line-strong bg-raised p-1 text-fg shadow-2',
    'origin-(--radix-popper-transform-origin)',
  ],
});

/** Rows inside menus, selects, and the command palette. */
export const floatingItem = tv({
  base: [
    'relative flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none select-none',
    'text-fg-2 highlighted:bg-accent-subtle highlighted:text-fg aria-selected:bg-accent-subtle aria-selected:text-fg',
    'data-disabled:cursor-not-allowed data-disabled:opacity-50',
  ],
  variants: {
    tone: { default: '', danger: 'text-crit highlighted:text-crit' },
    inset: { true: 'pl-8' },
  },
  defaultVariants: { tone: 'default' },
});

export const floatingLabel = tv({ base: 'af-eyebrow px-2 pt-2 pb-1' });
export const floatingSeparator = tv({ base: '-mx-1 my-1 h-px bg-line' });

/** Dim layer behind modal dialogs; it also centres the dialog and lets tall content scroll. */
export const scrim = tv({
  base: 'af-scrim fixed inset-0 z-(--af-z-overlay) grid place-items-center overflow-y-auto bg-sunken/60 p-4 backdrop-blur-xs sm:p-8',
});

export const dialog = tv({
  slots: {
    content: [
      'af-pop relative flex max-h-full w-full flex-col',
      'rounded-xl border border-line-strong bg-panel text-fg shadow-3 outline-none',
    ],
    header: 'flex items-start justify-between gap-4 px-6 pt-5 pb-3',
    title: 'af-display text-lg leading-snug font-semibold text-fg',
    description: 'mt-1 text-sm text-fg-2',
    body: 'min-h-0 flex-1 overflow-y-auto px-6 py-2',
    footer: 'flex items-center justify-end gap-2 border-t border-line px-6 py-4',
  },
  variants: {
    size: { sm: { content: 'max-w-md' }, md: { content: 'max-w-lg' }, lg: { content: 'max-w-2xl' } },
  },
  defaultVariants: { size: 'md' },
});
