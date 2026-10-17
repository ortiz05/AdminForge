import { tv } from './tv';

export const drawer = tv({
  slots: {
    content: [
      'af-sheet fixed inset-y-0 right-0 z-(--af-z-drawer) flex w-(--af-layout-inspector-w) max-w-full flex-col',
      'border-l border-line-strong bg-panel text-fg shadow-3 outline-none',
    ],
    header: 'flex items-start justify-between gap-3 border-b border-line px-5 py-4',
    eyebrow: 'af-eyebrow mb-1.5',
    // One line on wider screens; up to two on a phone, where the header is narrow.
    title:
      'af-display text-lg leading-snug font-semibold break-words text-fg max-sm:line-clamp-2 sm:truncate',
    description: 'mt-1 text-sm text-fg-2',
    body: 'min-h-0 flex-1 overflow-y-auto px-5 py-4',
    footer: 'flex items-center justify-end gap-2 border-t border-line px-5 py-3',
    actions: 'flex shrink-0 items-center gap-2',
    /** `cover`: a light scrim over what the sheet leaves visible of the page (never the navigation rail). */
    cover: [
      'af-scrim fixed inset-y-0 right-0 z-(--af-z-drawer) bg-sunken/40',
      'left-(--af-layout-nav-w) nav-collapsed:left-(--af-layout-nav-w-collapsed)',
    ],
  },
  variants: {
    /** `wide` is the inspector: inspector-wide-factor × the standard width, never over the navigation rail. */
    size: {
      standard: {},
      wide: {
        content:
          'w-(--af-layout-inspector-wide-w) nav-collapsed:w-(--af-layout-inspector-wide-w-nav-collapsed)',
      },
    },
    /** Sits below the session rail and above the run dock instead of covering them. */
    docked: {
      true: {
        content: 'top-(--af-layout-rail-h) bottom-(--af-layout-dock-h) shadow-2',
        cover: 'top-(--af-layout-rail-h) bottom-(--af-layout-dock-h)',
      },
    },
  },
});
