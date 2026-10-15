import { tv } from './tv';

export const drawer = tv({
  slots: {
    content: [
      'af-sheet fixed inset-y-0 right-0 z-(--af-z-drawer) flex w-(--af-layout-inspector-w) max-w-full flex-col',
      'border-l border-line-strong bg-panel text-fg shadow-3 outline-none',
    ],
    header: 'flex items-start justify-between gap-3 border-b border-line px-5 py-4',
    eyebrow: 'af-eyebrow mb-1.5',
    title: 'af-display truncate text-lg leading-snug font-semibold text-fg',
    description: 'mt-1 text-sm text-fg-2',
    body: 'min-h-0 flex-1 overflow-y-auto px-5 py-4',
    footer: 'flex items-center justify-end gap-2 border-t border-line px-5 py-3',
  },
  variants: {
    /** Sits below the session rail and above the run dock instead of covering them. */
    docked: {
      true: { content: 'top-(--af-layout-rail-h) bottom-(--af-layout-dock-h) shadow-2' },
    },
  },
});
